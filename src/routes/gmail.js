import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import pool from '../lib/db.js';
import { emailQueue, emailQueueEvents, recruitmentEmailQueue } from '../queues/index.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_GMAIL_REDIRECT_URI = process.env.GOOGLE_GMAIL_REDIRECT_URI;

const GMAIL_SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
].join(' ');

// Generate Gmail OAuth URL (supports both GET and POST)
const handleAuthUrl = async (req, res) => {
    try {
        const agentId = req.user.id;
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
        url.searchParams.set('redirect_uri', GOOGLE_GMAIL_REDIRECT_URI);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', GMAIL_SCOPES);
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');
        url.searchParams.set('state', agentId);

        res.json({ url: url.toString() });
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'gmail.auth_url', message: error.message,
            module: 'gmail',
        });
        res.status(400).json({ error: error.message });
    }
};
router.get('/auth-url', authMiddleware, handleAuthUrl);
router.post('/auth-url', authMiddleware, handleAuthUrl);

// Process Gmail OAuth callback (shared logic using direct SQL)
const processGmailCallback = async (code, agentId) => {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: GOOGLE_GMAIL_REDIRECT_URI,
            grant_type: 'authorization_code',
        }),
    });

    const tokens = await tokenResponse.json();
    if (tokens.error) {
        throw new Error(tokens.error_description || tokens.error);
    }

    console.log('[Gmail] Got tokens for agent:', agentId);

    // Get user email
    const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const gmailProfile = await profileRes.json();
    console.log('[Gmail] Profile email:', gmailProfile.emailAddress);

    // Save to gmail_accounts via direct SQL (bypasses PostgREST/RLS)
    const upsertResult = await pool.query(`
        INSERT INTO gmail_accounts (agent_id, email_address, access_token, refresh_token, last_history_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (email_address)
        DO UPDATE SET
            agent_id = EXCLUDED.agent_id,
            access_token = EXCLUDED.access_token,
            refresh_token = COALESCE(EXCLUDED.refresh_token, gmail_accounts.refresh_token),
            last_history_id = EXCLUDED.last_history_id,
            updated_at = NOW()
        RETURNING email_address, updated_at
    `, [agentId, gmailProfile.emailAddress, tokens.access_token, tokens.refresh_token, gmailProfile.historyId]);

    console.log('[Gmail] Upsert result:', upsertResult.rows[0]);

    // Setup Gmail push notifications (Pub/Sub watch)
    const watchRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/watch', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            topicName: process.env.GOOGLE_PUBSUB_TOPIC,
            labelIds: ['INBOX'],
        }),
    });

    const watchData = await watchRes.json();
    console.log('[Gmail] Watch result:', JSON.stringify(watchData));

    if (watchData.historyId) {
        await pool.query(
            `UPDATE gmail_accounts SET last_history_id = $1, updated_at = NOW() WHERE agent_id = $2`,
            [watchData.historyId, agentId]
        );
    }

    return { success: true, email: gmailProfile.emailAddress };
};

// GET /api/gmail/callback — Handle Gmail OAuth callback (browser redirect)
router.get('/callback', async (req, res) => {
    try {
        const { code, state: agentId } = req.query;
        if (!code || !agentId) {
            return res.status(400).json({ error: 'Missing code or state' });
        }

        await processGmailCallback(code, agentId);

        const frontendUrl = process.env.FRONTEND_URL || 'https://solicitudes.remax-exclusive.cl';
        res.redirect(`${frontendUrl}/casilla?gmail=connected`);
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'gmail.callback', message: error.message,
            module: 'gmail',
        });
        const frontendUrl = process.env.FRONTEND_URL || 'https://solicitudes.remax-exclusive.cl';
        res.redirect(`${frontendUrl}/casilla?gmail=error&msg=${encodeURIComponent(error.message)}`);
    }
});

// POST /api/gmail/callback — Handle Gmail OAuth callback (frontend API call)
router.post('/callback', authMiddleware, async (req, res) => {
    try {
        const { code } = req.body;
        const agentId = req.user.id;
        if (!code) {
            return res.status(400).json({ error: 'Missing code' });
        }

        const result = await processGmailCallback(code, agentId);
        res.json(result);
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'gmail.callback_post', message: error.message,
            module: 'gmail',
        });
        res.status(400).json({ error: error.message });
    }
});

