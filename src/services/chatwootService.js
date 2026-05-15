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

// Label applied to the Chatwoot contact (slug — Chatwoot lowercases it
// internally). Defaults to 'postulante' for the recruitment use-case.
const CHATWOOT_LEAD_LABEL = (process.env.CHATWOOT_LEAD_LABEL || 'postulante').toLowerCase();

// Conversation custom attribute (and value) used to disable an AI agent
// before our message reaches the lead. The attribute_key must match the
// one configured in Chatwoot → Settings → Custom Attributes (it's a slug,
// not the display label). Default value is boolean `false`; override via
// env if your setup uses a different attribute name or a string toggle.
const CHATWOOT_AI_AGENT_ATTRIBUTE_KEY = process.env.CHATWOOT_AI_AGENT_ATTRIBUTE_KEY || 'agente_ia';
const CHATWOOT_AI_AGENT_OFF_VALUE = (() => {
    const raw = process.env.CHATWOOT_AI_AGENT_OFF_VALUE;
    if (raw === undefined || raw === '') return false;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    // Accept a literal string like "off" if the attribute is a select
    return raw;
})();

export function getChatwootPublicConfig() {
    return {
        baseUrl: CHATWOOT_API_URL,
        accountId: CHATWOOT_ACCOUNT_ID ? Number(CHATWOOT_ACCOUNT_ID) : null,
        inboxId: CHATWOOT_INBOX_ID ? Number(CHATWOOT_INBOX_ID) : null,
    };
}

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

