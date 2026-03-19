import { Worker } from 'bullmq';
import { redisConnection } from './lib/redis.js';
import supabaseAdmin from './lib/supabaseAdmin.js';
import { startCronJobs } from './cron/scheduler.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// --- Helper: refresh Google access token ---
async function getAccessToken(refreshToken, accountTable, emailField, emailValue) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
    });
    const data = await response.json();
    if (data.error) throw new Error(`Token refresh failed: ${data.error}`);

    // Update stored token
    if (accountTable && emailField && emailValue) {
        await supabaseAdmin.from(accountTable)
            .update({ access_token: data.access_token, updated_at: new Date().toISOString() })
            .eq(emailField, emailValue);
    }

    return data.access_token;
}

// =============================================
// 📧 EMAIL WORKER — sends emails via Gmail API
// =============================================
new Worker('email', async (job) => {
    const { agentId, to, subject, body, bodyHtml, cc, bcc, inReplyTo, threadId, attachments } = job.data;
    // Support both 'body' and 'bodyHtml' field names (frontend sends 'bodyHtml')
    let htmlBody = bodyHtml || body;
    console.log(`📧 Sending email to ${to}...`);

    const { data: account } = await supabaseAdmin
        .from('gmail_accounts')
        .select('*')
        .eq('agent_id', agentId)
        .single();

    if (!account) throw new Error(`No Gmail account for agent ${agentId}`);

    // Fetch agent's email signature image
    const { data: agentProfile } = await supabaseAdmin
        .from('profiles')
        .select('signature_image_url')
        .eq('id', agentId)
        .single();

    if (agentProfile?.signature_image_url) {
        // Wrap body + signature in a single container so Gmail doesn't insert a separator line
        htmlBody = `<div>${htmlBody}<img src="${agentProfile.signature_image_url}" alt="Firma" style="width:100%; max-width:500px; height:auto; display:block; margin-top:24px;" /></div>`;
    }

    let accessToken = account.access_token;
    // Try to send, refresh token if needed
    let message = buildRawEmail({ from: account.email_address, to, cc, bcc, subject, htmlBody, inReplyTo, attachments });

    let response = await sendGmail(accessToken, account.email_address, message, threadId);

    if (response.status === 401) {
        accessToken = await getAccessToken(account.refresh_token, 'gmail_accounts', 'email_address', account.email_address);
        response = await sendGmail(accessToken, account.email_address, message, threadId);
    }

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gmail send failed: ${response.status} ${errText}`);
    }

    const result = await response.json();
    console.log(`✅ Email sent: ${result.id}`);
    return result;
}, { connection: redisConnection, concurrency: 5 });

// =============================================
// 📧 RECRUITMENT EMAIL WORKER — sends via emprendedores@ account
// =============================================
new Worker('email', async (job) => {
    if (job.name !== 'send-recruitment-email') return;

    const { accountEmail, to, subject, bodyHtml, candidateId } = job.data;
    console.log(`📧 [Recruitment] Sending email to ${to} via ${accountEmail}...`);

    const { data: account } = await supabaseAdmin
        .from('gmail_accounts')
        .select('*')
        .eq('email_address', accountEmail)
        .single();

    if (!account) throw new Error(`No recruitment Gmail account found: ${accountEmail}`);

    let accessToken = account.access_token;
    let message = buildRawEmail({ from: accountEmail, to, subject, htmlBody: bodyHtml });

    let response = await sendGmail(accessToken, accountEmail, message);

    if (response.status === 401) {
        accessToken = await getAccessToken(account.refresh_token, 'gmail_accounts', 'email_address', accountEmail);
        response = await sendGmail(accessToken, accountEmail, message);
    }

    if (!response.ok) {
        const errText = await response.text();
        // Update log as failed
        await supabaseAdmin.from('recruitment_email_logs')
            .update({ status: 'failed', metadata: { error: errText } })
            .eq('candidate_id', candidateId)
            .eq('subject', subject)
            .eq('status', 'queued')
            .order('sent_at', { ascending: false })
            .limit(1);
        throw new Error(`Gmail send failed: ${response.status} ${errText}`);
    }

    // Update log as sent
    await supabaseAdmin.from('recruitment_email_logs')
        .update({ status: 'sent' })
        .eq('candidate_id', candidateId)
        .eq('subject', subject)
        .eq('status', 'queued')
        .order('sent_at', { ascending: false })
        .limit(1);

    const result = await response.json();
    console.log(`✅ [Recruitment] Email sent: ${result.id}`);
    return result;
}, { connection: redisConnection, concurrency: 3 });

async function sendGmail(accessToken, email, raw, threadId) {
    const body = { raw };
    if (threadId) body.threadId = threadId;

    return fetch(`https://gmail.googleapis.com/gmail/v1/users/${email}/messages/send`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
}

function buildRawEmail({ from, to, cc, bcc, subject, htmlBody, inReplyTo, attachments }) {
    const boundary = `boundary_${Date.now()}`;
    // RFC 2047 encode subject if it contains non-ASCII characters
    const encodedSubject = /[^\x00-\x7F]/.test(subject)
        ? `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
        : subject;
    let headers = `From: ${from}\r\nTo: ${to}\r\nSubject: ${encodedSubject}\r\nMIME-Version: 1.0\r\n`;
    if (cc) headers += `Cc: ${cc}\r\n`;
    if (bcc) headers += `Bcc: ${bcc}\r\n`;
    if (inReplyTo) {
        headers += `In-Reply-To: ${inReplyTo}\r\nReferences: ${inReplyTo}\r\n`;
    }

    if (attachments?.length) {
        headers += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
        let body = `--${boundary}\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n${htmlBody}\r\n`;
        for (const att of attachments) {
            body += `--${boundary}\r\nContent-Type: ${att.mimeType}; name="${att.filename}"\r\nContent-Disposition: attachment; filename="${att.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${att.data}\r\n`;
        }
        body += `--${boundary}--`;
        return Buffer.from(headers + body).toString('base64url');
    }

    headers += `Content-Type: text/html; charset="UTF-8"\r\n\r\n${htmlBody}`;
    return Buffer.from(headers).toString('base64url');
}

