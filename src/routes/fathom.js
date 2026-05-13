import express from 'express';
import crypto from 'crypto';
import pool from '../lib/db.js';
import authMiddleware from '../middleware/auth.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

const router = express.Router();

// ─── helpers ───────────────────────────────────────────────────────────────

const PRE_FILTRO_STAGE = 'pre_filtro';
const FATHOM_WEBHOOK_SECRET = process.env.FATHOM_WEBHOOK_SECRET || '';

function verifyFathomSignature(req) {
    if (!FATHOM_WEBHOOK_SECRET) return true;
    const provided = req.headers['x-fathom-signature'] || req.headers['x-webhook-signature'];
    if (!provided) return false;
    const expected = crypto
        .createHmac('sha256', FATHOM_WEBHOOK_SECRET)
        .update(req.rawBody || JSON.stringify(req.body))
        .digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch {
        return false;
    }
}

function extractInviteeEmails(payload) {
    const emails = new Set();
    const push = (e) => { if (e && typeof e === 'string') emails.add(e.toLowerCase().trim()); };

    if (Array.isArray(payload.calendar_invitees)) {
        for (const inv of payload.calendar_invitees) {
            push(typeof inv === 'string' ? inv : inv?.email);
        }
    }
    if (Array.isArray(payload.invitees)) {
        for (const inv of payload.invitees) push(inv?.email);
    }
    if (Array.isArray(payload.transcript)) {
        for (const turn of payload.transcript) {
            push(turn?.speaker?.matched_calendar_invitee_email);
        }
    }
    return [...emails];
}

function buildTranscriptText(payload) {
    if (typeof payload.transcript === 'string') return payload.transcript;
    if (Array.isArray(payload.transcript)) {
        return payload.transcript
            .map(t => {
                const who = t?.speaker?.display_name || 'Unknown';
                const ts = t?.timestamp ? `[${t.timestamp}] ` : '';
                return `${ts}${who}: ${t?.text || ''}`;
            })
            .join('\n');
    }
    return '';
}

async function findCandidateByEmails(emails) {
    if (!emails.length) return null;
    const { rows } = await pool.query(
        `SELECT id, first_name, last_name, email, pipeline_stage
         FROM recruitment_candidates
         WHERE LOWER(email) = ANY($1::text[])
         ORDER BY (pipeline_stage = $2) DESC, updated_at DESC
         LIMIT 1`,
        [emails, PRE_FILTRO_STAGE]
    );
    return rows[0] || null;
}

