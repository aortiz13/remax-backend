import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.GOTRUE_JWT_SECRET || process.env.PGRST_JWT_SECRET;

/**
 * Express middleware to verify GoTrue JWT token from Authorization header.
 * Verifies the JWT directly using the shared secret (no HTTP calls needed).
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
        // Verify JWT directly using the shared secret
        const payload = jwt.verify(token, JWT_SECRET);

        // Build user object from JWT claims (matches GoTrue token structure)
        req.user = {
            id: payload.sub,
            email: payload.email,
            role: payload.role,
            aud: payload.aud,
            app_metadata: payload.app_metadata || {},
            user_metadata: payload.user_metadata || {},
        };
        req.supabaseToken = token;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        console.error('Auth middleware error:', err.message);
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}