// =============================================
// 📥 GMAIL WEBHOOK WORKER — processes incoming emails
// =============================================
new Worker('gmail-webhook', async (job) => {
    const { emailAddress, historyId } = job.data;
    console.log(`📥 Processing Gmail webhook for ${emailAddress}, historyId: ${historyId}`);

    const { data: account } = await supabaseAdmin
        .from('gmail_accounts')
        .select('*')
        .eq('email_address', emailAddress)
        .single();

    if (!account) return;

    const startHistoryId = account.last_history_id;
    if (!startHistoryId || BigInt(historyId) <= BigInt(startHistoryId)) return;

    let accessToken = account.access_token;

    // Fetch history
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/${emailAddress}/history`);
    url.searchParams.set('startHistoryId', startHistoryId);
    url.searchParams.set('historyTypes', 'messageAdded');

    let response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 401) {
        accessToken = await getAccessToken(account.refresh_token, 'gmail_accounts', 'email_address', emailAddress);
        response = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
    }

    if (response.status === 404) {
        await supabaseAdmin.from('gmail_accounts').update({ last_history_id: historyId }).eq('email_address', emailAddress);
        return;
    }

    if (!response.ok) return;

    const historyData = await response.json();
    const messagesToFetch = new Set();
    (historyData.history || []).forEach(record => {
        (record.messagesAdded || []).forEach(msg => messagesToFetch.add(msg.message.id));
    });

    console.log(`Found ${messagesToFetch.size} new messages for ${emailAddress}`);

    const MAX_MESSAGES = 5;
    const messageArray = Array.from(messagesToFetch).slice(0, MAX_MESSAGES);

    for (const messageId of messageArray) {
        try {
            await processAndSaveMessage(emailAddress, messageId, account, accessToken);
        } catch (err) {
            console.error(`Error processing message ${messageId}:`, err.message);
        }
    }

    await supabaseAdmin.from('gmail_accounts').update({ last_history_id: historyId }).eq('email_address', emailAddress);
}, { connection: redisConnection, concurrency: 3 });

async function processAndSaveMessage(emailAddress, messageId, account, accessToken) {
    const url = `https://gmail.googleapis.com/gmail/v1/users/${emailAddress}/messages/${messageId}?format=full`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return;

    const messageData = await response.json();
    const headers = messageData.payload.headers;
    const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const fromHeader = getHeader('From');
    const toHeader = getHeader('To');
    const subject = getHeader('Subject');
    const rfcMessageId = getHeader('Message-ID');

    const fromAddress = extractEmail(fromHeader);
    const toAddress = extractEmail(toHeader);

    let contactId = null;
    const targetEmail = fromAddress === emailAddress ? toAddress : fromAddress;
    if (targetEmail) {
        const { data: contacts } = await supabaseAdmin.from('contacts').select('id').ilike('email', targetEmail).limit(1);
        if (contacts?.length) contactId = contacts[0].id;
    }

    const threadId = messageData.threadId;
    const labels = messageData.labelIds || [];

    const { data: existingThread } = await supabaseAdmin.from('email_threads')
        .select('id, labels').eq('gmail_thread_id', threadId).single();

    const mergedLabels = existingThread
        ? Array.from(new Set([...(existingThread.labels || []), ...labels]))
        : labels;

    const threadData = {
        gmail_thread_id: threadId,
        agent_id: account.agent_id,
        subject: subject || '(Sin Asunto)',
        labels: mergedLabels,
        updated_at: new Date().toISOString(),
    };
    if (contactId) threadData.contact_id = contactId;

    await supabaseAdmin.from('email_threads').upsert(threadData, { onConflict: 'gmail_thread_id' });
    const { data: threadRecord } = await supabaseAdmin.from('email_threads')
        .select('id').eq('gmail_thread_id', threadId).single();
    if (!threadRecord) return;

    const body = extractBody(messageData.payload);

    await supabaseAdmin.from('email_messages').upsert({
        gmail_message_id: messageData.id,
        thread_id: threadRecord.id,
        agent_id: account.agent_id,
        from_address: fromAddress,
        to_address: toAddress,
        cc_address: extractEmail(getHeader('Cc')),
        subject,
        snippet: messageData.snippet,
        body_html: body.html,
        body_plain: body.plain,
        rfc_message_id: rfcMessageId,
        received_at: new Date(parseInt(messageData.internalDate)).toISOString(),
    }, { onConflict: 'gmail_message_id' });

    // Process attachments
    const { data: messageRecord } = await supabaseAdmin.from('email_messages')
        .select('id').eq('gmail_message_id', messageData.id).single();

    if (messageRecord) {
        const attachments = extractAttachmentIds(messageData.payload);
        for (const att of attachments) {
            const { data: existing } = await supabaseAdmin.from('email_attachments')
                .select('id').eq('message_id', messageRecord.id).eq('filename', att.filename).single();
            if (existing) continue;

            let base64Data = '';
            if (att.dataPayload) {
                base64Data = att.dataPayload.replace(/-/g, '+').replace(/_/g, '/');
            } else if (att.attachmentId) {
                const attUrl = `https://gmail.googleapis.com/gmail/v1/users/${emailAddress}/messages/${messageId}/attachments/${att.attachmentId}`;
                const attRes = await fetch(attUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
                if (attRes.ok) {
                    const attData = await attRes.json();
                    if (attData.data) base64Data = attData.data.replace(/-/g, '+').replace(/_/g, '/');
                }
            }

            if (base64Data) {
                try {
                    const buffer = Buffer.from(base64Data, 'base64');
                    const safeFilename = att.filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._\-]/g, '_');
                    const filePath = `${threadRecord.id}/${messageRecord.id}/${safeFilename}`;

                    const { error: uploadError } = await supabaseAdmin.storage.from('email_attachments').upload(filePath, buffer, {
                        contentType: att.mimeType,
                        upsert: true,
                    });

                    if (!uploadError) {
                        const { data: publicUrlData } = supabaseAdmin.storage.from('email_attachments').getPublicUrl(filePath);
                        await supabaseAdmin.from('email_attachments').insert({
                            message_id: messageRecord.id,
                            filename: att.filename,
                            file_size: att.size || buffer.length,
                            mime_type: att.mimeType,
                            storage_url: publicUrlData.publicUrl,
                        });
                    }
                } catch (e) {
                    console.error(`Attachment error ${att.filename}:`, e.message);
                }
            }
        }
    }
}