async function logWebhookEvent({ eventType, fathomRecordingId, candidateId, meetingId, matchedEmail, status, errorMessage, payload }) {
    try {
        await pool.query(
            `INSERT INTO fathom_webhook_events
             (event_type, fathom_recording_id, candidate_id, meeting_id, matched_email, status, error_message, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [eventType, fathomRecordingId, candidateId, meetingId, matchedEmail, status, errorMessage, payload]
        );
    } catch (err) {
        console.error('[Fathom] Failed to log webhook event:', err.message);
    }
}

// Core ingestion: shared by webhook and backfill. Returns { status, meeting?, candidate_id?, emails }
async function ingestFathomMeeting(payload, { eventType = 'meeting_content_ready' } = {}) {
    const fathomRecordingId =
        payload.recording_id ||
        payload.id ||
        (payload.url ? payload.url.split('/').pop() : null);

    const emails = extractInviteeEmails(payload);
    const candidate = await findCandidateByEmails(emails);

    if (!candidate) {
        await logWebhookEvent({
            eventType, fathomRecordingId,
            candidateId: null, meetingId: null,
            matchedEmail: emails[0] || null,
            status: 'no_match', errorMessage: null, payload,
        });
        return { status: 'no_match', emails, fathom_recording_id: fathomRecordingId };
    }

    if (fathomRecordingId) {
        const { rows: existing } = await pool.query(
            'SELECT id FROM recruitment_meetings WHERE fathom_recording_id = $1',
            [fathomRecordingId]
        );
        if (existing[0]) {
            await logWebhookEvent({
                eventType, fathomRecordingId,
                candidateId: candidate.id, meetingId: existing[0].id,
                matchedEmail: candidate.email,
                status: 'duplicate', errorMessage: null, payload,
            });
            return { status: 'duplicate', meeting_id: existing[0].id, candidate_id: candidate.id };
        }
    }

    const transcriptText = buildTranscriptText(payload);
    const startedAt = payload.recording_start_time || payload.scheduled_start_time || payload.created_at || null;
    const endedAt = payload.recording_end_time || payload.scheduled_end_time || null;
    const durationSeconds = (startedAt && endedAt)
        ? Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000))
        : null;

    const meetingId = crypto.randomUUID();
    const { rows } = await pool.query(
        `INSERT INTO recruitment_meetings (
            id, candidate_id,
            fathom_recording_id, fathom_share_url, fathom_meeting_url,
            recording_url, recording_duration_seconds, recording_format,
            transcript_text, transcript_json,
            summary, action_items,
            meeting_type, meeting_platform, meeting_source,
            invitee_emails,
            started_at, ended_at, created_at, updated_at
         ) VALUES (
            $1, $2,
            $3, $4, $5,
            $6, $7, $8,
            $9, $10,
            $11, $12,
            $13, $14, $15,
            $16,
            $17, $18, NOW(), NOW()
         )
         RETURNING *`,
        [
            meetingId, candidate.id,
            fathomRecordingId, payload.share_url || null, payload.url || null,
            payload.share_url || payload.url || null, durationSeconds, 'fathom',
            transcriptText, JSON.stringify(payload.transcript || null),
            payload.summary || payload.ai_summary || null,
            payload.action_items ? JSON.stringify(payload.action_items) : null,
            'recruitment_interview', payload.meeting_type || 'fathom', 'fathom',
            emails,
            startedAt, endedAt,
        ]
    );

    await logWebhookEvent({
        eventType, fathomRecordingId,
        candidateId: candidate.id, meetingId,
        matchedEmail: candidate.email,
        status: 'ingested', errorMessage: null, payload,
    });

    console.log(`[Fathom] ✅ Ingested recording ${fathomRecordingId} for candidate ${candidate.id} (${candidate.email})`);
    return { status: 'ingested', meeting: rows[0], candidate_id: candidate.id };
}

// ─── POST /api/fathom/webhook ─ Ingest Fathom meeting_content_ready ────────
// IMPORTANT: this route is NOT behind authMiddleware — Fathom hits it directly.
// Mounted before `router.use(authMiddleware)` below.
router.post('/webhook', async (req, res) => {
    const payload = req.body || {};
    const eventType = payload.event_type || 'meeting_content_ready';
    const fathomRecordingId =
        payload.recording_id ||
        payload.id ||
        (payload.url ? payload.url.split('/').pop() : null);

    if (!verifyFathomSignature(req)) {
        await logWebhookEvent({
            eventType, fathomRecordingId,
            candidateId: null, meetingId: null, matchedEmail: null,
            status: 'error', errorMessage: 'invalid signature', payload,
        });
        return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
        const result = await ingestFathomMeeting(payload, { eventType });
        const httpStatus = result.status === 'no_match' ? 202 : 200;
        res.status(httpStatus).json(result);
    } catch (err) {
        console.error('[Fathom] Webhook error:', err);
        logErrorToSlack('error', {
            category: 'fathom',
            action: 'webhook.ingest_failed',
            message: err.message,
            module: 'fathom-webhook',
            details: { fathomRecordingId, stack: err.stack?.substring(0, 500) },
        });
        await logWebhookEvent({
            eventType, fathomRecordingId,
            candidateId: null, meetingId: null, matchedEmail: null,
            status: 'error', errorMessage: err.message, payload,
        });
        res.status(500).json({ error: err.message });
    }
});

// ─── Authenticated routes below ────────────────────────────────────────────
router.use(authMiddleware);

// ─── GET /api/fathom/recordings — Repository view (all Fathom meetings) ────
// Query params: stage, search, from, to, limit, offset
router.get('/recordings', async (req, res) => {
    try {
        const { stage, search, from, to } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = parseInt(req.query.offset, 10) || 0;

        const filters = [`m.meeting_source = 'fathom'`];
        const values = [];
        let idx = 1;

        if (stage) {
            filters.push(`c.pipeline_stage = $${idx++}`);
            values.push(stage);
        }
        if (search) {
            filters.push(`(
                (c.first_name || ' ' || COALESCE(c.last_name, '')) ILIKE $${idx}
                OR c.email ILIKE $${idx}
                OR m.transcript_text ILIKE $${idx}
            )`);
            values.push(`%${search}%`);
            idx++;
        }
        if (from) { filters.push(`m.started_at >= $${idx++}`); values.push(from); }
        if (to)   { filters.push(`m.started_at <= $${idx++}`); values.push(to);   }

        values.push(limit, offset);

        const { rows } = await pool.query(
            `SELECT
                m.id, m.candidate_id, m.fathom_recording_id, m.fathom_share_url, m.fathom_meeting_url,
                m.recording_duration_seconds, m.summary, m.started_at, m.ended_at, m.created_at,
                m.form_applied,
                c.first_name, c.last_name, c.email, c.pipeline_stage
             FROM recruitment_meetings m
             JOIN recruitment_candidates c ON c.id = m.candidate_id
             WHERE ${filters.join(' AND ')}
             ORDER BY m.started_at DESC NULLS LAST, m.created_at DESC
             LIMIT $${idx++} OFFSET $${idx}`,
            values
        );
        res.json(rows);
    } catch (err) {
        console.error('[Fathom] List recordings error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/fathom/backfill — Pull historic meetings from Fathom API ─────
// Body: { from?: ISO, to?: ISO, max_pages?: number }
// Requires FATHOM_API_KEY env var. Reuses ingestFathomMeeting() so the result
// looks identical to webhook ingestion (same rows, same audit log).
router.post('/backfill', async (req, res) => {
    const apiKey = process.env.FATHOM_API_KEY;
    if (!apiKey) {
        return res.status(400).json({
            error: 'FATHOM_API_KEY not configured on the server. Set it in EasyPanel (service remax-app) and redeploy.',
        });
    }

    const { from, to } = req.body || {};
    const maxPages = Math.min(parseInt(req.body?.max_pages, 10) || 20, 100);

    const stats = { total: 0, ingested: 0, duplicate: 0, no_match: 0, error: 0, pages: 0 };
    const errors = [];
    const noMatchSample = [];

    try {
        let cursor = null;
        for (let page = 0; page < maxPages; page++) {
            const url = new URL('https://api.fathom.ai/external/v1/meetings');
            url.searchParams.set('include_transcript', 'true');
            url.searchParams.set('include_summary', 'true');
            url.searchParams.set('include_action_items', 'true');
            url.searchParams.set('include_crm_matches', 'true');
            if (from)   url.searchParams.set('created_after',  new Date(from).toISOString());
            if (to)     url.searchParams.set('created_before', new Date(to).toISOString());
            if (cursor) url.searchParams.set('cursor', cursor);

            const fetchRes = await fetch(url.toString(), {
                headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
            });

            if (!fetchRes.ok) {
                const body = await fetchRes.text();
                throw new Error(`Fathom API ${fetchRes.status}: ${body.substring(0, 300)}`);
            }

            const data = await fetchRes.json();
            // Fathom may return { items: [...], next_cursor } or just an array — handle both.
            const items = Array.isArray(data) ? data : (data.items || data.meetings || data.results || []);
            cursor = data.next_cursor || data.cursor || null;
            stats.pages++;

            for (const meeting of items) {
                stats.total++;
                try {
                    const result = await ingestFathomMeeting(meeting, { eventType: 'backfill' });
                    stats[result.status] = (stats[result.status] || 0) + 1;
                    if (result.status === 'no_match' && noMatchSample.length < 10) {
                        noMatchSample.push({ emails: result.emails, recording_id: result.fathom_recording_id });
                    }
                } catch (err) {
                    stats.error++;
                    if (errors.length < 10) errors.push({ message: err.message });
                    console.error('[Fathom] Backfill ingest error:', err.message);
                }
            }

            if (!cursor || items.length === 0) break;
            // Light pacing for Fathom's 60 req/min limit.
            await new Promise(r => setTimeout(r, 250));
        }

        console.log(`[Fathom] ✅ Backfill done: ${JSON.stringify(stats)}`);
        res.json({ ...stats, errors, no_match_sample: noMatchSample });
    } catch (err) {
        console.error('[Fathom] Backfill failed:', err);
        logErrorToSlack('error', {
            category: 'fathom', action: 'backfill.failed',
            message: err.message, module: 'fathom-backfill',
        });
        res.status(500).json({ error: err.message, partial_stats: stats });
    }
});

// ─── GET /api/fathom/recordings/stats — Stats for repository header ────────
router.get('/recordings/stats', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT
                COUNT(*)::int                                                       AS total,
                COUNT(*) FILTER (WHERE c.pipeline_stage = 'pre_filtro')::int        AS pre_filtro,
                COUNT(*) FILTER (WHERE m.started_at >= NOW() - INTERVAL '7 days')::int AS last_7d,
                COUNT(DISTINCT m.candidate_id)::int                                 AS unique_candidates,
                COALESCE(SUM(m.recording_duration_seconds), 0)::int                 AS total_seconds
             FROM recruitment_meetings m
             JOIN recruitment_candidates c ON c.id = m.candidate_id
             WHERE m.meeting_source = 'fathom'`
        );
        res.json(rows[0]);
    } catch (err) {
        console.error('[Fathom] Stats error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/fathom/recordings/:id — Full detail for modal (transcript+more)
router.get('/recordings/:id', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT
                m.id, m.candidate_id, m.fathom_recording_id, m.fathom_share_url, m.fathom_meeting_url,
                m.recording_url, m.recording_duration_seconds, m.recording_format,
                m.transcript_text, m.transcript_json,
                m.summary, m.action_items, m.invitee_emails,
                m.meeting_type, m.meeting_platform, m.meeting_source,
                m.form_applied, m.form_applied_at, m.extracted_form,
                m.started_at, m.ended_at, m.created_at, m.updated_at,
                c.first_name, c.last_name, c.email, c.phone, c.pipeline_stage
             FROM recruitment_meetings m
             JOIN recruitment_candidates c ON c.id = m.candidate_id
             WHERE m.id = $1`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Recording not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('[Fathom] Recording detail error:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
