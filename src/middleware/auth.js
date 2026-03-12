import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.GOTRUE_JWT_SECRET || process.env.PGRST_JWT_SECRET;
const GOTRUE_URL = process.env.GOTRUE_URL || 'http://remax-auth:9999';

/**
 * Express middleware to verify GoTrue JWT token.
 * Strategy 1: Verify JWT directly if secret is available (fastest)
 * Strategy 2: Call GoTrue /user endpoint as fallback
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

    // Strategy 1: Direct JWT verification (if secret is configured)
    if (JWT_SECRET) {
        try {
            const payload = jwt.verify(token, JWT_SECRET);
            req.user = {
                id: payload.sub,
                email: payload.email,
                role: payload.role,
                aud: payload.aud,
                app_metadata: payload.app_metadata || {},
                user_metadata: payload.user_metadata || {},
            };
            req.supabaseToken = token;
            return next();
        } catch (err) {
            // If JWT verification fails, fall through to GoTrue
            console.warn('JWT verify failed, trying GoTrue:', err.message);
        }
    }

    // Strategy 2: Call GoTrue /user endpoint
    try {
        const response = await fetch(`${GOTRUE_URL}/user`, {
            headers: { Authorization: `Bearer ${token}`, apikey: token },
        });

        if (!response.ok) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        const user = await response.json();
        if (!user || !user.id) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        req.user = user;
        req.supabaseToken = token;
        next();
    } catch (err) {
        console.error('Auth middleware error:', err.message);
        res.status(401).json({ error: 'Authentication failed' });
    }
}
