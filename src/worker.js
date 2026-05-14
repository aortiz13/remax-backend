import { Worker } from 'bullmq';
import { redisConnection } from './lib/redis.js';
import supabaseAdmin from './lib/supabaseAdmin.js';
import pool from './lib/db.js';
import { startCronJobs } from './cron/scheduler.js';
import crypto from 'crypto';

// Helper: log worker events to system_audit_logs
async function logWorkerAudit({ level, action, message, user_id, user_email, details }) {
    try {
        await pool.query(
            `INSERT INTO system_audit_logs (level, category, action, module, message, user_id, user_email, details, path)
             VALUES ($1, 'worker', $2, 'gmail', $3, $4, $5, $6, 'worker/email')`,
            [level, action, message, user_id || null, user_email || null, details ? JSON.stringify(details) : null]
        );
    } catch (err) {
        console.error('[Worker Audit] Failed to write:', err.message);
    }
}

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
    console.log(`📧 [Worker] Processing email job ${job.id} to ${to}...`);

    const { data: account } = await supabaseAdmin
        .from('gmail_accounts')
        .select('*')
        .eq('agent_id', agentId)
        .single();

    if (!account) {
        await logWorkerAudit({
            level: 'error', action: 'worker.email.no_account',
            message: `No se encontró cuenta Gmail para agente ${agentId}`,
            user_id: agentId,
            details: { to, subject, job_id: job.id },
        });
        throw new Error(`No Gmail account for agent ${agentId}`);
    }

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

    // --- Tracking Pixel and URL Substitution ---
    const trackingId = crypto.randomUUID();
    let contactId = null;
    
    // Find contact by email to bind the tracking
    if (to) {
        const toEmailMatch = to.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
        const toEmail = toEmailMatch ? toEmailMatch[1] : to;
        const { data: contacts } = await supabaseAdmin.from('contacts').select('id').ilike('email', toEmail.trim()).limit(1);
        if (contacts && contacts.length > 0) contactId = contacts[0].id;
    }

    // Log the intent to track
    await supabaseAdmin.from('email_tracking_logs').insert({
        id: trackingId,
        contact_id: contactId,
        subject: subject || '(Sin Asunto)',
        log_type: 'crm_agent'
    });

    const API_URL = process.env.API_GATEWAY_URL || 'https://remax-crm-remax-app.jzuuqr.easypanel.host';
    
    // Re-write URLs for click tracking (ignore if it's already a tracking URL, or empty/hash)
    if (htmlBody) {
        htmlBody = htmlBody.replace(/href=["'](https?:\/\/[^"']+)["']/gi, (match, url) => {
            if (url.includes('/api/tracking/')) return match;
            return `href="${API_URL}/api/tracking/click/${trackingId}?url=${encodeURIComponent(url)}"`;
        });
        
        // Inject Open Pixel
        const pixelHtml = `<img src="${API_URL}/api/tracking/open/${trackingId}" width="1" height="1" style="display:none;" />`;
        if (htmlBody.includes('</body>')) {
            htmlBody = htmlBody.replace('</body>', `${pixelHtml}</body>`);
        } else {
            htmlBody += pixelHtml;
        }
    }

    // Try to send, refresh token if needed
    let message = buildRawEmail({ from: account.email_address, to, cc, bcc, subject, htmlBody, inReplyTo, attachments });

    let response = await sendGmail(accessToken, account.email_address, message, threadId);

    if (response.status === 401) {
        accessToken = await getAccessToken(account.refresh_token, 'gmail_accounts', 'email_address', account.email_address);
        response = await sendGmail(accessToken, account.email_address, message, threadId);
    }

    if (!response.ok) {
        const errText = await response.text();
        await logWorkerAudit({
            level: 'error', action: 'worker.email.gmail_api_error',
            message: `Gmail API rechazó el envío a ${to}: HTTP ${response.status}`,
            user_id: agentId, user_email: account.email_address,
            details: { to, subject, from: account.email_address, status: response.status, error: errText?.substring(0, 500), job_id: job.id },
        });
        throw new Error(`Gmail send failed: ${response.status} ${errText}`);
    }

    const result = await response.json();

    // Defensive: a real Gmail send ALWAYS returns a message id. If we got 200 with
    // no id (corrupted body, intermediate proxy, etc.) we must NOT silently report
    // success — that's the false-positive path that marked Karina's inspection
    // as 'sent' on 2026-05-13 without any email actually leaving.
    if (!result?.id) {
        await logWorkerAudit({
            level: 'error', action: 'worker.email.no_message_id',
            message: `Gmail respondió 200 sin message id al enviar a ${to}`,
            user_id: agentId, user_email: account.email_address,
            details: { to, subject, from: account.email_address, response_body: JSON.stringify(result)?.substring(0, 500), job_id: job.id },
        });
        throw new Error(`Gmail returned 200 with no message id (body: ${JSON.stringify(result)?.substring(0, 200)})`);
    }

    console.log(`✅ [Worker] Email sent: ${result.id} (from: ${account.email_address} → to: ${to})`);

    // Log: successful delivery by worker
    await logWorkerAudit({
        level: 'info', action: 'worker.email.delivered',
        message: `Email entregado a Gmail: ${account.email_address} → ${to}`,
        user_id: agentId, user_email: account.email_address,
        details: { to, from: account.email_address, subject, gmail_message_id: result.id, tracking_id: trackingId, job_id: job.id },
    });

    return result;
}, { connection: redisConnection, concurrency: 5 });

