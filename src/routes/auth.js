import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://solicitudes.remax-exclusive.cl';

// Scopes needed for Calendar read/write
const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
].join(' ');

// GET /api/auth/google/callback — Google redirects here, then we redirect to frontend
router.get('/google/callback', (req, res) => {
    const { code, error } = req.query;
    if (error) {
        return res.redirect(`${FRONTEND_URL}/profile?google_error=${encodeURIComponent(error)}`);
    }
    // Redirect to frontend /profile with the code so the frontend can exchange it
    res.redirect(`${FRONTEND_URL}/profile?code=${encodeURIComponent(code)}`);
});

// POST /api/auth/google — Handle authorize, callback (code exchange), and revoke
router.post('/google', authMiddleware, async (req, res) => {
    try {
        const { code, action } = req.body;
        const agentId = req.user.id;

        // ── ACTION: authorize — Generate Google OAuth consent URL ──
        if (action === 'authorize') {
            if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
                return res.status(500).json({ error: 'Google OAuth not configured on server' });
            }

            const params = new URLSearchParams({
                client_id: GOOGLE_CLIENT_ID,
                redirect_uri: GOOGLE_REDIRECT_URI,
                response_type: 'code',
                scope: SCOPES,
                access_type: 'offline',
                prompt: 'consent',
            });

            const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
            return res.json({ url });
        }

        // ── ACTION: revoke — Revoke Google tokens ──
        if (action === 'revoke') {
            const { data: profile } = await supabaseAdmin
                .from('profiles')
                .select('google_refresh_token')
                .eq('id', agentId)
                .single();

            if (profile?.google_refresh_token) {
                await fetch(`https://oauth2.googleapis.com/revoke?token=${profile.google_refresh_token}`, {
                    method: 'POST',
                });
            }

            await supabaseAdmin
                .from('profiles')
                .update({
                    google_refresh_token: null,
                    google_sync_token: null,
                    google_calendar_connected: false,
                })
                .eq('id', agentId);

            return res.json({ success: true });
        }

        // ── ACTION: callback (or default) — Exchange code for tokens ──
        if (!code) {
            return res.status(400).json({ error: 'Missing authorization code' });
        }

        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: GOOGLE_REDIRECT_URI,
                grant_type: 'authorization_code',
            }),
        });

        const tokens = await tokenResponse.json();
        if (tokens.error) {
            return res.status(400).json({ error: tokens.error_description || tokens.error });
        }

        // Save refresh token to profile
        const updateData = {
            google_calendar_connected: true,
        };
        // Only update refresh_token if Google returned one (it won't on re-auth without prompt=consent)
        if (tokens.refresh_token) {
            updateData.google_refresh_token = tokens.refresh_token;
        }

        await supabaseAdmin
            .from('profiles')
            .update(updateData)
            .eq('id', agentId);

        res.json({ success: true, access_token: tokens.access_token });
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'auth.google', message: error.message,
            module: 'auth',
        });
        res.status(400).json({ error: error.message });
    }
});

export default router;
