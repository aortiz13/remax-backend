// ============================================================
// Chatwoot Application API client
//
// Self-hosted Chatwoot lives at https://wssp.remax-exclusive.cl.
// All requests authenticate with an Agent / Agent-Bot API token
// passed in the `api_access_token` header — same convention the n8n
// httpHeaderAuth credential uses.
//
// Required env vars:
//   CHATWOOT_API_URL        e.g. https://wssp.remax-exclusive.cl
//   CHATWOOT_API_TOKEN      api_access_token of the bot/agent
//   CHATWOOT_ACCOUNT_ID     e.g. 2  (numeric)
//   CHATWOOT_INBOX_ID       inbox numeric id of the WhatsApp channel
// ============================================================

import pool from '../lib/db.js';

const CHATWOOT_API_URL  = (process.env.CHATWOOT_API_URL || '').replace(/\/+$/, '');
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || '';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '';
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || '';

export function isChatwootConfigured() {
    return Boolean(
        CHATWOOT_API_URL &&
        CHATWOOT_API_TOKEN &&
        CHATWOOT_ACCOUNT_ID &&
        CHATWOOT_INBOX_ID,
    );
}

function requireConfig() {
    if (!isChatwootConfigured()) {
        throw new Error(
            'Chatwoot not configured. Set CHATWOOT_API_URL, CHATWOOT_API_TOKEN, ' +
            'CHATWOOT_ACCOUNT_ID, CHATWOOT_INBOX_ID in the backend env.',
        );
    }
}

async function cwFetch(path, { method = 'GET', body } = {}) {
    requireConfig();
    const url = `${CHATWOOT_API_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}${path}`;
    const resp = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            api_access_token: CHATWOOT_API_TOKEN,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!resp.ok) {
        const err = new Error(`Chatwoot ${method} ${path} → ${resp.status}: ${text.slice(0, 400)}`);
        err.status = resp.status;
        err.body = json;
        throw err;
    }
    return json;
}

// ─── Phone normalization ──────────────────────────────────────────
// Chatwoot expects E.164: +5691XXXXXXXX. Strip everything non-digit and
// best-effort prepend +56 (Chile) when missing.
export function normalizePhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (!digits.startsWith('56') && digits.length === 9) digits = '56' + digits;
    if (!digits.startsWith('56') && digits.length === 8) digits = '569' + digits;
    return `+${digits}`;
}

// ─── Contacts ─────────────────────────────────────────────────────
async function searchContactByPhone(phoneE164) {
    // Chatwoot exposes /contacts/search with a `q` param. The phone is the
    // most reliable key since recruitment candidates may share an email.
    const q = encodeURIComponent(phoneE164);
    const data = await cwFetch(`/contacts/search?q=${q}&include=contact_inboxes`);
    return Array.isArray(data?.payload) ? data.payload : [];
}

async function createContact({ name, email, phoneE164 }) {
    const body = {
        inbox_id: Number(CHATWOOT_INBOX_ID),
        name: name || 'Candidato RE/MAX',
        phone_number: phoneE164,
    };
    if (email) body.email = email;
    const data = await cwFetch('/contacts', { method: 'POST', body });
    return data?.payload?.contact || data?.contact || data;
}