// Helper: log to system_audit_logs
async function logAudit({ level, action, message, user_id, user_email, details }) {
    try {
        await pool.query(
            `INSERT INTO system_audit_logs (level, category, action, module, message, user_id, user_email, details, path)
             VALUES ($1, 'backend', $2, 'gmail', $3, $4, $5, $6, '/api/gmail/send')`,
            [level, action, message, user_id || null, user_email || null, details ? JSON.stringify(details) : null]
        );
    } catch (err) {
        console.error('[Audit Log] Failed to write:', err.message);
    }
}

// POST /api/gmail/send — Send email via Gmail API (waits for real delivery confirmation)
router.post('/send', authMiddleware, async (req, res) => {
    try {
        const agentId = req.user.id;
        const userEmail = req.user.email;
        const emailData = req.body;

        // Log: request received
        await logAudit({
            level: 'info', action: 'gmail.send.request',
            message: `Solicitud de envío de correo a ${emailData.to}`,
            user_id: agentId, user_email: userEmail,
            details: { to: emailData.to, subject: emailData.subject, has_attachments: !!(emailData.attachments?.length), cc: emailData.cc || null },
        });

        // 1. Check Redis is reachable before queueing
        try {
            const redisClient = await emailQueue.client;
            await redisClient.ping();
        } catch (redisErr) {
            console.error('[Gmail Send] Redis not reachable:', redisErr.message);
            await logAudit({
                level: 'error', action: 'gmail.send.redis_down',
                message: `Redis no disponible al intentar enviar correo a ${emailData.to}`,
                user_id: agentId, user_email: userEmail,
                details: { to: emailData.to, subject: emailData.subject, error: redisErr.message },
            });
            logErrorToSlack('error', {
                category: 'backend', action: 'gmail.send.redis_down', message: `Redis unreachable: ${redisErr.message}`,
                module: 'gmail', user_email: userEmail,
            });
            return res.status(503).json({ error: 'El servicio de correo no está disponible en este momento. Intenta de nuevo en unos segundos.' });
        }

        // 2. Queue the job and wait for completion (max 30s)
        const job = await emailQueue.add('send-email', {
            agentId,
            ...emailData,
        }, {
            attempts: 1,
            removeOnComplete: { age: 300 },
            removeOnFail: { age: 600 },
        });

        // 3. Wait for the worker to process the job (timeout 30s)
        const SEND_TIMEOUT_MS = 30000;
        try {
            const result = await Promise.race([
                job.waitUntilFinished(emailQueueEvents, SEND_TIMEOUT_MS),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), SEND_TIMEOUT_MS + 1000)),
            ]);
            console.log(`✅ [Gmail Send] Email confirmed sent, Gmail ID: ${result?.id || 'unknown'}`);

            // Log: success
            await logAudit({
                level: 'info', action: 'gmail.send.success',
                message: `Correo enviado exitosamente a ${emailData.to}`,
                user_id: agentId, user_email: userEmail,
                details: { to: emailData.to, subject: emailData.subject, gmail_message_id: result?.id, job_id: job.id },
            });

            res.json({ success: true, message: 'Correo enviado exitosamente', gmailMessageId: result?.id });
        } catch (waitErr) {
            if (waitErr.message === 'TIMEOUT') {
                console.warn('[Gmail Send] Job timed out after 30s, checking state...');
                const state = await job.getState();
                if (state === 'completed') {
                    await logAudit({
                        level: 'warning', action: 'gmail.send.slow_success',
                        message: `Correo a ${emailData.to} enviado con delay (timeout pero completado)`,
                        user_id: agentId, user_email: userEmail,
                        details: { to: emailData.to, subject: emailData.subject, job_id: job.id },
                    });
                    res.json({ success: true, message: 'Correo enviado exitosamente' });
                } else {
                    await logAudit({
                        level: 'error', action: 'gmail.send.timeout',
                        message: `Timeout al enviar correo a ${emailData.to} (estado: ${state})`,
                        user_id: agentId, user_email: userEmail,
                        details: { to: emailData.to, subject: emailData.subject, job_state: state, job_id: job.id },
                    });
                    logErrorToSlack('error', {
                        category: 'backend', action: 'gmail.send.timeout',
                        message: `Email send timed out (state: ${state}), to: ${emailData.to}`,
                        module: 'gmail', user_email: userEmail,
                    });
                    res.status(504).json({ error: 'El envío del correo tardó demasiado. Verifica en tu Gmail si fue enviado.' });
                }
            } else {
                const failReason = waitErr.message || 'Error desconocido al enviar';
                console.error('[Gmail Send] Job failed:', failReason);

                // Log: failure
                await logAudit({
                    level: 'error', action: 'gmail.send.failed',
                    message: `Error al enviar correo a ${emailData.to}: ${failReason}`,
                    user_id: agentId, user_email: userEmail,
                    details: { to: emailData.to, subject: emailData.subject, error: failReason, job_id: job.id },
                });
                logErrorToSlack('error', {
                    category: 'backend', action: 'gmail.send.failed',
                    message: `Email send failed: ${failReason}`,
                    module: 'gmail', user_email: userEmail,
                    details: { to: emailData.to, subject: emailData.subject },
                });
                res.status(500).json({ error: `Error al enviar el correo: ${failReason}` });
            }
        }
    } catch (error) {
        await logAudit({
            level: 'error', action: 'gmail.send.exception',
            message: `Excepción al procesar envío de correo: ${error.message}`,
            details: { error: error.message, stack: error.stack?.substring(0, 500) },
        });
        logErrorToSlack('error', {
            category: 'backend', action: 'gmail.send', message: error.message,
            module: 'gmail',
        });
        res.status(400).json({ error: error.message });
    }
});
// POST /api/gmail/send-recruitment — Send email via shared recruitment Gmail (emprendedores@)
router.post('/send-recruitment', authMiddleware, async (req, res) => {
    try {
        const { candidateId, toEmail, subject, bodyHtml, templateId, abVariant, attachments } = req.body;

        if (!toEmail || !subject || !bodyHtml) {
            return res.status(400).json({ error: 'Missing required fields: toEmail, subject, bodyHtml' });
        }

        // Find the recruitment Gmail account
        const result = await pool.query(
            `SELECT id, email_address FROM gmail_accounts WHERE purpose = 'recruitment' LIMIT 1`
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Recruitment Gmail account (emprendedores@) not connected. Please connect it first.' });
        }

        const recruitmentAccount = result.rows[0];

        // Queue email for sending — uses the dedicated recruitment-email queue
        // so it doesn't compete with the per-agent email worker.
        await recruitmentEmailQueue.add('send-recruitment-email', {
            accountEmail: recruitmentAccount.email_address,
            to: toEmail,
            subject,
            bodyHtml,
            candidateId,
            templateId,
            abVariant,
            attachments: Array.isArray(attachments) ? attachments : [],
            sentBy: req.user.id,
        }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
        });

        // Insert initial log
        await pool.query(`
            INSERT INTO recruitment_email_logs (candidate_id, email_type, subject, body_html, to_email, status, sent_at, ab_variant, metadata)
            VALUES ($1, $2, $3, $4, $5, 'queued', NOW(), $6, $7)
        `, [
            candidateId,
            'Manual',
            subject,
            bodyHtml,
            toEmail,
            abVariant || null,
            JSON.stringify({ template_id: templateId, sent_by: req.user.id }),
        ]);

        res.json({ success: true, message: 'Email queued for sending' });
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'gmail.send_recruitment', message: error.message,
            module: 'gmail',
        });
        res.status(400).json({ error: error.message });
    }
});