// =============================================
// 📧 RECRUITMENT EMAIL WORKER — sends via emprendedores@ account
// Listens on a dedicated queue ('recruitment-email') so the generic
// email worker above doesn't accidentally pick up our jobs.
// =============================================
new Worker('recruitment-email', async (job) => {
    const { accountEmail, to, subject, bodyHtml: bodyHtmlOrig, candidateId, attachments } = job.data;
    let bodyHtml = bodyHtmlOrig;
    console.log(`📧 [Recruitment] Sending email to ${to} via ${accountEmail}...`);

    try {
        await runRecruitmentEmailJob({ accountEmail, to, subject, bodyHtml, candidateId, attachments, jobId: job.id });
    } catch (err) {
        console.error(`❌ [Recruitment] Job ${job.id} failed:`, err);
        // Mark the queued log row as failed so we can see the cause in the DB
        try {
            await pool.query(
                `UPDATE recruitment_email_logs
                    SET status = 'failed',
                        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('error', $1::text)
                  WHERE candidate_id = $2 AND status = 'queued'`,
                [String(err?.message || err).slice(0, 1000), candidateId],
            );
        } catch (logErr) {
            console.error('[Recruitment] Failed to UPDATE recruitment_email_logs to failed:', logErr.message);
        }
        // Slack alert with the real reason
        try {
            const { logErrorToSlack } = await import('./middleware/slackErrorLogger.js');
            logErrorToSlack('error', {
                category: 'recruitment',
                action: 'recruitment_email.send_error',
                message: `❌ Falló envío del email de Aprobación/Rechazo a ${to}: ${err?.message || err}`,
                module: 'recruitment-worker',
                details: {
                    candidateId, accountEmail, to, subject, jobId: job.id,
                    stack: (err?.stack || '').toString().slice(0, 800),
                },
            });
        } catch (slackErr) {
            console.error('[Recruitment] Slack alert also failed:', slackErr.message);
        }
        throw err; // let BullMQ retry
    }
}, { connection: redisConnection, concurrency: 3 });

