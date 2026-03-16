import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { notificationQueue, slackQueue } from '../queues/index.js';

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

// POST /api/notifications/slack-alert — Queue Slack error/warning alert
// No authMiddleware: frontend may call this before auth is available (login errors, global errors)
router.post('/slack-alert', async (req, res) => {
    try {
        const { level, category, action, message, module, user_email, user_name, path, details, error_code } = req.body;

        if (!message && !action) {
            return res.status(400).json({ error: 'Missing message or action' });
        }

        await slackQueue.add('slack-alert', {
            level: level || 'error',
            category,
            action,
            message,
            module,
            user_email,
            user_name,
            path,
            details,
            error_code,
        }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Slack alert queue error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

export default router;
