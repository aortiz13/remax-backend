import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { importQueue } from '../queues/index.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

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
        logErrorToSlack('error', {
            category: 'backend', action: 'import.remax_listings', message: error.message,
            module: 'import',
        });
        res.status(400).json({ error: error.message });
    }
});

export default router;
