import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { ttsQueue } from '../queues/index.js';

const router = Router();

// POST /api/tts/generate — Queue TTS generation
router.post('/generate', authMiddleware, async (req, res) => {
    try {
        await ttsQueue.add('generate-tts', req.body, {
            attempts: 2, backoff: { type: 'exponential', delay: 5000 },
        });
        res.json({ success: true, message: 'TTS job queued' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
