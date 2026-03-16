import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

const router = Router();

// POST /api/invite/agent — Invite agent by email
router.post('/agent', authMiddleware, async (req, res) => {
    try {
        const adminId = req.user.id;

        // Verify admin role
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .eq('id', adminId)
            .single();

        if (!profile || !['admin', 'superadministrador'].includes(profile.role)) {
            return res.status(403).json({ error: 'Forbidden: Admin only' });
        }

        const { email, firstName, lastName, role } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const assignedRole = (role === 'admin') ? 'admin' : 'agent';
        const origin = req.headers.origin || 'https://solicitudes.remax-exclusive.cl';
        const redirectTo = `${origin}/update-password`;

        const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
            data: { first_name: firstName, last_name: lastName, role: assignedRole },
            redirectTo,
        });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'invite.agent', message: error.message,
            module: 'invite', details: { email: req.body?.email },
        });
        res.status(400).json({ error: error.message });
    }
});

export default router;
