import pool from './db.js';

const MESES_ES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const DEFAULT_TZ = 'America/Santiago';

function partsOf(date, tz) {
    const fmt = new Intl.DateTimeFormat('es-CL', {
        timeZone: tz,
        day: '2-digit',
        month: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = {};
    for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
    return parts;
}

export function formatEventDateEs(date, { tz = DEFAULT_TZ, mode = 'fecha_y_hora' } = {}) {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';

    const p = partsOf(d, tz);
    const dia = p.day || '';
    const mes = MESES_ES[parseInt(p.month || '1', 10) - 1] || '';
    const anio = p.year || '';
    const hora = p.hour || '';
    const minutos = p.minute || '';

    switch (mode) {
        case 'fecha':
            return `${dia} de ${mes}`;
        case 'fecha_larga':
            return `${dia} de ${mes} de ${anio}`;
        case 'hora':
            return `${hora}:${minutos} hs`;
        case 'fecha_y_hora':
        default:
            return `${dia} de ${mes} a las ${hora}:${minutos} hs`;
    }
}

export async function findNextEventByTitle(title) {
    if (!title || !title.trim()) return null;
    const cleanedTitle = title.trim();

    const { rows } = await pool.query(
        `
        WITH next_events AS (
            SELECT title AS title,
                   execution_date,
                   end_date,
                   location,
                   'recruitment_tasks'::text AS source
              FROM recruitment_tasks
             WHERE LOWER(title) = LOWER($1)
               AND execution_date >= NOW()
               AND (completed IS NULL OR completed = false)
            UNION ALL
            SELECT action AS title,
                   execution_date,
                   end_date,
                   location,
                   'crm_tasks'::text AS source
              FROM crm_tasks
             WHERE LOWER(action) = LOWER($1)
               AND execution_date >= NOW()
               AND (completed IS NULL OR completed = false)
        )
        SELECT * FROM next_events
        ORDER BY execution_date ASC
        LIMIT 1
        `,
        [cleanedTitle],
    );

    if (rows.length === 0) {
        const fallback = await pool.query(
            `
            WITH past_events AS (
                SELECT title AS title, execution_date, end_date, location
                  FROM recruitment_tasks
                 WHERE LOWER(title) = LOWER($1)
                UNION ALL
                SELECT action AS title, execution_date, end_date, location
                  FROM crm_tasks
                 WHERE LOWER(action) = LOWER($1)
            )
            SELECT * FROM past_events
            ORDER BY execution_date DESC
            LIMIT 1
            `,
            [cleanedTitle],
        );
        return fallback.rows[0] || null;
    }

    return rows[0];
}

export async function listUpcomingEventTitles({ limit = 50, agentId = null } = {}) {
    const { rows } = await pool.query(
        `
        WITH upcoming AS (
            SELECT title AS title, MIN(execution_date) AS next_at, MAX(location) AS location
              FROM recruitment_tasks
             WHERE execution_date >= NOW()
               AND title IS NOT NULL AND title <> ''
             GROUP BY title
            UNION ALL
            SELECT action AS title, MIN(execution_date) AS next_at, MAX(location) AS location
              FROM crm_tasks
             WHERE execution_date >= NOW()
               AND action IS NOT NULL AND action <> ''
               AND ($1::uuid IS NULL OR agent_id = $1::uuid)
             GROUP BY action
        )
        SELECT title, MIN(next_at) AS next_at, MAX(location) AS location
          FROM upcoming
         GROUP BY title
         ORDER BY MIN(next_at) ASC
         LIMIT $2
        `,
        [agentId, limit],
    );
    return rows;
}

const EVENT_VAR_RE = /\{\{\s*evento\s*:\s*([^|{}:]+?)(?:\s*:\s*([a-zA-Z_]+))?\s*\}\}/g;

export async function resolveCalendarEventVars(text) {
    if (!text || typeof text !== 'string') return text || '';
    if (!text.includes('{{')) return text;

    const matches = [];
    let m;
    EVENT_VAR_RE.lastIndex = 0;
    while ((m = EVENT_VAR_RE.exec(text)) !== null) {
        matches.push({ full: m[0], title: m[1].trim(), mode: (m[2] || 'fecha_y_hora').trim().toLowerCase() });
    }
    if (matches.length === 0) return text;

    const uniqueTitles = [...new Set(matches.map(x => x.title.toLowerCase()))];
    const eventByTitle = new Map();
    await Promise.all(uniqueTitles.map(async (t) => {
        const ev = await findNextEventByTitle(t);
        eventByTitle.set(t, ev);
    }));

    let out = text;
    for (const match of matches) {
        const ev = eventByTitle.get(match.title.toLowerCase());
        let value = '';
        if (ev) {
            if (match.mode === 'ubicacion') {
                value = ev.location || '';
            } else {
                value = formatEventDateEs(ev.execution_date, { mode: match.mode });
            }
        }
        out = out.split(match.full).join(value);
    }
    return out;
}
