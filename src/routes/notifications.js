import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { notificationQueue } from '../queues/index.js';

const router = Router();

// POST /api/notifications/send — Queue a push notification
router.post('/send', authMiddleware, async (req, res) => {
    try {
        await notificationQueue.add('send-notification', req.body, {
            attempts: 3, backoff: { type: 'exponential', delay: 2000 },
        });
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
