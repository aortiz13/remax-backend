import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
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

// GET /api/gmail/auth-url — Generate Gmail OAuth URL
router.get('/auth-url', authMiddleware, async (req, res) => {
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
});

// GET /api/gmail/callback — Handle Gmail OAuth callback
router.get('/callback', async (req, res) => {
    try {
        const { code, state: agentId } = req.query;
        if (!code || !agentId) {
            return res.status(400).json({ error: 'Missing code or state' });
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
        if (tokens.error) {
            return res.status(400).json({ error: tokens.error_description || tokens.error });
        }

        // Get user email
        const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        const gmailProfile = await profileRes.json();

        // Save to gmail_accounts
        await supabaseAdmin.from('gmail_accounts').upsert({
            agent_id: agentId,
            email_address: gmailProfile.emailAddress,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            last_history_id: gmailProfile.historyId,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'agent_id' });

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
        if (watchData.historyId) {
            await supabaseAdmin.from('gmail_accounts')
                .update({ last_history_id: watchData.historyId, watch_expiration: watchData.expiration })
                .eq('agent_id', agentId);
        }

        // Redirect back to app
        const frontendUrl = process.env.FRONTEND_URL || 'https://solicitudes.remax-exclusive.cl';
        res.redirect(`${frontendUrl}/casilla?gmail=connected`);
    } catch (error) {
        console.error('Gmail callback error:', error);
        res.status(400).json({ error: error.message });
    }
});

// POST /api/gmail/send — Send email via Gmail API
router.post('/send', authMiddleware, async (req, res) => {
    try {
        const agentId = req.user.id;
        const emailData = req.body;

        // Enqueue the email sending job
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
