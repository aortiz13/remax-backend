import { Router } from 'express';
import { randomUUID } from 'crypto';
import authMiddleware from '../middleware/auth.js';
import pool from '../lib/db.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const API_BASE = process.env.PUBLIC_API_BASE_URL
    || 'https://remax-crm-remax-app.jzuuqr.easypanel.host';

// ─── Helpers ────────────────────────────────────────────────────────

async function getRecruitmentAccount() {
    const { rows } = await pool.query(`
        SELECT id, agent_id, email_address, access_token, refresh_token,
               calendar_id, calendar_sync_token,
               calendar_watch_channel_id, calendar_watch_resource_id, calendar_watch_expiration
        FROM gmail_accounts
        WHERE purpose = 'recruitment'
        LIMIT 1
    `);
    return rows[0] || null;
}

async function refreshAccessToken(refreshToken) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error_description || data.error);
    return data.access_token;
}

async function ensureAccessToken(account) {
    // Try refresh — Google access tokens last 1h; safer to always refresh than to track expiry.
    const accessToken = await refreshAccessToken(account.refresh_token);
    await pool.query(
        `UPDATE gmail_accounts SET access_token = $1, updated_at = NOW() WHERE id = $2`,
        [accessToken, account.id]
    );
    return accessToken;
}

function googleDateToISO(googleDate) {
    if (!googleDate) return null;
    if (googleDate.dateTime) return new Date(googleDate.dateTime).toISOString();
    if (googleDate.date) return new Date(googleDate.date + 'T00:00:00Z').toISOString();
    return null;
}