function extractEmail(headerValue) {
    if (!headerValue) return null;
    const match = headerValue.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
    return match ? match[1].toLowerCase().trim() : headerValue.toLowerCase().trim();
}

function extractBody(payload) {
    let html = null, plain = null;
    if (payload.mimeType === 'text/html' && payload.body?.data) {
        html = Buffer.from(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    } else if (payload.mimeType === 'text/plain' && payload.body?.data) {
        plain = Buffer.from(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    } else if (payload.parts) {
        for (const part of payload.parts) {
            const result = extractBody(part);
            if (result.html) html = result.html;
            if (result.plain) plain = result.plain;
        }
    }
    return { html, plain };
}

function extractAttachmentIds(payload) {
    let attachments = [];
    if (!payload.parts) return attachments;
    for (const part of payload.parts) {
        if (part.parts) attachments = attachments.concat(extractAttachmentIds(part));
        if (part.filename?.length > 0) {
            if (part.body?.attachmentId) {
                attachments.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, size: part.body.size });
            } else if (part.body?.data) {
                attachments.push({ filename: part.filename, mimeType: part.mimeType, dataPayload: part.body.data, size: part.body.size });
            }
        }
    }
    return attachments;
}

// =============================================
// 🔔 SLACK ALERT WORKER
// =============================================
new Worker('slack-alert', async (job) => {
    const { level, category, action, message, module, user_email, user_name, path, details, error_code } = job.data;
    const LEVEL_EMOJI = { error: '🔴', warning: '🟡' };
    const LEVEL_COLOR = { error: '#dc2626', warning: '#f59e0b' };

    const fields = [];
    if (category) fields.push({ title: 'Categoría', value: category, short: true });
    if (action) fields.push({ title: 'Acción', value: action, short: true });
    if (module) fields.push({ title: 'Módulo', value: module, short: true });
    if (error_code) fields.push({ title: 'Código', value: error_code, short: true });
    if (user_email) fields.push({ title: 'Usuario', value: `${user_name || ''} (${user_email})`.trim(), short: true });
    if (path) fields.push({ title: 'Ruta', value: path, short: true });

    let detailsText = '';
    if (details && typeof details === 'object') {
        detailsText = '```' + JSON.stringify(details, null, 2).substring(0, 500) + '```';
    }

    const timestamp = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' });

    if (!SLACK_WEBHOOK_URL) {
        console.error('🔔 ❌ SLACK_WEBHOOK_URL not configured — skipping Slack alert');
        return;
    }

    const slackRes = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            attachments: [{
                color: LEVEL_COLOR[level] || '#6b7280',
                pretext: `${LEVEL_EMOJI[level] || '⚪'} *${(level || 'info').toUpperCase()}* en RE/MAX Exclusive`,
                title: message || 'Sin mensaje',
                fields,
                ...(detailsText && { text: detailsText }),
                footer: `Auditoría Sistema • ${timestamp}`,
                mrkdwn_in: ['text', 'pretext'],
            }],
        }),
    });

    if (!slackRes.ok) {
        const errBody = await slackRes.text().catch(() => '');
        console.error(`🔔 ❌ Slack webhook failed: HTTP ${slackRes.status} — ${errBody}`);
        throw new Error(`Slack webhook returned ${slackRes.status}: ${errBody}`);
    }

    console.log(`🔔 ✅ Slack alert sent: ${level} - ${message}`);
}, { connection: redisConnection, concurrency: 2 });