// GET /api/gmail/recruitment-account-status — Check if recruitment account is connected
router.get('/recruitment-account-status', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT email_address, updated_at FROM gmail_accounts WHERE purpose = 'recruitment' LIMIT 1`
        );
        res.json({
            connected: result.rows.length > 0,
            email: result.rows[0]?.email_address || null,
            lastUpdated: result.rows[0]?.updated_at || null,
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// POST /api/gmail/connect-recruitment — Connect emprendedores@ as recruitment account
router.post('/connect-recruitment', authMiddleware, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: 'Missing OAuth code' });
        }

        // Exchange code for tokens
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: GOOGLE_GMAIL_REDIRECT_URI,
                grant_type: 'authorization_code',
            }),
        });

        const tokens = await tokenResponse.json();
        if (tokens.error) throw new Error(tokens.error_description || tokens.error);

        // Get email
        const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        const gmailProfile = await profileRes.json();

        // Save as recruitment account
        await pool.query(`
            INSERT INTO gmail_accounts (agent_id, email_address, access_token, refresh_token, purpose, updated_at)
            VALUES ($1, $2, $3, $4, 'recruitment', NOW())
            ON CONFLICT (email_address)
            DO UPDATE SET
                access_token = EXCLUDED.access_token,
                refresh_token = COALESCE(EXCLUDED.refresh_token, gmail_accounts.refresh_token),
                purpose = 'recruitment',
                updated_at = NOW()
        `, [req.user.id, gmailProfile.emailAddress, tokens.access_token, tokens.refresh_token]);

        // Setup watch for incoming replies
        await fetch('https://www.googleapis.com/gmail/v1/users/me/watch', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${tokens.access_token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                topicName: process.env.GOOGLE_PUBSUB_TOPIC,
                labelIds: ['INBOX'],
            }),
        });

        res.json({ success: true, email: gmailProfile.emailAddress });
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'gmail.connect_recruitment', message: error.message,
            module: 'gmail',
        });
        res.status(400).json({ error: error.message });
    }
});

// POST /api/gmail/sync — Manual sync: renew watch + backfill recent emails
router.post('/sync', authMiddleware, async (req, res) => {
    try {
        const agentId = req.user.id;
        const result = await pool.query(
            `SELECT id, email_address, access_token, refresh_token, last_history_id FROM gmail_accounts WHERE agent_id = $1 LIMIT 1`,
            [agentId]
        );
        if (result.rows.length === 0) return res.status(400).json({ error: 'No Gmail account connected' });
        const account = result.rows[0];

        // 1. Refresh access token
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                refresh_token: account.refresh_token,
                grant_type: 'refresh_token',
            }),
        });
        const tokenData = await tokenRes.json();
        if (tokenData.error) throw new Error(`Token refresh failed: ${tokenData.error}`);
        const accessToken = tokenData.access_token;

        await pool.query(
            `UPDATE gmail_accounts SET access_token = $1, updated_at = NOW() WHERE id = $2`,
            [accessToken, account.id]
        );

        // 2. Renew Pub/Sub watch
        const watchRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/watch', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                topicName: process.env.GOOGLE_PUBSUB_TOPIC,
                labelIds: ['INBOX'],
            }),
        });
        const watchData = await watchRes.json();

        if (watchData.historyId) {
            await pool.query(
                `UPDATE gmail_accounts SET last_history_id = $1, updated_at = NOW() WHERE id = $2`,
                [watchData.historyId, account.id]
            );
        }

        // 3. Backfill: fetch recent messages and upsert directly
        const listRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/${account.email_address}/messages?maxResults=50`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const listData = await listRes.json();
        const msgIds = (listData.messages || []).map(m => m.id);

        let synced = 0;
        for (const msgId of msgIds) {
            try {
                // Fetch full message
                const msgRes = await fetch(
                    `https://gmail.googleapis.com/gmail/v1/users/${account.email_address}/messages/${msgId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID`,
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );
                if (!msgRes.ok) continue;
                const msgData = await msgRes.json();

                const headers = msgData.payload?.headers || [];
                const getH = (n) => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
                const extractEmail = (v) => { const m = (v||'').match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/); return m ? m[1].toLowerCase() : (v||'').toLowerCase().trim(); };

                const fromAddr = extractEmail(getH('From'));
                const toAddr = extractEmail(getH('To'));
                const subject = getH('Subject') || '(Sin Asunto)';
                const gmailThreadId = msgData.threadId;
                const labels = msgData.labelIds || [];

                // Upsert thread
                const threadData = {
                    gmail_thread_id: gmailThreadId,
                    agent_id: account.agent_id,
                    subject,
                    labels,
                    updated_at: new Date().toISOString(),
                };
                await supabaseAdmin.from('email_threads').upsert(threadData, { onConflict: 'gmail_thread_id' });
                const { data: threadRec } = await supabaseAdmin.from('email_threads').select('id').eq('gmail_thread_id', gmailThreadId).single();
                if (!threadRec) continue;

                // Upsert message
                await supabaseAdmin.from('email_messages').upsert({
                    gmail_message_id: msgData.id,
                    thread_id: threadRec.id,
                    agent_id: account.agent_id,
                    from_address: fromAddr,
                    to_address: toAddr,
                    subject,
                    snippet: msgData.snippet || '',
                    rfc_message_id: getH('Message-ID'),
                    received_at: new Date(parseInt(msgData.internalDate)).toISOString(),
                }, { onConflict: 'gmail_message_id' });
                synced++;
            } catch (e) {
                console.warn(`Backfill msg ${msgId} error:`, e.message);
            }
        }

        res.json({
            success: true,
            watchRenewed: !!watchData.historyId,
            messagesQueued: synced,
        });
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'gmail.sync', message: error.message,
            module: 'gmail',
        });
        res.status(400).json({ error: error.message });
    }
});

export default router;
