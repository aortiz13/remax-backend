import cron from 'node-cron';
import { calendarQueue, importQueue, youtubeQueue, cameraReminderQueue, cleanupQueue } from '../queues/index.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

export function startCronJobs() {
    // Calendar sync — every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
        console.log('⏰ Cron: Calendar sync triggered');
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .not('google_refresh_token', 'is', null);

        for (const profile of (profiles || [])) {
            await calendarQueue.add('calendar-cron-sync', {
                agentId: profile.id,
                action: 'sync_from_google',
            }, { jobId: `cal-sync-${profile.id}-${Date.now()}` });
        }
    });

    // RE/MAX listings sync — every 6 hours
    cron.schedule('0 */6 * * *', async () => {
        console.log('⏰ Cron: RE/MAX listings sync');
        await importQueue.add('sync-remax-listings', {
            cronTriggered: true,
        });
    });

    // YouTube playlist sync — daily at 3am
    cron.schedule('0 3 * * *', async () => {
        console.log('⏰ Cron: YouTube playlist sync');
        await youtubeQueue.add('sync-youtube', { cronTriggered: true });
    });

    // Camera reminders — every hour
    cron.schedule('0 * * * *', async () => {
        console.log('⏰ Cron: Camera reminders check');
        await cameraReminderQueue.add('check-reminders', { cronTriggered: true });
    });

    // Storage cleanup — daily at 2am
    cron.schedule('0 2 * * *', async () => {
        console.log('⏰ Cron: Storage cleanup');
        await cleanupQueue.add('cleanup-storage', { cronTriggered: true });
    });

    console.log('⏰ All cron jobs scheduled');
}