export async function findOrCreateContact({ candidateId, name, email, phone }) {
    const phoneE164 = normalizePhone(phone);
    if (!phoneE164) throw new Error('Candidate has no phone for WhatsApp');

    // 1. Cached id on the candidate row?
    if (candidateId) {
        const { rows } = await pool.query(
            `SELECT chatwoot_contact_id FROM recruitment_candidates WHERE id = $1`,
            [candidateId],
        );
        const cachedId = rows[0]?.chatwoot_contact_id;
        if (cachedId) return { id: cachedId, cached: true };
    }

    // 2. Look it up by phone
    const found = await searchContactByPhone(phoneE164);
    let contact = found.find(c => (c.phone_number || '').replace(/\D/g, '') === phoneE164.replace(/\D/g, ''));

    // 3. Create if missing
    if (!contact) {
        contact = await createContact({ name, email, phoneE164 });
    }

    const contactId = contact?.id;
    if (!contactId) throw new Error(`Chatwoot did not return a contact id: ${JSON.stringify(contact).slice(0, 200)}`);

    // 4. Cache on the candidate
    if (candidateId) {
        await pool.query(
            `UPDATE recruitment_candidates SET chatwoot_contact_id = $1, updated_at = NOW() WHERE id = $2`,
            [contactId, candidateId],
        );
    }
    return { id: contactId, cached: false };
}

// ─── Conversations ────────────────────────────────────────────────
async function listConversationsForContact(contactId) {
    const data = await cwFetch(`/contacts/${contactId}/conversations`);
    // Chatwoot wraps results in different envelopes across versions; cover both.
    const list = data?.payload || data?.data?.payload || data?.data || [];
    return Array.isArray(list) ? list : [];
}

async function createConversation({ contactId, sourceId }) {
    const body = {
        source_id: sourceId,                 // contact_inbox source_id (phone for WA)
        inbox_id: Number(CHATWOOT_INBOX_ID),
        contact_id: Number(contactId),
        status: 'open',
    };
    const data = await cwFetch('/conversations', { method: 'POST', body });
    return data?.payload || data;
}

export async function findOrCreateConversation({ candidateId, contactId, phoneE164 }) {
    // 1. Cached conversation id on the candidate
    if (candidateId) {
        const { rows } = await pool.query(
            `SELECT chatwoot_conversation_id FROM recruitment_candidates WHERE id = $1`,
            [candidateId],
        );
        const cachedId = rows[0]?.chatwoot_conversation_id;
        if (cachedId) return { id: cachedId, cached: true };
    }

    // 2. Pick the most recent open conversation in our inbox
    const conversations = await listConversationsForContact(contactId);
    const ours = conversations
        .filter(c => Number(c.inbox_id) === Number(CHATWOOT_INBOX_ID))
        .sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0));
    let conv = ours.find(c => c.status === 'open') || ours[0];

    // 3. Otherwise create a brand new one
    if (!conv) {
        conv = await createConversation({ contactId, sourceId: phoneE164 });
    }

    const convId = conv?.id;
    if (!convId) throw new Error(`Chatwoot did not return a conversation id`);

    if (candidateId) {
        await pool.query(
            `UPDATE recruitment_candidates SET chatwoot_conversation_id = $1, updated_at = NOW() WHERE id = $2`,
            [convId, candidateId],
        );
    }
    return { id: convId, cached: false };
}

// ─── Send message ─────────────────────────────────────────────────
export async function sendMessage({ conversationId, content }) {
    const data = await cwFetch(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: {
            content,
            message_type: 'outgoing',
            private: false,
            content_type: 'text',
        },
    });
    return data;
}

// ─── End-to-end helper ────────────────────────────────────────────
// Used both by the BullMQ worker (recruitment automation) and by any
// future ad-hoc endpoint that wants to "just send a WhatsApp".
export async function sendWhatsappToCandidate({ candidate, content }) {
    const contact = await findOrCreateContact({
        candidateId: candidate.id,
        name: `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || 'Candidato',
        email: candidate.email || null,
        phone: candidate.whatsapp || candidate.phone || null,
    });
    const phoneE164 = normalizePhone(candidate.whatsapp || candidate.phone);
    const conversation = await findOrCreateConversation({
        candidateId: candidate.id,
        contactId: contact.id,
        phoneE164,
    });
    const message = await sendMessage({ conversationId: conversation.id, content });
    return {
        chatwoot_contact_id: contact.id,
        chatwoot_conversation_id: conversation.id,
        chatwoot_message_id: message?.id || message?.payload?.id || null,
    };
}
