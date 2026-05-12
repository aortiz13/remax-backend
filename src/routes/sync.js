import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';
import { syncAllAgents, syncAgent } from '../services/propertySyncService.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

const router = Router();

/**
 * POST /api/sync/remax-listings
 * Body (all optional):
 *   {
 *     agentIds?: string[],          // remax_agent_ids — empty/omitted = all agents
 *     includeProperties?: boolean   // include per-property detail in response (default false)
 *   }
 *
 * Non-destructive: never deletes, only inserts/updates missing or stale fields.
 */
router.post('/remax-listings', authMiddleware, async (req, res) => {
    const t0 = Date.now();
    try {
        const { agentIds, includeProperties } = req.body || {};

        const summary = await syncAllAgents(
            Array.isArray(agentIds) ? agentIds : undefined,
            { includeProperties: includeProperties === true }
        );

        console.log(`📦 [sync] done in ${summary.duration_ms}ms — agents=${summary.agents_processed} +${summary.properties_inserted}/~${summary.properties_updated} ph=${summary.photos_added} hist=${summary.history_added}`);
        return res.json(summary);

    } catch (error) {
        console.error('❌ /api/sync/remax-listings error:', error.message);
        logErrorToSlack('error', {
            category: 'backend',
            action: 'sync.remax_listings',
            message: `Sync failed: ${error.message}`,
            module: 'sync',
        });
        return res.status(500).json({
            success: false,
            error: error.message,
            duration_ms: Date.now() - t0,
        });
    }
});

/**
 * POST /api/sync/remax-listings/agent
 * Body: { agentId: string (remax_agent_id), includeProperties?: boolean }
 *
 * Convenience endpoint for syncing a single agent by their remax_agent_id.
 * Resolves the profile row, then runs the same non-destructive sync.
 */
router.post('/remax-listings/agent', authMiddleware, async (req, res) => {
    try {
        const { agentId, includeProperties } = req.body || {};
        if (!agentId) {
            return res.status(400).json({ success: false, error: 'agentId (remax_agent_id) is required' });
        }

        const { data: agent, error } = await supabaseAdmin
            .from('profiles')
            .select('id, first_name, last_name, remax_agent_id')
            .eq('remax_agent_id', String(agentId))
            .maybeSingle();
        if (error) throw error;
        if (!agent) return res.status(404).json({ success: false, error: `No profile found for remax_agent_id=${agentId}` });

        const result = await syncAgent(agent, { includeProperties: includeProperties === true });
        return res.json({ success: true, result });

    } catch (error) {
        console.error('❌ /api/sync/remax-listings/agent error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
