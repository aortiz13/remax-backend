import { Router } from 'express';
import Retell from 'retell-sdk';
import pool from '../lib/db.js';
import authMiddleware from '../middleware/auth.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';
import { executeTool } from '../llm/wsHandler.js';

const router = Router();

// ── Retell webhook (HMAC optional — log mismatch but don't block) ──────────
router.post('/webhook', async (req, res) => {
    const secret = process.env.RETELL_WEBHOOK_SECRET;
    if (secret) {
        const sig = req.headers['x-retell-signature'];
        if (sig && req.rawBody && !Retell.verify(req.rawBody, secret, sig)) {
            logErrorToSlack('warning', { category: 'voice-agent', action: 'webhook.sig_mismatch', message: 'Retell signature mismatch — check RETELL_WEBHOOK_SECRET in EasyPanel' });
        }
    }

    const { event, call } = req.body;
    res.json({ received: true }); // Respond immediately so Retell doesn't timeout

    try {
        if (event === 'call_started') {
            await pool.query(
                `INSERT INTO voice_calls (retell_call_id, direction, from_phone, to_phone, status, created_at)
                 VALUES ($1, $2, $3, $4, 'ongoing', $5)
                 ON CONFLICT (retell_call_id) DO NOTHING`,
                [
                    call.call_id,
                    call.call_type === 'phone_call' ? 'inbound' : 'outbound',
                    call.from_number,
                    call.to_number,
                    call.start_timestamp ? new Date(call.start_timestamp).toISOString() : new Date().toISOString()
                ]
            );
        }

        if (event === 'call_ended') {
            await pool.query(
                `UPDATE voice_calls SET
                    status = $2,
                    duration_seconds = $3,
                    recording_url = $4,
                    transcript = $5,
                    ended_at = $6,
                    updated_at = NOW()
                 WHERE retell_call_id = $1`,
                [
                    call.call_id,
                    call.call_status === 'ended' ? 'completed' : 'failed',
                    call.duration_ms ? Math.round(call.duration_ms / 1000) : null,
                    call.recording_url || null,
                    call.transcript || null,
                    call.end_timestamp ? new Date(call.end_timestamp).toISOString() : new Date().toISOString()
                ]
            );

            // If this was a campaign contact call, update its status
            if (call.metadata?.contact_id) {
                await pool.query(
                    `UPDATE campaign_contacts SET call_status = 'called',
                        call_id = (SELECT id FROM voice_calls WHERE retell_call_id = $1)
                     WHERE id = $2`,
                    [call.call_id, call.metadata.contact_id]
                );
            }
        }

        if (event === 'call_analyzed') {
            const analysis = call.call_analysis || {};
            await pool.query(
                `UPDATE voice_calls SET
                    summary = $2,
                    sentiment = $3,
                    updated_at = NOW()
                 WHERE retell_call_id = $1`,
                [
                    call.call_id,
                    analysis.call_summary || null,
                    analysis.user_sentiment?.toLowerCase() || null
                ]
            );
        }
    } catch (err) {
        logErrorToSlack('error', { category: 'voice-agent', action: `webhook.${event}`, message: err.message });
    }
});

// ── Dashboard API (protected by user JWT) ──────────────────────────────────

// GET /api/voice/metrics
router.get('/metrics', authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
                COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                ROUND(AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL))::int AS avg_duration,
                json_object_agg(s.sentiment, s.cnt) FILTER (WHERE s.sentiment IS NOT NULL) AS sentiments,
                json_object_agg(i.intent, i.cnt) FILTER (WHERE i.intent IS NOT NULL) AS intents
            FROM voice_calls,
                LATERAL (SELECT sentiment, COUNT(*)::int AS cnt FROM voice_calls WHERE sentiment IS NOT NULL GROUP BY sentiment) s,
                LATERAL (SELECT intent, COUNT(*)::int AS cnt FROM voice_calls WHERE intent IS NOT NULL GROUP BY intent) i
        `);
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/voice/calls
router.get('/calls', authMiddleware, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1'));
        const limit = Math.min(50, parseInt(req.query.limit || '20'));
        const offset = (page - 1) * limit;
        const conditions = [];
        const params = [];

        if (req.query.direction) { conditions.push(`direction = $${params.push(req.query.direction)}`); }
        if (req.query.status) { conditions.push(`status = $${params.push(req.query.status)}`); }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const { rows: calls } = await pool.query(
            `SELECT * FROM voice_calls ${where} ORDER BY created_at DESC LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}`,
            params
        );
        const { rows: [{ total }] } = await pool.query(`SELECT COUNT(*)::int AS total FROM voice_calls ${where}`, params.slice(0, -2));

        res.json({ data: calls, total, page, limit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/voice/calls/:id
router.get('/calls/:id', authMiddleware, async (req, res) => {
    try {
        const { rows: [call] } = await pool.query('SELECT * FROM voice_calls WHERE id = $1', [req.params.id]);
        if (!call) return res.status(404).json({ error: 'Not found' });

        const { rows: leads } = await pool.query('SELECT * FROM call_leads WHERE call_id = $1', [req.params.id]);
        const { rows: actions } = await pool.query('SELECT * FROM call_actions WHERE call_id = $1 ORDER BY created_at', [req.params.id]);

        res.json({ ...call, call_leads: leads, call_actions: actions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/voice/tool — Retell LLM custom tool callback (no HMAC — retell-llm uses different auth)
router.post('/tool', async (req, res) => {
    const rawBody = req.body;
    console.log('[voice/tool] FULL BODY:', JSON.stringify(rawBody, null, 2));

    const { call, name: toolName, args = {} } = rawBody;
    const callId = call?.call_id || null;

    console.log(`[voice/tool] tool="${toolName}" call_id="${callId}" args=${JSON.stringify(args)}`);

    if (!toolName) {
        console.log('[voice/tool] ERROR: missing tool name');
        return res.status(400).json({ result: 'Missing tool name' });
    }

    try {
        const outcome = await executeTool(toolName, args, callId);
        console.log(`[voice/tool] outcome for "${toolName}":`, JSON.stringify(outcome));
        const message = outcome.success
            ? toolResultMessage(toolName, args)
            : `No se pudo completar la acción: ${outcome.error || 'error desconocido'}`;
        res.json({ result: message });
    } catch (err) {
        console.log(`[voice/tool] EXCEPTION for "${toolName}":`, err.message, err.stack);
        logErrorToSlack('error', { category: 'voice-agent', action: `tool.${toolName}`, message: err.message });
        res.status(500).json({ result: 'Error al ejecutar la acción' });
    }
});

function toolResultMessage(toolName, args) {
    switch (toolName) {
        case 'captureLead': return `Lead guardado: ${args.name || ''} (${args.operation_type || ''})`;
        case 'sendWhatsAppToRemax': return 'WhatsApp enviado al equipo de RE/MAX';
        case 'sendWhatsAppToClient': return 'WhatsApp de confirmación enviado al cliente';
        case 'sendEmail': return 'Email enviado al equipo de RE/MAX';
        case 'transferToHuman': return 'Transfiriendo a agente humano';
        default: return 'Acción completada';
    }
}

export default router;
