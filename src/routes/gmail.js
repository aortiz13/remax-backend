import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import pool from '../lib/db.js';
import { emailQueue } from '../queues/index.js';

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
        ON CONFLICT (agent_id)
        DO UPDATE SET
            email_address = EXCLUDED.email_address,
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
        console.error('[Gmail] Callback error:', error);
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
        console.error('[Gmail] Callback error:', error);
        res.status(400).json({ error: error.message });
    }
});

// POST /api/gmail/send — Send email via Gmail API
router.post('/send', authMiddleware, async (req, res) => {
    try {
        const agentId = req.user.id;
        const emailData = req.body;

        await emailQueue.add('send-email', {
            agentId,
            ...emailData,
        }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
        });

        res.json({ success: true, message: 'Email queued for sending' });
    } catch (error) {
        console.error('Gmail send error:', error);
        res.status(400).json({ error: error.message });
    }
});

export default router;
