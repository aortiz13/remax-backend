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

    // Management report tasks — daily at 8am (Chile time UTC-3 = 11:00 UTC)
    cron.schedule('0 11 * * *', async () => {
        console.log('⏰ Cron: Management report tasks check');
        try {
            // Find pending reports with due_date ≤ today+3 days that don't have a crm_task yet
            const { data: reports, error } = await supabaseAdmin
                .from('management_reports')
                .select(`
                    id, report_number, agent_id, property_id, owner_contact_id, due_date,
                    properties:property_id(address, commune)
                `)
                .in('status', ['pending'])
                .lte('due_date', new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0])
                .gte('due_date', new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);

            if (error) { console.error('❌ Report task cron query error:', error.message); return; }
            if (!reports || reports.length === 0) { console.log('✅ No pending reports need tasks'); return; }

            // Check for existing tasks to avoid duplicates
            const reportIds = reports.map(r => r.id);
            const { data: existingTasks } = await supabaseAdmin
                .from('crm_tasks')
                .select('description')
                .in('agent_id', [...new Set(reports.map(r => r.agent_id))])
                .eq('task_type', 'task')
                .eq('completed', false)
                .like('action', 'Enviar Informe de Gestión%');

            const existingKeys = new Set((existingTasks || []).map(t => t.description));

            const newTasks = [];
            for (const r of reports) {
                const taskKey = `report:${r.id}`;
                if (existingKeys.has(taskKey)) continue;

                const addr = r.properties?.address || 'Propiedad';
                const commune = r.properties?.commune ? `, ${r.properties.commune}` : '';
                newTasks.push({
                    agent_id: r.agent_id,
                    property_id: r.property_id,
                    contact_id: r.owner_contact_id,
                    action: `Enviar Informe de Gestión #${r.report_number} - ${addr}${commune}`,
                    description: taskKey,
                    task_type: 'task',
                    execution_date: `${r.due_date}T09:00:00-03:00`,
                    is_all_day: true,
                    completed: false,
                });
            }

            if (newTasks.length > 0) {
                const { error: insertError } = await supabaseAdmin.from('crm_tasks').insert(newTasks);
                if (insertError) console.error('❌ Error inserting report tasks:', insertError.message);
                else console.log(`✅ Created ${newTasks.length} management report task(s)`);
            } else {
                console.log('✅ All pending reports already have tasks');
            }
        } catch (err) {
            console.error('❌ Management report task cron error:', err.message);
        }
    });

    console.log('⏰ All cron jobs scheduled');
}
