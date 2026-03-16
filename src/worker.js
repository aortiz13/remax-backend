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
        htmlBody += `<div style="margin-top:24px; padding-top:16px; border-top:1px solid #e5e7eb;"><img src="${agentProfile.signature_image_url}" alt="Firma" style="max-width:500px; height:auto; display:block;" /></div>`;
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

    await fetch(SLACK_WEBHOOK_URL, {
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
    console.log(`🔔 Slack alert sent: ${level} - ${message}`);
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
// 📦 IMPORT WORKER — import RE/MAX listings
// =============================================
new Worker('import', async (job) => {
    const { officeId, agentMlsId, triggeredBy } = job.data;
    console.log(`📦 Importing RE/MAX listings for office ${officeId}...`);
    // TODO: Port import-remax-listings Edge Function logic
}, { connection: redisConnection, concurrency: 1 });

// Start cron jobs
startCronJobs();

console.log('⚙️ RE/MAX Worker started — processing jobs...');
