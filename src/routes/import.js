import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';
import { scanAgentListings } from '../services/remaxListingsService.js';

const router = Router();

// POST /api/import/remax-listings — Scan RE/MAX listings for a given agent
router.post('/remax-listings', authMiddleware, async (req, res) => {
    try {
        const { agentId } = req.body;
        if (!agentId) {
            return res.status(400).json({ success: false, error: 'Agent ID is required' });
        }

        console.log(`📦 Scanning RE/MAX listings for agent ${agentId}...`);

        const { properties, totalListings } = await scanAgentListings(agentId);

        console.log(`  → ${properties.length} physical properties, ${totalListings} total listing versions`);

        return res.json({
            success: true,
            count: properties.length,
            total_listings: totalListings,
            agentId,
            properties,
        });

    } catch (error) {
        console.error('❌ RE/MAX import error:', error.message);
        logErrorToSlack('error', {
            category: 'backend',
            action: 'import.remax_listings',
            message: `RE/MAX scan failed: ${error.message}`,
            module: 'import',
            details: { agentId: req.body?.agentId },
        });
        return res.status(400).json({ success: false, error: error.message });
    }
});

export default router;
