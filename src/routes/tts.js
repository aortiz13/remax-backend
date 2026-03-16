import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { ttsQueue } from '../queues/index.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

const router = Router();

// POST /api/tts/generate — Queue TTS generation
router.post('/generate', authMiddleware, async (req, res) => {
    try {
        await ttsQueue.add('generate-tts', req.body, {
            attempts: 2, backoff: { type: 'exponential', delay: 5000 },
        });
        res.json({ success: true, message: 'TTS job queued' });
    } catch (error) {
        logErrorToSlack('error', {
            category: 'backend', action: 'tts.generate', message: error.message,
            module: 'tts',
        });
        res.status(400).json({ error: error.message });
    }
});

export default router;