// =============================================
// 📋 NOTIFICATION WORKER
// =============================================
new Worker('notification', async (job) => {
    console.log(`📋 Processing notification:`, job.data);
    // This worker processes the send-notification Edge Function logic
    // TODO: Implement web push notification delivery
}, { connection: redisConnection, concurrency: 5 });

// =============================================
// 🎤 TTS WORKER
// =============================================
new Worker('tts', async (job) => {
    console.log(`🎤 Processing TTS job:`, job.data);
    // TODO: Implement Google TTS API call  
}, { connection: redisConnection, concurrency: 2 });

// =============================================
// 📦 IMPORT WORKER — RE/MAX listings sync
// Handles:
//   - 'sync-remax-listings': cron job that syncs ALL agents
//   - 'import-remax-listings': single agent (legacy, unused but kept)
// =============================================
// Helper: convert Unix timestamps to ISO date strings (same as frontend safeDate)
function safeDate(val) {
    if (!val) return null;
    if (typeof val === 'number' || (typeof val === 'string' && /^\d+$/.test(val))) {
        const num = Number(val);
        const ms = num < 1e11 ? num * 1000 : num;
        try { return new Date(ms).toISOString(); } catch { return null; }
    }
    return val; // already a string date
}

new Worker('import', async (job) => {
    const { scanAgentListings } = await import('./services/remaxListingsService.js');

    if (job.name === 'sync-remax-listings') {
        console.log('📦 Starting RE/MAX listings sync for all agents...');

        // Fetch all agents with remax_agent_id (filter out empty strings)
        const { data: agents, error: agentErr } = await supabaseAdmin
            .from('profiles')
            .select('id, first_name, last_name, remax_agent_id')
            .not('remax_agent_id', 'is', null)
            .neq('remax_agent_id', '');

        if (agentErr || !agents?.length) {
            console.log('📦 No agents with remax_agent_id found, skipping sync');
            return;
        }

        console.log(`📦 Syncing ${agents.length} agents...`);
        let totalSynced = 0;
        let totalErrors = 0;

        for (const agent of agents) {
            try {
                const { properties } = await scanAgentListings(agent.remax_agent_id);
                if (!properties || properties.length === 0) {
                    console.log(`  → ${agent.first_name} ${agent.last_name}: 0 properties`);
                    continue;
                }

                // 1. Fetch ALL existing properties for this agent
                const { data: existingProps } = await supabaseAdmin
                    .from('properties')
                    .select('id, rol_number, listing_reference, source, address, commune, property_type, operation_type, price, currency, bedrooms, bathrooms, m2_total, m2_built, notes, listing_link, latitude, longitude, image_url, published_at, last_updated_at, expires_at, sold_at, sold_price, is_exclusive, year_built, maintenance_fee, virtual_tour_url, video_url, parking_spaces, floor_number, status, owner_id, documentation_link, unit_number')
                    .eq('agent_id', agent.id);

                const existingByRef = {};
                const existingRemaxIds = [];
                for (const ep of (existingProps || [])) {
                    if (ep.rol_number?.trim()) {
                        existingByRef[ep.rol_number.trim()] = ep;
                    }
                    if (ep.listing_reference?.trim()) {
                        existingByRef[ep.listing_reference.trim()] = ep;
                    }
                    if (ep.source === 'remax' && !ep.rol_number) {
                        existingRemaxIds.push(ep.id);
                    }
                }

                // 2. Separate: matched (ROL/ref exists) vs new (no match)
                const toMerge = [];
                const toInsert = [];

                for (const p of properties) {
                    const ref = p.listing_reference?.trim();
                    if (ref && existingByRef[ref]) {
                        toMerge.push({ existing: existingByRef[ref], incoming: p });
                    } else {
                        toInsert.push(p);
                    }
                }

                // 3. MERGE matched properties (only fill empty fields, never overwrite agent data)
                for (const { existing, incoming } of toMerge) {
                    const update = {};
                    const isEmpty = (val) => val === null || val === undefined || val === '' || val === 0;

                    const fillIfEmpty = {
                        address: incoming.address,
                        commune: incoming.commune || incoming.address?.split(',')[1]?.trim() || '',
                        property_type: incoming.property_type,
                        operation_type: incoming.operation_type || 'venta',
                        price: incoming.price || 0,
                        currency: incoming.currency || 'CLP',
                        bedrooms: incoming.bedrooms,
                        bathrooms: incoming.bathrooms,
                        m2_total: incoming.m2_total,
                        m2_built: incoming.m2_built,
                        listing_link: incoming.source_url,
                        latitude: incoming.latitude,
                        longitude: incoming.longitude,
                        image_url: incoming.image_url,
                        published_at: safeDate(incoming.published_at),
                        last_updated_at: safeDate(incoming.last_updated_at),
                        expires_at: safeDate(incoming.expires_at),
                        sold_at: safeDate(incoming.sold_at),
                        sold_price: incoming.sold_price,
                        is_exclusive: incoming.is_exclusive || false,
                        year_built: incoming.year_built,
                        maintenance_fee: incoming.maintenance_fee,
                        virtual_tour_url: incoming.virtual_tour_url,
                        video_url: incoming.video_url,
                        parking_spaces: incoming.parking_spaces ? String(incoming.parking_spaces) : null,
                        floor_number: incoming.floor_number ? String(incoming.floor_number) : null,
                    };

                    for (const [key, newVal] of Object.entries(fillIfEmpty)) {
                        if (isEmpty(existing[key]) && !isEmpty(newVal)) {
                            update[key] = newVal;
                        }
                    }

                    // Always update RE/MAX identifiers
                    update.listing_reference = incoming.listing_reference;
                    update.remax_listing_id = incoming.listing_id;
                    update.listing_status_uid = incoming.listing_status_uid;
                    update.transaction_type_uid = incoming.transaction_type_uid;
                    update.source = 'remax';
                    update.updated_at = new Date().toISOString();

                    if (!existing.rol_number && incoming.listing_reference) {
                        update.rol_number = incoming.listing_reference;
                    }

                    await supabaseAdmin.from('properties').update(update).eq('id', existing.id);

                    // Sync photos
                    if (incoming.image_urls?.length > 0) {
                        await supabaseAdmin.from('property_photos').delete()
                            .eq('property_id', existing.id).eq('source', 'remax');

                        const photoRecords = incoming.image_urls.map(img => ({
                            property_id: existing.id,
                            agent_id: agent.id,
                            url: img.url,
                            caption: img.caption || `Foto ${img.position + 1}`,
                            position: img.position,
                            source: 'remax',
                        }));
                        await supabaseAdmin.from('property_photos').insert(photoRecords);
                    }

                    // Sync history
                    if (incoming.history?.length > 0) {
                        for (const h of incoming.history) {
                            const { data: existingH } = await supabaseAdmin
                                .from('property_listing_history')
                                .select('id')
                                .eq('property_id', existing.id)
                                .eq('remax_listing_id', String(h.listing_id))
                                .maybeSingle();

                            if (!existingH) {
                                await supabaseAdmin.from('property_listing_history').insert({
                                    property_id: existing.id,
                                    listing_reference: incoming.listing_reference,
                                    remax_listing_id: h.listing_id,
                                    published_at: safeDate(h.published_at),
                                    expired_at: safeDate(h.expires_at),
                                    price: h.price,
                                    currency: h.currency,
                                    listing_status_uid: h.listing_status_uid,
                                    status_label: h.status_label,
                                    agent_id: agent.id,
                                });
                            }
                        }
                    }
                }

                // 4. Delete orphaned pure-remax properties (not matched)
                const matchedIds = new Set(toMerge.map(m => m.existing.id));
                const idsToDelete = existingRemaxIds.filter(id => !matchedIds.has(id));
                if (idsToDelete.length > 0) {
                    await supabaseAdmin.from('mandates').update({ property_id: null }).in('property_id', idsToDelete);
                    await supabaseAdmin.from('crm_tasks').delete().in('property_id', idsToDelete);
                    await supabaseAdmin.from('crm_actions').delete().in('property_id', idsToDelete);
                    await supabaseAdmin.from('property_listing_history').delete().in('property_id', idsToDelete);
                    await supabaseAdmin.from('property_import_log').delete().in('property_id', idsToDelete);
                    await supabaseAdmin.from('property_photos').delete().in('property_id', idsToDelete);
                    await supabaseAdmin.from('properties').delete().in('id', idsToDelete);
                }

                // 5. Insert NEW properties
                if (toInsert.length > 0) {
                    // Deduplicate by listing_link to avoid unique constraint violation
                    const seenLinks = new Set();
                    const deduped = toInsert.filter(p => {
                        const link = p.source_url || '';
                        if (!link || seenLinks.has(link)) return false;
                        seenLinks.add(link);
                        return true;
                    });

                    const dbProperties = deduped.map(p => ({
                        address: p.address,
                        commune: p.commune || p.address?.split(',')[1]?.trim() || '',
                        property_type: p.property_type,
                        operation_type: p.operation_type || 'venta',
                        price: p.price || 0,
                        currency: p.currency || 'CLP',
                        bedrooms: p.bedrooms,
                        bathrooms: p.bathrooms,
                        m2_total: p.m2_total,
                        m2_built: p.m2_built,
                        notes: p.description,
                        listing_link: p.source_url,
                        latitude: p.latitude,
                        longitude: p.longitude,
                        status: p.status || ['Publicada'],
                        source: 'remax',
                        agent_id: agent.id,
                        image_url: p.image_url,
                        published_at: safeDate(p.published_at),
                        last_updated_at: safeDate(p.last_updated_at),
                        expires_at: safeDate(p.expires_at),
                        sold_at: safeDate(p.sold_at),
                        sold_price: p.sold_price,
                        listing_status_uid: p.listing_status_uid,
                        listing_reference: p.listing_reference,
                        rol_number: p.listing_reference,
                        remax_listing_id: p.listing_id,
                        transaction_type_uid: p.transaction_type_uid,
                        is_exclusive: p.is_exclusive || false,
                        year_built: p.year_built,
                        maintenance_fee: p.maintenance_fee,
                        virtual_tour_url: p.virtual_tour_url,
                        video_url: p.video_url,
                        parking_spaces: String(p.parking_spaces || ''),
                        floor_number: String(p.floor_number || ''),
                    }));

                    const { data: insertedProps, error: insertErr } = await supabaseAdmin
                        .from('properties')
                        .upsert(dbProperties, { onConflict: 'listing_link, agent_id' })
                        .select('id, listing_reference, agent_id');

                    if (insertErr) {
                        console.error(`  ❌ Insert error for ${agent.first_name}: ${insertErr.message}`);
                    } else if (insertedProps) {
                        // Insert history & photos for new properties
                        const historyRecords = [];
                        const allPhotoRecords = [];

                        for (const inserted of insertedProps) {
                            const original = toInsert.find(p => p.listing_reference === inserted.listing_reference);
                            if (original?.history?.length > 0) {
                                for (const h of original.history) {
                                    historyRecords.push({
                                        property_id: inserted.id,
                                        listing_reference: inserted.listing_reference,
                                        remax_listing_id: h.listing_id,
                                        published_at: safeDate(h.published_at),
                                        expired_at: safeDate(h.expires_at),
                                        price: h.price,
                                        currency: h.currency,
                                        listing_status_uid: h.listing_status_uid,
                                        status_label: h.status_label,
                                        agent_id: inserted.agent_id,
                                    });
                                }
                            }

                            if (original?.image_urls?.length > 0) {
                                for (const img of original.image_urls) {
                                    allPhotoRecords.push({
                                        property_id: inserted.id,
                                        agent_id: inserted.agent_id,
                                        url: img.url,
                                        caption: img.caption || `Foto ${img.position + 1}`,
                                        position: img.position,
                                        source: 'remax',
                                    });
                                }
                            }
                        }

                        if (historyRecords.length > 0) {
                            const { error: histErr } = await supabaseAdmin
                                .from('property_listing_history').insert(historyRecords);
                            if (histErr) console.error(`  ⚠️ History insert error: ${histErr.message}`);
                        }

                        if (allPhotoRecords.length > 0) {
                            const { error: photoErr } = await supabaseAdmin
                                .from('property_photos').insert(allPhotoRecords);
                            if (photoErr) console.error(`  ⚠️ Photo insert error: ${photoErr.message}`);
                        }
                    }
                }

                // 6. Update KPI
                const INACTIVE_STATUSES = ['Vendida', 'Retirada', 'Pausada', 'Arrendada'];
                const todayStr = new Date().toISOString().split('T')[0];
                const allAgentProps = [...toInsert, ...toMerge.map(m => m.incoming)];
                const activeCount = allAgentProps.filter(p =>
                    !(p.status || []).some(s => INACTIVE_STATUSES.includes(s))
                ).length;

                if (activeCount > 0) {
                    const { data: existingKpi } = await supabaseAdmin
                        .from('kpi_records')
                        .select('id')
                        .eq('agent_id', agent.id)
                        .eq('period_type', 'daily')
                        .eq('date', todayStr)
                        .maybeSingle();

                    if (existingKpi) {
                        await supabaseAdmin.from('kpi_records')
                            .update({ active_portfolio: activeCount })
                            .eq('id', existingKpi.id);
                    } else {
                        await supabaseAdmin.from('kpi_records').insert({
                            agent_id: agent.id, period_type: 'daily', date: todayStr,
                            active_portfolio: activeCount,
                            new_listings: 0, conversations_started: 0, relational_coffees: 0,
                            sales_interviews: 0, buying_interviews: 0, commercial_evaluations: 0,
                            price_reductions: 0, portfolio_visits: 0, buyer_visits: 0,
                            offers_in_negotiation: 0, signed_promises: 0,
                            billing_primary: 0, referrals_count: 0, billing_secondary: 0,
                        });
                    }
                }

                const syncedCount = toMerge.length + toInsert.length;
                totalSynced += syncedCount;
                console.log(`  ✅ ${agent.first_name} ${agent.last_name}: ${syncedCount} properties (${toMerge.length} merged, ${toInsert.length} new, ${idsToDelete.length} removed)`);

            } catch (agentError) {
                totalErrors++;
                console.error(`  ❌ Error syncing agent ${agent.first_name} ${agent.last_name}:`, agentError.message);
                const { logErrorToSlack } = await import('./middleware/slackErrorLogger.js');
                logErrorToSlack('error', {
                    category: 'cron',
                    action: 'sync_remax_listings',
                    message: `Error scanning agent ${agent.first_name} ${agent.last_name} (${agent.remax_agent_id}): ${agentError.message}`,
                    module: 'import-worker',
                });
            }
        }

        console.log(`📦 RE/MAX sync complete: ${totalSynced} properties synced, ${totalErrors} errors`);

    } else {
        // Legacy single-agent job (unused but kept for compatibility)
        const { agentId, triggeredBy } = job.data;
        console.log(`📦 Import worker job received for agent ${agentId} (triggered by ${triggeredBy})`);
    }
}, { connection: redisConnection, concurrency: 1 });

