import { createClient } from '@supabase/supabase-js';

/**
 * Express middleware to verify Supabase JWT token from Authorization header.
 * Attaches user info to req.user
 */
export default async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Check if it's the service role key (internal calls)
    if (token === process.env.SUPABASE_SERVICE_ROLE_KEY) {
        req.user = { id: req.body?.agentId, role: 'service_role' };
        req.isServiceCall = true;
        return next();
    }

    try {
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY,
            { global: { headers: { Authorization: authHeader } } }
        );

        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        req.user = user;
        req.supabaseToken = token;
        next();
    } catch (err) {
        console.error('Auth middleware error:', err);
        res.status(401).json({ error: 'Authentication failed' });
    }
}