// WhatsApp JID — the format Evolution API uses internally as the
// `source_id` of a conversation and the `identifier` of a contact
// (e.g. "59892206700@s.whatsapp.net"). When we create resources via
// the Chatwoot API we MUST use this format, otherwise Evolution
// doesn't recognise them as its own and never forwards outgoing
// messages to WhatsApp.
export function phoneToJid(phoneOrE164) {
    if (!phoneOrE164) return null;
    const digits = String(phoneOrE164).replace(/\D/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
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
        // Identifier in WhatsApp JID format so Evolution API can
        // correlate the contact with its WhatsApp instance.
        identifier: phoneToJid(phoneE164),
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
        // source_id must be the WhatsApp JID (e.g. 5691XXXXXXXX@s.whatsapp.net)
        // so Evolution API recognises the conversation as its own and
        // forwards outgoing messages to WhatsApp. Passing the bare phone
        // (+E.164) silently breaks delivery — Chatwoot accepts it and
        // shows ✓✓ in the UI but Evolution drops the message.
        source_id: sourceId,
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
        // Evolution expects the JID form (<digits>@s.whatsapp.net), NOT
        // the bare +E.164 — see the comment in createConversation().
        conv = await createConversation({ contactId, sourceId: phoneToJid(phoneE164) });
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

// ─── Labels & custom attributes ──────────────────────────────────
// `addContactLabels` and `addConversationLabels` POST a list of label
// slugs to the contact/conversation. Chatwoot's API replaces the full
// list, so we read what's there and union our label in to avoid
// stomping existing tags.

async function getContactLabels(contactId) {
    try {
        const data = await cwFetch(`/contacts/${contactId}/labels`);
        const labels = data?.payload || data?.data || data || [];
        return Array.isArray(labels) ? labels : [];
    } catch {
        return [];
    }
}

export async function addContactLabels(contactId, newLabels = []) {
    const existing = await getContactLabels(contactId);
    const merged = Array.from(new Set([...existing, ...newLabels.filter(Boolean)]));
    return cwFetch(`/contacts/${contactId}/labels`, {
        method: 'POST',
        body: { labels: merged },
    });
}

async function getConversationLabels(conversationId) {
    try {
        const data = await cwFetch(`/conversations/${conversationId}/labels`);
        const labels = data?.payload || data?.data || data || [];
        return Array.isArray(labels) ? labels : [];
    } catch {
        return [];
    }
}

export async function addConversationLabels(conversationId, newLabels = []) {
    const existing = await getConversationLabels(conversationId);
    const merged = Array.from(new Set([...existing, ...newLabels.filter(Boolean)]));
    return cwFetch(`/conversations/${conversationId}/labels`, {
        method: 'POST',
        body: { labels: merged },
    });
}

// Sets one or more custom_attributes on a conversation. Chatwoot stores
// them keyed by `attribute_key` (the slug from Settings → Custom Attributes,
// not the display label). The POST replaces the matching keys; other
// existing attributes are preserved server-side.
export async function setConversationCustomAttributes(conversationId, attrs) {
    return cwFetch(`/conversations/${conversationId}/custom_attributes`, {
        method: 'POST',
        body: { custom_attributes: attrs },
    });
}

// Convenience: apply our standard recruitment-flow pre-send state to a
// (contact, conversation) pair. Tags the contact as "postulante" and
// flips the AI-agent attribute off. Each call is wrapped in try/catch so
// a label failure never blocks the message from being delivered.
async function applyPreSendChatwootState({ contactId, conversationId }) {
    const result = { labelApplied: false, attributeApplied: false, errors: [] };

    try {
        if (CHATWOOT_LEAD_LABEL) {
            await addContactLabels(contactId, [CHATWOOT_LEAD_LABEL]);
            result.labelApplied = true;
        }
    } catch (err) {
        console.warn(`[Chatwoot] addContactLabels failed for contact ${contactId}: ${err.message}`);
        result.errors.push({ step: 'contact_label', message: err.message });
    }

    try {
        if (CHATWOOT_AI_AGENT_ATTRIBUTE_KEY) {
            await setConversationCustomAttributes(conversationId, {
                [CHATWOOT_AI_AGENT_ATTRIBUTE_KEY]: CHATWOOT_AI_AGENT_OFF_VALUE,
            });
            result.attributeApplied = true;
        }
    } catch (err) {
        console.warn(`[Chatwoot] setConversationCustomAttributes failed for conv ${conversationId}: ${err.message}`);
        result.errors.push({ step: 'conversation_attribute', message: err.message });
    }

    return result;
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

// ─── Send message with binary attachments ────────────────────────
// Chatwoot accepts attachments only via multipart/form-data. We
// download each attachment URL ourselves and forward the bytes as
// attachments[]. The api_access_token header stays the same; we MUST
// NOT set Content-Type — FormData adds the boundary.
//
// `attachments` shape: [{ url, filename, mimeType, size? }, ...]
// `downloader` is optional (defaults to fetch) — useful for tests.
//
// WhatsApp Business per-file limits (enforced by Meta, not us):
//   video / audio: 16 MB | image: 5 MB | document: 100 MB
export async function sendMessageWithAttachments({ conversationId, content, attachments = [], downloader = fetch }) {
    if (!attachments.length) {
        return sendMessage({ conversationId, content });
    }
    requireConfig();
    const url = `${CHATWOOT_API_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;

    const form = new FormData();
    form.append('content', content || '');
    form.append('message_type', 'outgoing');
    form.append('private', 'false');
    // No content_type field — Chatwoot infers from the file mimeType.

    for (const att of attachments) {
        if (!att?.url) continue;
        const r = await downloader(att.url);
        if (!r.ok) throw new Error(`Attachment download failed (${r.status}) for ${att.url}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const mime = att.mimeType || r.headers.get('content-type') || 'application/octet-stream';
        const blob = new Blob([buf], { type: mime });
        const name = att.filename || att.url.split('/').pop() || 'attachment';
        form.append('attachments[]', blob, name);
    }

    const resp = await fetch(url, {
        method: 'POST',
        headers: { api_access_token: CHATWOOT_API_TOKEN },
        body: form,
    });
    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!resp.ok) {
        const err = new Error(`Chatwoot POST messages (multipart) → ${resp.status}: ${text.slice(0, 400)}`);
        err.status = resp.status;
        err.body = json;
        throw err;
    }
    return json;
}

// ─── End-to-end helper ────────────────────────────────────────────
// Used both by the BullMQ worker (recruitment automation) and by any
// future ad-hoc endpoint that wants to "just send a WhatsApp".
//
// If `attachments` has items, the message is sent multipart and they
// are uploaded as Chatwoot attachments[] (which Chatwoot then forwards
// to WhatsApp as media).
export async function sendWhatsappToCandidate({ candidate, content, attachments = [], _selfHealAttempted = false }) {
    try {
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

        // Pre-send: tag contact as "postulante" and disable any AI agent on
        // the conversation. Failures here are logged but never block the send.
        const preSend = await applyPreSendChatwootState({
            contactId: contact.id,
            conversationId: conversation.id,
        });

        const message = attachments?.length
            ? await sendMessageWithAttachments({ conversationId: conversation.id, content, attachments })
            : await sendMessage({ conversationId: conversation.id, content });
        return {
            chatwoot_contact_id: contact.id,
            chatwoot_conversation_id: conversation.id,
            chatwoot_message_id: message?.id || message?.payload?.id || null,
            pre_send: preSend,
        };
    } catch (err) {
        // Self-heal: if the cached chatwoot_* ids point to a contact or
        // conversation that no longer exists in Chatwoot (e.g. someone
        // deleted them from the UI), we hit a 404 here. Clear the cache
        // and retry once with a fresh contact+conversation.
        if (err?.status === 404 && !_selfHealAttempted && candidate?.id) {
            console.warn(`[Chatwoot] 404 sending to candidate ${candidate.id}; clearing cached ids and retrying once`);
            await pool.query(
                `UPDATE recruitment_candidates
                    SET chatwoot_contact_id      = NULL,
                        chatwoot_conversation_id = NULL,
                        updated_at = NOW()
                  WHERE id = $1`,
                [candidate.id],
            );
            return sendWhatsappToCandidate({ candidate, content, attachments, _selfHealAttempted: true });
        }
        throw err;
    }
}
