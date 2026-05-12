import { Router } from 'express';
import pool from '../lib/db.js';

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
// Returns errors from system_audit_logs grouped by signature so a Claude
// rutina can iterate unique issues instead of thousands of duplicates.
router.get('/errors-digest', requireInternalKey, async (req, res) => {
    try {
        const hours = Math.min(parseInt(req.query.hours, 10) || 24, 24 * 14);
        const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
        const levelsParam = (req.query.levels || 'error,warning').toString();
        const levels = levelsParam.split(',').map(s => s.trim()).filter(Boolean);

        const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        // Signature: stable key per logical error. We snip the message because
        // identical bugs often carry varying tails (ids, timestamps).
        const sql = `
            WITH recent AS (
                SELECT
                    id, created_at, level, category, action, module, message,
                    path, user_id, user_email, user_name, error_code, details
                FROM system_audit_logs
                WHERE created_at >= $1
                  AND level = ANY($2::text[])
            ),
            signed AS (
                SELECT
                    *,
                    concat_ws('|',
                        level,
                        COALESCE(category, ''),
                        COALESCE(action, ''),
                        COALESCE(module, ''),
                        substr(COALESCE(message, ''), 1, 120)
                    ) AS signature
                FROM recent
            ),
            grouped AS (
                SELECT
                    signature,
                    MAX(level) AS level,
                    MAX(category) AS category,
                    MAX(action) AS action,
                    MAX(module) AS module,
                    MAX(message) AS message,
                    COUNT(*)::int AS occurrences,
                    MIN(created_at) AS first_seen,
                    MAX(created_at) AS last_seen,
                    ARRAY_AGG(DISTINCT error_code) FILTER (WHERE error_code IS NOT NULL) AS error_codes,
                    (ARRAY_AGG(DISTINCT path) FILTER (WHERE path IS NOT NULL))[1:5] AS sample_paths,
                    (ARRAY_AGG(DISTINCT user_email) FILTER (WHERE user_email IS NOT NULL))[1:5] AS sample_users,
                    COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)::int AS users_affected,
                    (ARRAY_AGG(details ORDER BY created_at DESC) FILTER (WHERE details IS NOT NULL))[1] AS latest_details,
                    (ARRAY_AGG(id ORDER BY created_at DESC))[1] AS latest_id
                FROM signed
                GROUP BY signature
            )
            SELECT *
            FROM grouped
            ORDER BY
                CASE level WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                occurrences DESC,
                last_seen DESC
            LIMIT $3;
        `;

        const { rows } = await pool.query(sql, [since, levels, limit]);

        const totalSql = `
            SELECT
                level,
                COUNT(*)::int AS count
            FROM system_audit_logs
            WHERE created_at >= $1
              AND level = ANY($2::text[])
            GROUP BY level;
        `;
        const totals = await pool.query(totalSql, [since, levels]);
        const totalsByLevel = Object.fromEntries(totals.rows.map(r => [r.level, r.count]));

        res.json({
            window: { hours, since },
            levels,
            totals: totalsByLevel,
            unique_signatures: rows.length,
            groups: rows,
            generated_at: new Date().toISOString(),
        });
    } catch (err) {
        console.error('errors-digest failed:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
