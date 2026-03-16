import cron from 'node-cron';
import { calendarQueue, importQueue, youtubeQueue, cameraReminderQueue, cleanupQueue } from '../queues/index.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

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

            if (error) { logErrorToSlack('error', { category: 'cron', action: 'report_task.query', message: error.message, module: 'scheduler' }); return; }
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
                if (insertError) logErrorToSlack('error', { category: 'cron', action: 'report_task.insert', message: insertError.message, module: 'scheduler' });
                else console.log(`✅ Created ${newTasks.length} management report task(s)`);
            } else {
                console.log('✅ All pending reports already have tasks');
            }
        } catch (err) {
            logErrorToSlack('error', { category: 'cron', action: 'report_task.exception', message: err.message, module: 'scheduler' });
        }
    });

    // Inspection reminders — daily at 8am (Chile time UTC-3 = 11:00 UTC)
    cron.schedule('0 11 * * *', async () => {
        console.log('⏰ Cron: Inspection reminders check');
        try {
            const today = new Date().toISOString().split('T')[0];
            const in3Days = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];

            // Find pending inspections scheduled within next 3 days, not yet notified
            const { data: schedules, error } = await supabaseAdmin
                .from('inspection_schedule')
                .select(`
                    id, scheduled_date, property_id, agent_id, notification_sent,
                    property:properties(id, address, commune),
                    agent:profiles(id, first_name, last_name, email, phone)
                `)
                .eq('status', 'pending')
                .gte('scheduled_date', today)
                .lte('scheduled_date', in3Days)
                .or('notification_sent.is.null,notification_sent.eq.false');

            if (error) { logErrorToSlack('error', { category: 'cron', action: 'inspection_reminder.query', message: error.message, module: 'scheduler' }); return; }
            if (!schedules || schedules.length === 0) { console.log('✅ No upcoming inspections need reminders'); return; }

            // Check for existing CRM tasks to avoid duplicates
            const agentIds = [...new Set(schedules.map(s => s.agent_id).filter(Boolean))];
            const { data: existingTasks } = await supabaseAdmin
                .from('crm_tasks')
                .select('description')
                .in('agent_id', agentIds)
                .eq('task_type', 'task')
                .eq('completed', false)
                .like('action', 'Inspección Programada%');

            const existingKeys = new Set((existingTasks || []).map(t => t.description));

            const newTasks = [];
            const notifiedIds = [];

            for (const s of schedules) {
                if (!s.agent_id || !s.agent) continue;

                const taskKey = `inspection:${s.id}`;
                const addr = s.property?.address || 'Propiedad';
                const commune = s.property?.commune ? `, ${s.property.commune}` : '';

                // Create CRM task if not exists
                if (!existingKeys.has(taskKey)) {
                    newTasks.push({
                        agent_id: s.agent_id,
                        property_id: s.property_id,
                        action: `Inspección Programada - ${addr}${commune}`,
                        description: taskKey,
                        task_type: 'task',
                        execution_date: `${s.scheduled_date}T09:00:00-03:00`,
                        is_all_day: true,
                        completed: false,
                    });
                }

                // Send notification via n8n webhook
                try {
                    await fetch('https://workflow.remax-exclusive.cl/webhook/inspection-reminder', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            event: 'inspection_reminder',
                            agent: {
                                name: `${s.agent.first_name || ''} ${s.agent.last_name || ''}`.trim(),
                                email: s.agent.email || '',
                                phone: s.agent.phone || '',
                            },
                            inspection: {
                                schedule_id: s.id,
                                property_id: s.property_id,
                                address: `${addr}${commune}`,
                                scheduled_date: s.scheduled_date,
                            },
                        }),
                    });
                } catch (webhookErr) {
                    console.warn(`⚠️ Inspection reminder webhook failed for ${s.id}:`, webhookErr.message);
                }

                notifiedIds.push(s.id);
            }

            // Insert CRM tasks
            if (newTasks.length > 0) {
                const { error: insertError } = await supabaseAdmin.from('crm_tasks').insert(newTasks);
                if (insertError) logErrorToSlack('error', { category: 'cron', action: 'inspection_task.insert', message: insertError.message, module: 'scheduler' });
                else console.log(`✅ Created ${newTasks.length} inspection reminder task(s)`);
            }

            // Mark as notified
            if (notifiedIds.length > 0) {
                await supabaseAdmin
                    .from('inspection_schedule')
                    .update({ notification_sent: true })
                    .in('id', notifiedIds);
                console.log(`✅ Marked ${notifiedIds.length} inspections as notified`);
            }
        } catch (err) {
            logErrorToSlack('error', { category: 'cron', action: 'inspection_reminder.exception', message: err.message, module: 'scheduler' });
        }
    });

    console.log('⏰ All cron jobs scheduled');
}