// =============================================
// 🎯 RECRUITMENT AUTOMATION WORKER
// =============================================
new Worker('recruitment-automation', async (job) => {
    const { emailQueue: eQueue } = await import('./queues/index.js');

    if (job.name === 'meeting-day-confirmation') {
        const { candidateId, candidateEmail, candidateName, meetingDate } = job.data;
        console.log(`🎯 Meeting-day confirmation for ${candidateName} (${candidateEmail})`);

        // Find the recruitment account
        const { data: account } = await supabaseAdmin
            .from('gmail_accounts')
            .select('email_address')
            .eq('purpose', 'recruitment')
            .single();

        if (!account) { console.log('⚠️ No recruitment Gmail account connected, skipping'); return; }

        // Find a Confirmación template or use default text
        const { data: templates } = await supabaseAdmin
            .from('recruitment_email_templates')
            .select('*')
            .ilike('category', '%confirmación%')
            .limit(1);

        const meetingFormatted = meetingDate ? new Date(meetingDate).toLocaleString('es-CL', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Santiago' }) : 'hoy';

        let subject = `Confirmación de reunión - ${meetingFormatted}`;
        let bodyHtml = `<p>Hola ${candidateName},</p><p>Te escribimos para confirmar tu reunión programada para hoy, <strong>${meetingFormatted}</strong>.</p><p>¿Podrías confirmar tu asistencia respondiendo este correo?</p><p>Saludos,<br>Equipo RE/MAX Exclusive</p>`;

        if (templates?.[0]) {
            // Simple variable replacement
            subject = (templates[0].subject || subject)
                .replace(/\{\{nombre\}\}/g, candidateName)
                .replace(/\{\{fecha_reunion\}\}/g, meetingFormatted);
            bodyHtml = (templates[0].body_html || bodyHtml)
                .replace(/\{\{nombre\}\}/g, candidateName)
                .replace(/\{\{fecha_reunion\}\}/g, meetingFormatted);
        }

        // Queue the email
        await eQueue.add('send-recruitment-email', {
            accountEmail: account.email_address,
            to: candidateEmail,
            subject,
            bodyHtml,
            candidateId,
        }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

        // Log it
        await supabaseAdmin.from('recruitment_email_logs').insert({
            candidate_id: candidateId,
            email_type: 'Confirmación',
            subject,
            body_html: bodyHtml,
            to_email: candidateEmail,
            status: 'queued',
            sent_at: new Date().toISOString(),
            metadata: { trigger: 'cron-meeting-day' },
        });

        console.log(`✅ Meeting-day confirmation queued for ${candidateName}`);

    } else if (job.name === 'no-response-followup') {
        const { candidateId, candidateEmail, candidateName, stage } = job.data;
        console.log(`🎯 No-response follow-up for ${candidateName} (stage: ${stage})`);

        const { data: account } = await supabaseAdmin
            .from('gmail_accounts')
            .select('email_address')
            .eq('purpose', 'recruitment')
            .single();

        if (!account) return;

        // Find a Seguimiento template
        const { data: templates } = await supabaseAdmin
            .from('recruitment_email_templates')
            .select('*')
            .ilike('category', '%seguimiento%')
            .limit(1);

        let subject = `Seguimiento: RE/MAX Exclusive - Oportunidad de emprendimiento`;
        let bodyHtml = `<p>Hola ${candidateName},</p><p>Te escribimos nuevamente porque nos interesa mucho tu perfil. ¿Pudiste revisar la información que te enviamos anteriormente?</p><p>Nos encantaría poder agendar una reunión contigo para conversar más al respecto.</p><p>Saludos,<br>Equipo RE/MAX Exclusive</p>`;

        if (templates?.[0]) {
            subject = (templates[0].subject || subject).replace(/\{\{nombre\}\}/g, candidateName);
            bodyHtml = (templates[0].body_html || bodyHtml).replace(/\{\{nombre\}\}/g, candidateName);
        }

        await eQueue.add('send-recruitment-email', {
            accountEmail: account.email_address,
            to: candidateEmail,
            subject,
            bodyHtml,
            candidateId,
        }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

        await supabaseAdmin.from('recruitment_email_logs').insert({
            candidate_id: candidateId,
            email_type: 'Seguimiento',
            subject,
            body_html: bodyHtml,
            to_email: candidateEmail,
            status: 'queued',
            sent_at: new Date().toISOString(),
            metadata: { trigger: 'cron-followup' },
        });

        console.log(`✅ Follow-up queued for ${candidateName}`);

    } else if (job.name === 'stagnant-candidates-alert') {
        const { candidates, count } = job.data;
        console.log(`🎯 Stagnant candidates alert: ${count} candidates`);

        // Send Slack notification
        const { logErrorToSlack } = await import('./middleware/slackErrorLogger.js');
        const candidateList = candidates
            .slice(0, 10)
            .map(c => `• ${c.name} (${c.email || 'sin email'}) — desde ${new Date(c.createdAt).toLocaleDateString('es-CL')}`)
            .join('\n');

        logErrorToSlack('warning', {
            category: 'recruitment',
            action: 'stagnant_candidates',
            message: `⚠️ ${count} candidatos en "Nuevo" hace más de 7 días sin contactar`,
            module: 'recruitment-cron',
            details: { candidateList, totalCount: count },
        });
    } else if (job.name === 'process-web-form-email') {
        // ─── Process web form email → create candidate ───
        const { html, messageId } = job.data;
        console.log(`📧 Processing web form email: ${messageId}`);

        try {
            const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/recruitment/leads/from-email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html, messageId }),
            });
            const result = await res.json();

            if (result.duplicate) {
                console.log(`⏭️ Duplicate candidate from web form (${messageId})`);
            } else if (result.candidateId) {
                console.log(`✅ Created candidate ${result.candidateId} from web form`);
            } else {
                console.error(`❌ Failed to create candidate from web form:`, result);
            }
        } catch (err) {
            console.error('Error processing web form email:', err.message);
            throw err; // Let BullMQ retry
        }
    }
}, { connection: redisConnection, concurrency: 3 });

// Start cron jobs
startCronJobs();

console.log('⚙️ RE/MAX Worker started — processing jobs...');
