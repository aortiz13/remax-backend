import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

const router = Router();

// POST /api/admin/action — Admin actions (role changes, etc.)
router.post('/action', authMiddleware, async (req, res) => {
    try {
        const adminId = req.user.id;

        // Verify admin role
        const { data: adminProfile } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .eq('id', adminId)
            .single();

        if (!adminProfile || !['admin', 'superadministrador', 'comercial', 'legal', 'tecnico'].includes(adminProfile.role)) {
            return res.status(403).json({ error: 'Forbidden: Admin only' });
        }

        const { action, userId, data: actionData } = req.body;

        switch (action) {
            case 'update_role': {
                const { role } = actionData;
                await supabaseAdmin.from('profiles').update({ role }).eq('id', userId);
                return res.json({ success: true });
            }
            case 'disable_user': {
                await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: '876000h' });
                await supabaseAdmin.from('profiles').update({ active: false }).eq('id', userId);
                return res.json({ success: true });
            }
            case 'enable_user': {
                await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: 'none' });
                await supabaseAdmin.from('profiles').update({ active: true }).eq('id', userId);
                return res.json({ success: true });
            }
            case 'delete':
            case 'delete_user': {
                // Delete profile first (cascade), then auth user
                await supabaseAdmin.from('profiles').delete().eq('id', userId);
                await supabaseAdmin.auth.admin.deleteUser(userId);
                return res.json({ success: true });
            }
            default:
                return res.status(400).json({ error: `Unknown action: ${action}` });
        }
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'admin.action', message: error.message,
            module: 'admin', details: { body: req.body },
        });
        res.status(400).json({ error: error.message });
    }
});

export default router;
