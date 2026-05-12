import { Router } from 'express';
import { buildErrorDigest } from '../services/auditDigest.js';

const router = Router();

// Header-based API key guard for machine-to-machine endpoints.
// Set INTERNAL_API_KEY in the backend's environment.
function requireInternalKey(req, res, next) {
    const key = req.headers['x-internal-api-key'];
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected) return res.status(500).json({ error: 'INTERNAL_API_KEY not configured' });
    if (!key || key !== expected) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// GET /api/internal/errors-digest?hours=24&levels=error,warning&limit=30
// Manual / debug entry point. The daily push to the claude.ai rutina goes
// through src/cron/scheduler.js, which calls the same buildErrorDigest().
router.get('/errors-digest', requireInternalKey, async (req, res) => {
    try {
        const hours = parseInt(req.query.hours, 10) || 24;
        const limit = parseInt(req.query.limit, 10) || 30;
        const levelsParam = (req.query.levels || 'error,warning').toString();
        const levels = levelsParam.split(',').map(s => s.trim()).filter(Boolean);

        const digest = await buildErrorDigest({ hours, levels, limit });
        res.json(digest);
    } catch (err) {
        console.error('errors-digest failed:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
