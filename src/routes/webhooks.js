import { Router } from 'express';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { gmailWebhookQueue, calendarQueue } from '../queues/index.js';

const router = Router();

// POST /api/webhooks/gmail — Gmail Pub/Sub push notifications
router.post('/gmail', async (req, res) => {
    try {
        const payload = req.body;
        if (!payload.message?.data) return res.status(200).send('OK');

        const pubSubMessageId = payload.message.messageId || payload.message.message_id;

        // Dedup check
        if (pubSubMessageId) {
            const { data: existing } = await supabaseAdmin
                .from('gmail_processed_notifications')
                .select('id')
                .eq('pub_sub_message_id', pubSubMessageId)
                .maybeSingle();
            if (existing) return res.status(200).send('OK - Duplicate');
        }

        const dataStr = Buffer.from(payload.message.data, 'base64').toString('utf-8');
        const notification = JSON.parse(dataStr);

        if (!notification.emailAddress || !notification.historyId) {
            return res.status(200).send('OK');
        }

        // Record this Pub/Sub message
        if (pubSubMessageId) {
            await supabaseAdmin.from('gmail_processed_notifications').insert({
                pub_sub_message_id: pubSubMessageId,
                email_address: notification.emailAddress,
                history_id: notification.historyId,
            }).then(() => { }).catch(() => { });
        }

        // Enqueue for background processing
        await gmailWebhookQueue.add('process-gmail-webhook', {
            emailAddress: notification.emailAddress,
            historyId: notification.historyId,
        }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            jobId: `gmail-${notification.emailAddress}-${notification.historyId}`,
        });

        res.status(200).send('OK');
    } catch (error) {
        console.error('Gmail webhook error:', error);
        res.status(200).send('OK - Error logged');
    }
});

// POST /api/webhooks/calendar — Google Calendar push notifications
router.post('/calendar', async (req, res) => {
    try {
        const channelId = req.headers['x-goog-channel-id'];
        const resourceState = req.headers['x-goog-resource-state'];

        if (resourceState === 'sync') {
            return res.status(200).send('Sync confirmation received');
        }

        // Trigger sync for all connected agents
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .not('google_refresh_token', 'is', null);

        if (profiles?.length) {
            for (const profile of profiles) {
                await calendarQueue.add('calendar-sync', {
                    agentId: profile.id,
                    action: 'sync_from_google',
                });
            }
        }

        res.status(200).send('ok');
    } catch (error) {
        console.error('Calendar webhook error:', error);
        res.status(200).send('ok');
    }
});

export default router;