function buildEventBody(task, candidate) {
    const summary = task.title || 'Tarea de Reclutamiento';
    const description = [
        task.description || '',
        task.candidate_id ? `\n\n— Candidato: ${candidate?.first_name || ''} ${candidate?.last_name || ''}`.trim() : '',
        `\n[recruitment_task:${task.id}]`,
    ].join('').trim();

    const body = {
        summary,
        description,
        start: { dateTime: new Date(task.execution_date).toISOString() },
        end: { dateTime: new Date(task.end_date || new Date(new Date(task.execution_date).getTime() + 60 * 60000)).toISOString() },
        extendedProperties: {
            private: {
                recruitment_task_id: String(task.id),
                source: 'remax-crm',
            },
        },
    };

    if (task.location) body.location = task.location;

    if (task.send_invitation && candidate?.email) {
        body.attendees = [{ email: candidate.email, displayName: `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() }];
    }

    return body;
}

async function logActivity({ actorId, action, description, candidateId, details }) {
    if (!candidateId) return;
    try {
        await pool.query(`
            INSERT INTO activity_logs (id, actor_id, action, entity_type, entity_id, description, details)
            VALUES (gen_random_uuid(), $1, $2, 'Candidate', $3, $4, $5)
        `, [actorId || null, action, candidateId, description, details ? JSON.stringify(details) : null]);
    } catch (err) {
        logErrorToSlack('warn', {
            category: 'backend', action: 'recruitment_calendar.activity_log',
            message: err.message, module: 'recruitmentCalendar',
        });
    }
}

// ─── Push: CRM → Google Calendar ────────────────────────────────────

export async function pushTaskToGoogle(taskId, action, actorId) {
    const account = await getRecruitmentAccount();
    if (!account) throw new Error('Cuenta de reclutamiento no conectada. Conecta emprendedores@ primero.');

    const { rows: taskRows } = await pool.query(`
        SELECT t.*, c.first_name, c.last_name, c.email
        FROM recruitment_tasks t
        LEFT JOIN recruitment_candidates c ON c.id = t.candidate_id
        WHERE t.id = $1
    `, [taskId]);
    const task = taskRows[0];
    if (!task) throw new Error('Tarea no encontrada');

    const candidate = task.candidate_id
        ? { first_name: task.first_name, last_name: task.last_name, email: task.email }
        : null;

    const accessToken = await ensureAccessToken(account);
    const calendarId = encodeURIComponent(account.calendar_id || 'primary');
    const baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`;
    const sendUpdates = task.send_invitation ? 'all' : 'none';

    if (action === 'delete') {
        if (!task.google_event_id) return { success: true, skipped: 'no_google_event' };
        const url = `${baseUrl}/${task.google_event_id}?sendUpdates=${sendUpdates}`;
        const resp = await fetch(url, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
            const body = await resp.text();
            throw new Error(`Google Calendar delete failed: ${resp.status} ${body}`);
        }
        await pool.query(
            `UPDATE recruitment_tasks SET google_event_id = NULL, google_etag = NULL, last_google_sync_at = NOW() WHERE id = $1`,
            [taskId]
        );
        await logActivity({
            actorId, action: 'Calendario Sincronizado',
            description: 'Evento eliminado del Google Calendar de emprendedores@',
            candidateId: task.candidate_id,
            details: { google_event_id: task.google_event_id, direction: 'crm_to_google', op: 'delete' },
        });
        return { success: true };
    }

    const body = buildEventBody(task, candidate);
    let response, eventData;

    if (task.google_event_id) {
        const url = `${baseUrl}/${task.google_event_id}?sendUpdates=${sendUpdates}`;
        response = await fetch(url, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        // 404/410 → event was deleted on Google side; fall through to create
        if (response.status === 404 || response.status === 410) {
            await pool.query(
                `UPDATE recruitment_tasks SET google_event_id = NULL, google_etag = NULL WHERE id = $1`,
                [taskId]
            );
            response = null;
        }
    }

    if (!response) {
        const url = `${baseUrl}?sendUpdates=${sendUpdates}`;
        response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    if (response.status === 403) {
        // OAuth lacks calendar scope — disable sync state silently
        await pool.query(
            `UPDATE gmail_accounts
             SET calendar_watch_channel_id = NULL, calendar_watch_resource_id = NULL,
                 calendar_watch_expiration = NULL, calendar_sync_token = NULL
             WHERE id = $1`,
            [account.id]
        );
        return { success: false, skipped: 'insufficient_scope' };
    }
    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Google Calendar upsert failed: ${response.status} ${errBody}`);
    }
    eventData = await response.json();

    await pool.query(`
        UPDATE recruitment_tasks
        SET google_event_id = $1, google_etag = $2, last_google_sync_at = NOW()
        WHERE id = $3
    `, [eventData.id, eventData.etag, taskId]);

    await logActivity({
        actorId,
        action: 'Calendario Sincronizado',
        description: action === 'create'
            ? `Evento "${task.title}" creado en Google Calendar de emprendedores@`
            : `Evento "${task.title}" actualizado en Google Calendar de emprendedores@`,
        candidateId: task.candidate_id,
        details: {
            google_event_id: eventData.id,
            html_link: eventData.htmlLink,
            direction: 'crm_to_google',
            op: action,
            invited_candidate: !!task.send_invitation && !!candidate?.email,
        },
    });

    return { success: true, googleEventId: eventData.id, htmlLink: eventData.htmlLink };
}

// ─── Pull: Google Calendar → CRM ────────────────────────────────────

export async function syncRecruitmentCalendar(emailAddress, accessTokenOverride, { fullSync = false } = {}) {
    const account = emailAddress
        ? (await pool.query(`SELECT * FROM gmail_accounts WHERE email_address = $1 LIMIT 1`, [emailAddress])).rows[0]
        : await getRecruitmentAccount();
    if (!account) throw new Error('Cuenta de reclutamiento no conectada');

    const accessToken = accessTokenOverride || await ensureAccessToken(account);
    const calendarId = encodeURIComponent(account.calendar_id || 'primary');

    let syncToken = fullSync ? null : account.calendar_sync_token;
    let pageToken = null;
    let allEvents = [];
    let nextSyncToken = null;
    let attempt = 0;

    do {
        const params = new URLSearchParams();
        if (syncToken) {
            params.set('syncToken', syncToken);
        } else {
            const lookback = new Date();
            lookback.setDate(lookback.getDate() - 14);
            params.set('timeMin', lookback.toISOString());
            params.set('singleEvents', 'true');
            params.set('showDeleted', 'true');
        }
        params.set('maxResults', '250');
        if (pageToken) params.set('pageToken', pageToken);

        const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params.toString()}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

        if (resp.status === 410 && syncToken) {
            // syncToken expired — restart full sync
            await pool.query(`UPDATE gmail_accounts SET calendar_sync_token = NULL WHERE id = $1`, [account.id]);
            syncToken = null;
            pageToken = null;
            allEvents = [];
            attempt += 1;
            if (attempt > 1) throw new Error('Calendar sync looping on 410');
            continue;
        }
        if (resp.status === 403) {
            // Token doesn't have calendar scopes — disable sync until the
            // mailbox is reconnected with the new OAuth scopes.
            await pool.query(
                `UPDATE gmail_accounts
                 SET calendar_watch_channel_id = NULL,
                     calendar_watch_resource_id = NULL,
                     calendar_watch_expiration = NULL,
                     calendar_sync_token = NULL
                 WHERE id = $1`,
                [account.id]
            );
            return { processed: 0, created: 0, updated: 0, deleted: 0, skipped: 'insufficient_scope' };
        }
        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Calendar list failed: ${resp.status} ${body}`);
        }

        const data = await resp.json();
        allEvents = allEvents.concat(data.items || []);
        pageToken = data.nextPageToken || null;
        nextSyncToken = data.nextSyncToken || nextSyncToken;
    } while (pageToken);

    // Upsert events into recruitment_tasks
    let processed = 0, created = 0, updated = 0, deleted = 0;
    for (const ev of allEvents) {
        processed += 1;
        const recruitmentTaskId = ev.extendedProperties?.private?.recruitment_task_id;

        // Deleted events
        if (ev.status === 'cancelled') {
            const { rowCount } = await pool.query(
                `UPDATE recruitment_tasks
                 SET completed = TRUE, completed_at = NOW(), google_event_id = NULL, last_google_sync_at = NOW()
                 WHERE google_event_id = $1 OR id::text = $2`,
                [ev.id, recruitmentTaskId || '00000000-0000-0000-0000-000000000000']
            );
            if (rowCount > 0) deleted += 1;
            continue;
        }

        const startISO = googleDateToISO(ev.start);
        const endISO = googleDateToISO(ev.end);
        if (!startISO) continue;

        // Already linked to a recruitment task → update
        if (recruitmentTaskId) {
            const upd = await pool.query(`
                UPDATE recruitment_tasks
                SET title = $1, description = $2, location = $3,
                    execution_date = $4, end_date = $5,
                    google_event_id = $6, google_etag = $7, last_google_sync_at = NOW(),
                    updated_at = NOW()
                WHERE id = $8
                RETURNING id
            `, [
                ev.summary || 'Sin título',
                ev.description || null,
                ev.location || null,
                startISO,
                endISO,
                ev.id,
                ev.etag,
                recruitmentTaskId,
            ]);
            if (upd.rowCount > 0) {
                updated += 1;
                continue;
            }
        }

        // Maybe match an existing task by google_event_id
        const existing = await pool.query(
            `SELECT id, candidate_id FROM recruitment_tasks WHERE google_event_id = $1 LIMIT 1`,
            [ev.id]
        );

        if (existing.rowCount > 0) {
            await pool.query(`
                UPDATE recruitment_tasks
                SET title = $1, description = $2, location = $3,
                    execution_date = $4, end_date = $5, google_etag = $6,
                    last_google_sync_at = NOW(), updated_at = NOW()
                WHERE id = $7
            `, [
                ev.summary || 'Sin título',
                ev.description || null,
                ev.location || null,
                startISO,
                endISO,
                ev.etag,
                existing.rows[0].id,
            ]);
            updated += 1;
            continue;
        }

        // New external event — try to match candidate by attendee email
        let candidateId = null;
        const attendeeEmails = (ev.attendees || []).map(a => a.email?.toLowerCase()).filter(Boolean);
        if (attendeeEmails.length > 0) {
            const candRes = await pool.query(
                `SELECT id FROM recruitment_candidates WHERE LOWER(email) = ANY($1::text[]) LIMIT 1`,
                [attendeeEmails]
            );
            candidateId = candRes.rows[0]?.id || null;
        }

        const ins = await pool.query(`
            INSERT INTO recruitment_tasks (
                id, title, description, location,
                execution_date, end_date, task_type, priority,
                candidate_id, assigned_to, google_event_id, google_etag,
                is_external, last_google_sync_at, created_at, updated_at
            ) VALUES (
                gen_random_uuid(), $1, $2, $3, $4, $5, 'Reunión', 'media',
                $6, $7, $8, $9, TRUE, NOW(), NOW(), NOW()
            ) RETURNING id
        `, [
            ev.summary || 'Sin título',
            ev.description || null,
            ev.location || null,
            startISO,
            endISO,
            candidateId,
            account.agent_id,
            ev.id,
            ev.etag,
        ]);
        created += 1;

        if (candidateId) {
            await logActivity({
                actorId: null,
                action: 'Calendario Sincronizado',
                description: `Evento "${ev.summary}" importado desde Google Calendar`,
                candidateId,
                details: { google_event_id: ev.id, html_link: ev.htmlLink, direction: 'google_to_crm', op: 'create' },
            });
        }
    }

    if (nextSyncToken) {
        await pool.query(
            `UPDATE gmail_accounts SET calendar_sync_token = $1 WHERE id = $2`,
            [nextSyncToken, account.id]
        );
    }

    return { processed, created, updated, deleted };
}

// ─── Watch: real-time push notifications ────────────────────────────

export async function setupRecruitmentCalendarWatch(emailAddress, accessTokenOverride) {
    const account = emailAddress
        ? (await pool.query(`SELECT * FROM gmail_accounts WHERE email_address = $1 LIMIT 1`, [emailAddress])).rows[0]
        : await getRecruitmentAccount();
    if (!account) throw new Error('Cuenta de reclutamiento no conectada');

    const accessToken = accessTokenOverride || await ensureAccessToken(account);
    const calendarId = encodeURIComponent(account.calendar_id || 'primary');

    // Stop previous channel if any
    if (account.calendar_watch_channel_id && account.calendar_watch_resource_id) {
        try {
            await fetch('https://www.googleapis.com/calendar/v3/channels/stop', {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: account.calendar_watch_channel_id,
                    resourceId: account.calendar_watch_resource_id,
                }),
            });
        } catch { /* best effort */ }
    }

    const channelId = randomUUID();
    const watchResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/watch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: channelId,
            type: 'web_hook',
            address: `${API_BASE}/api/webhooks/recruitment-calendar`,
            token: account.id,
        }),
    });

    if (watchResp.status === 403) {
        return { skipped: 'insufficient_scope' };
    }
    if (!watchResp.ok) {
        const body = await watchResp.text();
        throw new Error(`Calendar watch failed: ${watchResp.status} ${body}`);
    }
    const watch = await watchResp.json();

    await pool.query(`
        UPDATE gmail_accounts
        SET calendar_watch_channel_id = $1,
            calendar_watch_resource_id = $2,
            calendar_watch_expiration = $3,
            updated_at = NOW()
        WHERE id = $4
    `, [
        watch.id,
        watch.resourceId,
        watch.expiration ? new Date(parseInt(watch.expiration, 10)).toISOString() : null,
        account.id,
    ]);

    return { channelId: watch.id, expiration: watch.expiration };
}

