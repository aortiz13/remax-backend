import { Router } from 'express';
import { buildErrorDigest, pushDigestToRutina } from '../services/auditDigest.js';
import authMiddleware from '../middleware/auth.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

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

// POST /api/internal/triage/trigger-now
// User-facing endpoint to manually fire the same flow as the daily cron.
// Auth: GoTrue JWT (authMiddleware) + role check (tecnico / superadministrador).
router.post('/triage/trigger-now', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const { data: profile, error: profileErr } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .eq('id', userId)
            .single();

        if (profileErr || !profile || !['tecnico', 'superadministrador'].includes(profile.role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        if (!process.env.TRIAGE_RUTINA_URL) {
            return res.status(503).json({ error: 'rutina not configured on backend' });
        }

        const hoursRaw = Number(req.body?.hours);
        const hours = Number.isFinite(hoursRaw) && hoursRaw > 0
            ? Math.min(hoursRaw, 168)
            : 24;

        const digest = await buildErrorDigest({ hours, levels: ['error', 'warning'], limit: 30 });
        const result = await pushDigestToRutina(digest);

        res.json({
            unique_signatures: digest.unique_signatures,
            totals: digest.totals,
            skipped: result.skipped,
            ok: result.ok,
        });
    } catch (err) {
        console.error('triage trigger-now failed:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
