/**
 * Meeting Bot API Routes
 * Endpoints for sending bots to meetings and tracking their status
 */
import express from 'express';
import { Queue } from 'bullmq';
import pool from '../lib/db.js';
import { redisConnection } from '../lib/redis.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

// BullMQ queue for meeting bot jobs
const meetingBotQueue = new Queue('meeting-bot', { connection: redisConnection });

// ─── Platform detection ───────────────────────────────────────────
const PLATFORM_PATTERNS = [
    { platform: 'google_meet', patterns: [/meet\.google\.com\//i] },
    { platform: 'zoom', patterns: [/zoom\.us\/[jsmw]/i, /app\.zoom\.us/i] },
    { platform: 'teams', patterns: [/teams\.microsoft\.com/i, /teams\.live\.com/i] },
];

function detectPlatform(url) {
    if (!url) return null;
    for (const { platform, patterns } of PLATFORM_PATTERNS) {
        for (const p of patterns) {
            if (p.test(url)) return platform;
        }
    }
    return null;
}

const PLATFORM_LABELS = {
    google_meet: 'Google Meet',
    zoom: 'Zoom',
    teams: 'Microsoft Teams',
};

// ─── POST /api/meeting-bot/send — Send bot to a meeting ───────────
router.post('/send', async (req, res) => {
    try {
        const { meeting_url, candidate_id, bot_name } = req.body;
        const userId = req.user.id || req.user.sub;

        if (!meeting_url) {
            return res.status(400).json({ error: 'meeting_url is required' });
        }

        // Detect platform
        const platform = detectPlatform(meeting_url);
        if (!platform) {
            return res.status(400).json({
                error: 'URL no reconocida. Debe ser un link de Google Meet, Zoom o Microsoft Teams.',
            });
        }

        // Check active sessions limit
        const { rows: active } = await pool.query(
            `SELECT COUNT(*) as count FROM meeting_bot_sessions
             WHERE status IN ('pending', 'joining', 'in_meeting', 'recording', 'processing', 'transcribing', 'extracting')`,
        );
        const maxConcurrent = parseInt(process.env.BOT_CONCURRENCY || '2');
        if (parseInt(active[0].count) >= maxConcurrent) {
            return res.status(429).json({
                error: `Máximo ${maxConcurrent} bots activos. Espera a que termine una sesión.`,
            });
        }

        // Create session record
        const { rows } = await pool.query(
            `INSERT INTO meeting_bot_sessions
             (requested_by, candidate_id, meeting_url, meeting_platform, bot_display_name, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')
             RETURNING *`,
            [userId, candidate_id || null, meeting_url, platform, bot_name || 'Remax Exclusive Notetaker'],
        );

        const session = rows[0];

        // Enqueue job
        await meetingBotQueue.add('join-meeting', {
            sessionId: session.id,
            meetingUrl: meeting_url,
            platform,
            candidateId: candidate_id || null,
            requestedBy: userId,
            botName: bot_name || 'Remax Exclusive Notetaker',
        }, {
            jobId: session.id,
            attempts: 1, // Don't retry — joining again would be confusing
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
        });

        console.log(`🤖 Bot sent to ${PLATFORM_LABELS[platform]} | Session: ${session.id}`);

        res.json({
            session_id: session.id,
            status: 'pending',
            platform,
            platform_label: PLATFORM_LABELS[platform],
            message: `Bot enviado a ${PLATFORM_LABELS[platform]}. Admítelo cuando aparezca como "${session.bot_display_name}".`,
        });

    } catch (err) {
        console.error('POST /meeting-bot/send error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/meeting-bot/sessions — List user's bot sessions ─────
router.get('/sessions', async (req, res) => {
    try {
        const userId = req.user.id || req.user.sub;
        const limit = parseInt(req.query.limit || '20');

        const { rows } = await pool.query(
            `SELECT
                bs.*,
                rc.first_name as candidate_first_name,
                rc.last_name as candidate_last_name,
                rm.transcript_text,
                rm.extracted_form
             FROM meeting_bot_sessions bs
             LEFT JOIN recruitment_candidates rc ON rc.id = bs.candidate_id
             LEFT JOIN recruitment_meetings rm ON rm.id = bs.meeting_id
             WHERE bs.requested_by = $1
             ORDER BY bs.created_at DESC
             LIMIT $2`,
            [userId, limit],
        );

        res.json(rows);
    } catch (err) {
        console.error('GET /meeting-bot/sessions error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/meeting-bot/sessions/:id — Session detail ───────────
router.get('/sessions/:id', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT
                bs.*,
                rc.first_name as candidate_first_name,
                rc.last_name as candidate_last_name,
                rm.transcript_text,
                rm.transcript_json,
                rm.extracted_form,
                rm.ai_summary,
                rm.recording_url as meeting_recording_url
             FROM meeting_bot_sessions bs
             LEFT JOIN recruitment_candidates rc ON rc.id = bs.candidate_id
             LEFT JOIN recruitment_meetings rm ON rm.id = bs.meeting_id
             WHERE bs.id = $1`,
            [req.params.id],
        );

        if (!rows[0]) return res.status(404).json({ error: 'Session not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('GET /meeting-bot/sessions/:id error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/meeting-bot/sessions/:id/status — Lightweight status poll ───
router.get('/sessions/:id/status', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, status, recording_duration_seconds, error_message, meeting_id, joined_at, updated_at
             FROM meeting_bot_sessions WHERE id = $1`,
            [req.params.id],
        );

        if (!rows[0]) return res.status(404).json({ error: 'Session not found' });
        
        // Calculate live duration if in_meeting
        const session = rows[0];
        if (session.status === 'in_meeting' && session.joined_at) {
            session.live_duration_seconds = Math.round((Date.now() - new Date(session.joined_at).getTime()) / 1000);
        }

        res.json(session);
    } catch (err) {
        console.error('GET /meeting-bot/sessions/:id/status error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/meeting-bot/sessions/:id/cancel — Cancel a bot ─────
router.post('/sessions/:id/cancel', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `UPDATE meeting_bot_sessions
             SET status = 'cancelled', updated_at = NOW()
             WHERE id = $1 AND status IN ('pending', 'joining')
             RETURNING *`,
            [req.params.id],
        );

        if (!rows[0]) {
            return res.status(400).json({
                error: 'No se puede cancelar. El bot ya está en la reunión o ya terminó.',
            });
        }

        // Remove from queue if pending
        try {
            const job = await meetingBotQueue.getJob(req.params.id);
            if (job) await job.remove();
        } catch { }

        res.json({ success: true, status: 'cancelled' });
    } catch (err) {
        console.error('POST /meeting-bot/sessions/:id/cancel error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/meeting-bot/detect-platform — Detect platform from URL ──
router.get('/detect-platform', (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url query param required' });

    const platform = detectPlatform(url);
    if (!platform) {
        return res.json({ platform: null, valid: false });
    }

    res.json({
        platform,
        label: PLATFORM_LABELS[platform],
        valid: true,
    });
});

export default router;
