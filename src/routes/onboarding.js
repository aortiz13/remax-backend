import express from 'express';
import pool from '../lib/db.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';
import crypto from 'crypto';

const router = express.Router();

// GET /api/onboarding/:token — Get form data (public, no auth)
router.get('/:token', async (req, res) => {
    try {
        const { token } = req.params;

        const result = await pool.query(
            `SELECT o.*, c.first_name, c.last_name, c.email, c.phone, c.rut
             FROM recruitment_onboarding o
             LEFT JOIN recruitment_candidates c ON o.candidate_id = c.id
             WHERE o.token = $1`,
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Formulario no encontrado o enlace expirado' });
        }

        const record = result.rows[0];

        if (record.status === 'submitted') {
            return res.json({ alreadySubmitted: true });
        }

        // Pre-fill with candidate data if available
        res.json({
            alreadySubmitted: false,
            prefill: {
                full_name: record.full_name || `${record.first_name || ''} ${record.last_name || ''}`.trim(),
                rut: record.rut || record.rut || '',
                contact_email: record.contact_email || record.email || '',
                phone: record.phone || record.phone || '',
            },
        });
    } catch (error) {
        logErrorToSlack('error', { category: 'backend', action: 'onboarding.get', message: error.message, module: 'onboarding' });
        res.status(500).json({ error: 'Error interno' });
    }
});

// POST /api/onboarding/:token — Submit form (public, no auth)
router.post('/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const {
            full_name, rut, birth_date, marital_status, address,
            contact_email, phone, company, job_title, education_level
        } = req.body;

        // Validate token
        const existing = await pool.query(
            `SELECT id, candidate_id, status FROM recruitment_onboarding WHERE token = $1`,
            [token]
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Formulario no encontrado' });
        }

        if (existing.rows[0].status === 'submitted') {
            return res.status(400).json({ error: 'Este formulario ya fue enviado' });
        }

        const record = existing.rows[0];

        // Update onboarding record
        await pool.query(`
            UPDATE recruitment_onboarding SET
                full_name = $1, rut = $2, birth_date = $3, marital_status = $4,
                address = $5, contact_email = $6, phone = $7, company = $8,
                job_title = $9, education_level = $10, status = 'submitted',
                submitted_at = NOW()
            WHERE token = $11
        `, [full_name, rut, birth_date, marital_status, address,
            contact_email, phone, company, job_title, education_level, token]);

        // Also update candidate record with new info
        if (record.candidate_id) {
            await pool.query(`
                UPDATE recruitment_candidates SET
                    rut = COALESCE($1, rut),
                    phone = COALESCE($2, phone),
                    email = COALESCE($3, email),
                    address = COALESCE($4, address),
                    updated_at = NOW()
                WHERE id = $5
            `, [rut, phone, contact_email, address, record.candidate_id]);
        }

        // Send notification to Jose Miguel Raidis and postulante role
        try {
            // Find Jose Miguel Raidis
            const { data: joseUser } = await supabaseAdmin
                .from('profiles')
                .select('id, first_name, last_name')
                .or('first_name.ilike.%Jose Miguel%,last_name.ilike.%Raidis%')
                .limit(1)
                .single();

            // Find users with 'postulante' role (if any)
            const { data: postulantes } = await supabaseAdmin
                .from('profiles')
                .select('id')
                .eq('role', 'postulante');

            const notifyIds = new Set();
            if (joseUser?.id) notifyIds.add(joseUser.id);
            if (postulantes) postulantes.forEach(p => notifyIds.add(p.id));

            // Also notify superadministrador
            const { data: admins } = await supabaseAdmin
                .from('profiles')
                .select('id')
                .eq('role', 'superadministrador');
            if (admins) admins.forEach(a => notifyIds.add(a.id));

            // Insert notifications
            for (const userId of notifyIds) {
                await supabaseAdmin.from('notifications').insert({
                    user_id: userId,
                    type: 'onboarding_completed',
                    title: '📋 Formulario de ingreso completado',
                    message: `${full_name} ha completado su formulario de solicitud de ingreso.`,
                    data: { onboarding_id: record.id, candidate_id: record.candidate_id, name: full_name },
                });
            }

            // Log to Slack
            logErrorToSlack('info', {
                category: 'recruitment',
                action: 'onboarding.submitted',
                message: `✅ ${full_name} completó formulario de ingreso`,
                module: 'onboarding',
                details: { name: full_name, email: contact_email, phone },
            });
        } catch (notifyErr) {
            console.error('Notification error:', notifyErr.message);
        }

        res.json({ success: true, message: 'Formulario enviado exitosamente' });
    } catch (error) {
        logErrorToSlack('error', { category: 'backend', action: 'onboarding.submit', message: error.message, module: 'onboarding' });
        res.status(500).json({ error: 'Error al enviar formulario' });
    }
});

// POST /api/onboarding/generate — Generate a new onboarding link (auth required, internal)
router.post('/generate', async (req, res) => {
    try {
        const { candidateId } = req.body;
        if (!candidateId) return res.status(400).json({ error: 'candidateId required' });

        const token = crypto.randomBytes(16).toString('hex');

        // Get candidate info to pre-fill
        const { rows: [candidate] } = await pool.query(
            `SELECT first_name, last_name, email, phone, rut FROM recruitment_candidates WHERE id = $1`,
            [candidateId]
        );

        await pool.query(`
            INSERT INTO recruitment_onboarding (candidate_id, token, full_name, contact_email, phone, rut)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (token) DO NOTHING
        `, [
            candidateId,
            token,
            candidate ? `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() : null,
            candidate?.email,
            candidate?.phone,
            candidate?.rut,
        ]);

        const formUrl = `https://solicitudes.remax-exclusive.cl/ingreso/${token}`;

        res.json({ success: true, token, url: formUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
