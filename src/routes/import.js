import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { importQueue } from '../queues/index.js';

const router = Router();

// POST /api/import/remax-listings — Trigger RE/MAX listings import
router.post('/remax-listings', authMiddleware, async (req, res) => {
    try {
        const { officeId, agentMlsId } = req.body;

        await importQueue.add('import-remax-listings', {
            officeId,
            agentMlsId,
            triggeredBy: req.user.id,
        }, {
            attempts: 2,
            backoff: { type: 'exponential', delay: 10000 },
        });

        res.json({ success: true, message: 'Import job queued' });
    } catch (error) {
        console.error('Import error:', error);
        res.status(400).json({ error: error.message });
    }
});

export default router;
