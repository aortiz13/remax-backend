import pool from '../lib/db.js';

// Builds a grouped digest of recent system_audit_logs entries.
// Shared between the HTTP endpoint (pull) and the cron push to the
// claude.ai rutina, so signature semantics stay identical.
export async function buildErrorDigest({ hours = 24, levels = ['error', 'warning'], limit = 30 } = {}) {
    const cappedHours = Math.min(hours, 24 * 14);
    const cappedLimit = Math.min(limit, 100);
    const since = new Date(Date.now() - cappedHours * 60 * 60 * 1000).toISOString();

    const sql = `
        WITH recent AS (
            SELECT id, created_at, level, category, action, module, message,
                   path, user_id, user_email, user_name, error_code, details
            FROM system_audit_logs
            WHERE created_at >= $1
              AND level = ANY($2::text[])
        ),
        signed AS (
            SELECT *,
                concat_ws('|', level, COALESCE(category,''), COALESCE(action,''),
                          COALESCE(module,''), substr(COALESCE(message,''),1,120)) AS signature
            FROM recent
        ),
        grouped AS (
            SELECT signature,
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
        ORDER BY CASE level WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 occurrences DESC,
                 last_seen DESC
        LIMIT $3;
    `;

    const { rows } = await pool.query(sql, [since, levels, cappedLimit]);

    const totalsSql = `
        SELECT level, COUNT(*)::int AS count
        FROM system_audit_logs
        WHERE created_at >= $1
          AND level = ANY($2::text[])
        GROUP BY level;
    `;
    const totals = await pool.query(totalsSql, [since, levels]);
    const totalsByLevel = Object.fromEntries(totals.rows.map(r => [r.level, r.count]));

    return {
        window: { hours: cappedHours, since },
        levels,
        totals: totalsByLevel,
        unique_signatures: rows.length,
        groups: rows,
        generated_at: new Date().toISOString(),
    };
}

// Posts a digest produced by buildErrorDigest to the claude.ai rutina trigger.
// Used by the daily cron and the manual trigger endpoint.
// Returns { ok, skipped, status } — never leaks the URL / token to callers.
export async function pushDigestToRutina(digest) {
    const url = process.env.TRIAGE_RUTINA_URL;
    const token = process.env.TRIAGE_RUTINA_TOKEN;

    if (!url) {
        return { ok: false, skipped: true, status: null, reason: 'not_configured' };
    }
    if (!digest || digest.unique_signatures === 0) {
        return { ok: true, skipped: true, status: null, reason: 'empty_digest' };
    }

    // Claude Code routines /fire API accepts a single freeform `text`
    // field (≤65,536 chars). The routine prompt parses the JSON inside.
    const payload = JSON.stringify({ digest });
    const text = payload.length > 65000
        ? payload.slice(0, 65000) + '\n... [truncated]'
        : payload;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'experimental-cc-routine-2026-04-01',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`rutina trigger HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    return { ok: true, skipped: false, status: res.status };
}