async function runRecruitmentEmailJob({ accountEmail, to, subject, bodyHtml: bodyHtmlIn, candidateId, attachments, jobId }) {
    let bodyHtml = bodyHtmlIn;
    const breadcrumb = (step) => console.log(`   [Recruitment ${jobId}] ${step}`);

    breadcrumb('1. Querying gmail_accounts...');
    const { data: account, error: accountErr } = await supabaseAdmin
        .from('gmail_accounts')
        .select('*')
        .eq('email_address', accountEmail)
        .single();

    if (accountErr) throw new Error(`supabaseAdmin gmail_accounts query failed: ${accountErr.message}`);
    if (!account) throw new Error(`No recruitment Gmail account found: ${accountEmail}`);
    breadcrumb('2. Got account, hydrating attachments...');

    let accessToken = account.access_token;

    // --- Tracking Pixel and URL Substitution ---
    const trackingId = crypto.randomUUID();

    // Log the intent to track
    await supabaseAdmin.from('email_tracking_logs').insert({
        id: trackingId,
        contact_id: candidateId, // for recruitment, candidateId is the contact
        subject: subject || '(Sin Asunto)',
        log_type: 'recruitment'
    });

    const API_URL = process.env.API_GATEWAY_URL || 'https://remax-crm-remax-app.jzuuqr.easypanel.host';
    
    // Re-write URLs for click tracking
    if (bodyHtml) {
        bodyHtml = bodyHtml.replace(/href=["'](https?:\/\/[^"']+)["']/gi, (match, url) => {
            if (url.includes('/api/tracking/')) return match;
            return `href="${API_URL}/api/tracking/click/${trackingId}?url=${encodeURIComponent(url)}"`;
        });
        
        // Inject Open Pixel
        const pixelHtml = `<img src="${API_URL}/api/tracking/open/${trackingId}" width="1" height="1" style="display:none;" />`;
        if (bodyHtml.includes('</body>')) {
            bodyHtml = bodyHtml.replace('</body>', `${pixelHtml}</body>`);
        } else {
            bodyHtml += pixelHtml;
        }
    }

    // Hydrate attachments: download each URL and base64-encode for the MIME multipart
    const hydrated = [];
    for (const att of (attachments || [])) {
        breadcrumb(`3. Downloading attachment ${att.url}...`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        try {
            const r = await fetch(att.url, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const buf = Buffer.from(await r.arrayBuffer());
            hydrated.push({
                filename: att.filename || att.url.split('/').pop() || 'attachment',
                mimeType: att.mimeType || r.headers.get('content-type') || 'application/octet-stream',
                data: buf.toString('base64'),
            });
            breadcrumb(`3. Downloaded ${buf.length} bytes`);
        } catch (err) {
            clearTimeout(timer);
            console.error(`[Recruitment] Failed to download attachment ${att.url}:`, err.message);
            // We don't throw — sending the email without attachment is better than not sending
        }
    }

    breadcrumb('4. Building raw email...');
    let message = buildRawEmail({ from: accountEmail, to, subject, htmlBody: bodyHtml, attachments: hydrated });

    breadcrumb('5. Calling Gmail API...');
    let response = await sendGmail(accessToken, accountEmail, message);
    breadcrumb(`5. Gmail responded ${response.status}`);

    if (response.status === 401) {
        breadcrumb('6. Refreshing token...');
        accessToken = await getAccessToken(account.refresh_token, 'gmail_accounts', 'email_address', accountEmail);
        breadcrumb('6. Retrying send with new token...');
        response = await sendGmail(accessToken, accountEmail, message);
        breadcrumb(`6. Gmail responded ${response.status}`);
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
}

async function sendGmail(accessToken, email, raw, threadId) {
    const body = { raw };
    if (threadId) body.threadId = threadId;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
        return await fetch(`https://gmail.googleapis.com/gmail/v1/users/${email}/messages/send`, {
            signal: ctrl.signal,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
    } finally {
        clearTimeout(timer);
    }
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
//   - 'sync-remax-listings': cron job that syncs ALL agents (non-destructive)
//   - 'import-remax-listings': legacy single-agent path, no-op stub
// All persistence is delegated to propertySyncService.syncAllAgents() which
// never deletes rows — see that file's header for safety rules.
// =============================================
new Worker('import', async (job) => {
    if (job.name === 'sync-remax-listings') {
        const { syncAllAgents } = await import('./services/propertySyncService.js');
        console.log('📦 [cron] starting non-destructive RE/MAX sync for all agents');
        const summary = await syncAllAgents(undefined, { includeProperties: false });
        console.log(`📦 [cron] done in ${summary.duration_ms}ms — agents=${summary.agents_processed} +${summary.properties_inserted}/~${summary.properties_updated} ph=${summary.photos_added} hist=${summary.history_added} skipped=${summary.properties_skipped}`);
        const errorCount = summary.results.reduce((s, r) => s + r.errors.length, 0);
        if (errorCount > 0) {
            console.warn(`📦 [cron] ${errorCount} per-agent errors — see results in job return`);
        }
        return summary;

    } else if (job.name === 'import-remax-listings') {
        // Legacy single-agent job (now superseded by /api/sync/remax-listings/agent).
        const { agentId, triggeredBy } = job.data || {};
        console.log(`📦 [import-worker] legacy import job for agent=${agentId} (triggered=${triggeredBy}) — no-op`);
        return { skipped: true, reason: 'use /api/sync/remax-listings/agent instead' };

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

// =============================================
// 🔔 TASK REMINDER WORKER
// =============================================
new Worker('task-reminder', async (job) => {
    const { type, channels, agent, tasks, reminder_key } = job.data;
    console.log(`🔔 Processing ${type} for ${agent.name} via ${channels.join(', ')}`);

    try {
        // 1. Post to n8n Webhook
        const N8N_WEBHOOK_URL = 'https://workflow.remax-exclusive.cl/webhook/task-reminders';
        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type,
                channels,
                agent,
                tasks,
                reminder_key,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`n8n webhook failed: ${response.status} ${errText}`);
        }

        console.log(`✅ n8n webhook triggered for ${reminder_key}`);

        // 2. Log in database for deduplication
        // In the case of daily summaries, we just log one record with task_id of the first task
        const firstTaskId = tasks[0]?.id;
        if (firstTaskId) {
            for (const channel of channels) {
                const { error: logErr } = await supabaseAdmin.from('notification_logs').insert({
                    task_id: firstTaskId,
                    agent_id: agent.id,
                    channel: channel,
                    notification_type: type,
                    reminder_key: `${reminder_key}:${channel}`, // Unique key per channel for the log table
                }).select('id').single();
                
                // If it fails due to unique constraint, that's fine (already logged)
                if (logErr && logErr.code !== '23505') {
                    console.error(`⚠️ Failed to log notification: ${logErr.message}`);
                }
            }
            
            // Also log the main deduplication key so the cron job sees it
            const { error: dedupErr } = await supabaseAdmin.from('notification_logs').insert({
                task_id: firstTaskId,
                agent_id: agent.id,
                channel: channels[0], // Arbitrary
                notification_type: type,
                reminder_key: reminder_key, // The exact key the cron job checks
            }).select('id').single();
            if (dedupErr && dedupErr.code !== '23505') {
                console.error(`⚠️ Failed to log dedup key: ${dedupErr.message}`);
            }
        }
        
    } catch (error) {
        console.error(`❌ Task reminder worker error: ${error.message}`);
        const { logErrorToSlack } = await import('./middleware/slackErrorLogger.js');
        logErrorToSlack('error', {
            category: 'notifications',
            action: 'task_reminder.worker',
            message: `Failed to send ${type} to ${agent.name}: ${error.message}`,
            module: 'worker',
        });
        throw error; // Let BullMQ retry
    }
}, { connection: redisConnection, concurrency: 3 });

// ─── Recruitment Calendar Sync Worker ──────────────────────────────────
new Worker('calendar-webhook', async (job) => {
    if (job.data?.kind !== 'recruitment') return;
    try {
        const { syncRecruitmentCalendar, setupRecruitmentCalendarWatch } = await import('./routes/recruitmentCalendar.js');
        if (job.data.action === 'renew-watch') {
            await setupRecruitmentCalendarWatch(job.data.emailAddress);
            console.log(`📅 Recruitment calendar watch renewed for ${job.data.emailAddress}`);
            return;
        }
        const result = await syncRecruitmentCalendar(job.data.emailAddress);
        console.log(`📅 Recruitment calendar sync: ${JSON.stringify(result)}`);
    } catch (err) {
        console.error(`❌ Recruitment calendar worker error: ${err.message}`);
        const { logErrorToSlack } = await import('./middleware/slackErrorLogger.js');
        logErrorToSlack('error', {
            category: 'worker', action: 'recruitment_calendar.sync', message: err.message,
            module: 'worker',
        });
        throw err;
    }
}, { connection: redisConnection, concurrency: 1 });

// Start cron jobs
startCronJobs();

console.log('⚙️ RE/MAX Worker started — processing jobs...');