// ─── HTTP Endpoints ─────────────────────────────────────────────────

// GET /api/recruitment-calendar/status — Check connection state
router.get('/status', authMiddleware, async (req, res) => {
    try {
        const account = await getRecruitmentAccount();
        if (!account) {
            return res.json({ connected: false });
        }
        res.json({
            connected: true,
            email: account.email_address,
            calendarId: account.calendar_id || 'primary',
            hasSyncToken: !!account.calendar_sync_token,
            watchActive: !!account.calendar_watch_channel_id,
            watchExpiresAt: account.calendar_watch_expiration,
        });
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'recruitment_calendar.status', message: error.message,
            module: 'recruitmentCalendar',
        });
        res.status(400).json({ error: error.message });
    }
});

// POST /api/recruitment-calendar/push — Push a recruitment_task to Google Calendar
router.post('/push', authMiddleware, async (req, res) => {
    try {
        const { taskId, action } = req.body;
        if (!taskId || !action) return res.status(400).json({ error: 'Missing taskId or action' });
        if (!['create', 'update', 'delete'].includes(action)) {
            return res.status(400).json({ error: 'Invalid action' });
        }
        const result = await pushTaskToGoogle(taskId, action, req.user.id);
        res.json(result);
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'recruitment_calendar.push', message: error.message,
            module: 'recruitmentCalendar',
        });
        res.status(400).json({ error: error.message });
    }
});

// POST /api/recruitment-calendar/sync — Pull events from Google Calendar
router.post('/sync', authMiddleware, async (req, res) => {
    try {
        const fullSync = !!req.body?.fullSync;
        const result = await syncRecruitmentCalendar(null, null, { fullSync });
        res.json({ success: true, ...result });
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'recruitment_calendar.sync', message: error.message,
            module: 'recruitmentCalendar',
        });
        res.status(400).json({ error: error.message });
    }
});

// POST /api/recruitment-calendar/watch — (Re)create the push notification channel
router.post('/watch', authMiddleware, async (req, res) => {
    try {
        const result = await setupRecruitmentCalendarWatch();
        res.json({ success: true, ...result });
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'recruitment_calendar.watch', message: error.message,
            module: 'recruitmentCalendar',
        });
        res.status(400).json({ error: error.message });
    }
});

export default router;
