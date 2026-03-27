import { Router } from 'express';
import pool from '../lib/db.js';

const router = Router();

// ─── GET /pending-reports ────────────────────────────────────────────
// Returns all shift_guard_leads with agent + contact (basic).
// Used by n8n "HTTP Request" node (8am flow).
// Query param ?include=activities,tasks adds nested arrays (12pm flow).
router.get('/pending-reports', async (req, res) => {
    try {
        const includeExtras = (req.query.include || '').split(',');
        const wantActivities = includeExtras.includes('activities');
        const wantTasks = includeExtras.includes('tasks');

        const baseFields = `
            sgl.*,
            json_build_object(
                'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
                'email', p.email, 'phone', p.phone
            ) AS agent,
            json_build_object(
                'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name,
                'phone', c.phone, 'email', c.email, 'status', c.status,
                'need', c.need, 'observations', c.observations
                ${wantActivities || wantTasks ? `, 'source', c.source` : ''}
                ${wantActivities ? `,
                'activities', COALESCE((
                    SELECT json_agg(json_build_object(
                        'id', ca.id, 'type', ca.type,
                        'description', ca.description, 'created_at', ca.created_at
                    ) ORDER BY ca.created_at DESC)
                    FROM contact_activities ca WHERE ca.contact_id = c.id
                ), '[]'::json)` : ''}
                ${wantTasks ? `,
                'tasks', COALESCE((
                    SELECT json_agg(json_build_object(
                        'id', t.id, 'action', t.action,
                        'description', t.description, 'completed', t.completed,
                        'execution_date', t.execution_date
                    ) ORDER BY t.execution_date DESC)
                    FROM crm_tasks t WHERE t.contact_id = c.id
                ), '[]'::json)` : ''}
            ) AS contact
        `;

        const query = `
            SELECT ${baseFields}
            FROM shift_guard_leads sgl
            LEFT JOIN profiles p ON sgl.agent_id = p.id
            LEFT JOIN contacts c ON sgl.contact_id = c.id
        `;

        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        console.error('❌ guard-leads/pending-reports error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── PATCH /:id/mark-report-sent ─────────────────────────────────────
// Marks a milestone report as sent.
// Body: { "report_2d_sent": true, "report_2d_sent_at": "..." }
router.patch('/:id/mark-report-sent', async (req, res) => {
    try {
        const { id } = req.params;
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

        // Build dynamic SET clause from body keys
        const keys = Object.keys(body);
        if (!keys.length) return res.status(400).json({ error: 'Empty body' });

        const setClauses = keys.map((k, i) => `"${k}" = $${i + 2}`);
        const values = keys.map(k => body[k]);

        await pool.query(
            `UPDATE shift_guard_leads SET ${setClauses.join(', ')} WHERE id = $1`,
            [id, ...values]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('❌ guard-leads/mark-report-sent error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /profiles/by-email ──────────────────────────────────────────
// Finds a profile by email. Returns an array (Supabase REST compatible).
router.get('/profiles/by-email', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: 'email query param required' });

        const { rows } = await pool.query(
            `SELECT id, first_name, last_name, phone, email FROM profiles WHERE email = $1`,
            [email]
        );

        res.json(rows);
    } catch (err) {
        console.error('❌ guard-leads/profiles/by-email error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

export default router;
