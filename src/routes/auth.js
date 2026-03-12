import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// POST /api/auth/google — Exchange Google auth code for tokens
router.post('/google', authMiddleware, async (req, res) => {
    try {
        const { code, action } = req.body;
        const agentId = req.user.id;

        if (action === 'revoke') {
            // Revoke Google tokens
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

        // Exchange code for tokens
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
        await supabaseAdmin
            .from('profiles')
            .update({
                google_refresh_token: tokens.refresh_token,
                google_calendar_connected: true,
            })
            .eq('id', agentId);

        res.json({ success: true, access_token: tokens.access_token });
    } catch (error) {
        console.error('Google auth error:', error);
        res.status(400).json({ error: error.message });
    }
});

export default router;
