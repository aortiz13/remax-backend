import cron from 'node-cron';
import { calendarQueue, importQueue, youtubeQueue, cameraReminderQueue, cleanupQueue, recruitmentQueue, taskReminderQueue } from '../queues/index.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';
import pool from '../lib/db.js';

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

    // =============================================
    // 🎯 RECRUITMENT CRON JOBS
    // =============================================

    // 1. Meeting-day confirmation — daily at 8am Chile (11:00 UTC)
    //    Sends confirmation email to candidates with meetings TODAY
    cron.schedule('0 11 * * *', async () => {
        console.log('⏰ Cron: Recruitment meeting-day confirmation');
        try {
            const today = new Date().toISOString().split('T')[0];

            // Find candidates with meeting_date = today in "Reunión Agendada" or "Reunión Confirmada"
            const { data: candidates, error } = await supabaseAdmin
                .from('recruitment_candidates')
                .select('*')
                .in('pipeline_stage', ['Reunión Agendada', 'Reunión Confirmada'])
                .gte('meeting_date', `${today}T00:00:00`)
                .lte('meeting_date', `${today}T23:59:59`);

            if (error || !candidates?.length) {
                console.log('✅ No recruitment meetings today');
                return;
            }

            console.log(`📧 Found ${candidates.length} meetings today, queuing confirmations...`);

            for (const candidate of candidates) {
                if (!candidate.email) continue;

                await recruitmentQueue.add('meeting-day-confirmation', {
                    candidateId: candidate.id,
                    candidateEmail: candidate.email,
                    candidateName: `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim(),
                    meetingDate: candidate.meeting_date,
                }, { jobId: `meeting-confirm-${candidate.id}-${today}` });
            }
        } catch (err) {
            logErrorToSlack('error', { category: 'cron', action: 'recruitment.meeting_confirmation', message: err.message, module: 'scheduler' });
        }
    });

    // 2. No-response follow-up — every 2 hours
    //    Candidates who received an email 48h+ ago without response
    cron.schedule('0 */2 * * *', async () => {
        console.log('⏰ Cron: Recruitment no-response follow-up');
        try {
            const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

            // Find candidates with last email sent >48h ago, still in early stages
            const { data: recentEmails } = await supabaseAdmin
                .from('recruitment_email_logs')
                .select('candidate_id, sent_at, status')
                .eq('status', 'sent')
                .lt('sent_at', cutoff)
                .order('sent_at', { ascending: false });

            if (!recentEmails?.length) return;

            // Group by candidate, get only latest email per candidate
            const latestByCandidate = {};
            for (const log of recentEmails) {
                if (!latestByCandidate[log.candidate_id]) {
                    latestByCandidate[log.candidate_id] = log;
                }
            }

            const candidateIds = Object.keys(latestByCandidate);
            if (!candidateIds.length) return;

            // Check which ones haven't received a follow-up yet
            const { data: candidates } = await supabaseAdmin
                .from('recruitment_candidates')
                .select('id, email, first_name, last_name, pipeline_stage')
                .in('id', candidateIds)
                .in('pipeline_stage', ['Nuevo', 'Reunión Agendada']);

            if (!candidates?.length) return;

            // Check for existing follow-up emails
            const { data: followUps } = await supabaseAdmin
                .from('recruitment_email_logs')
                .select('candidate_id')
                .in('candidate_id', candidates.map(c => c.id))
                .eq('email_type', 'Seguimiento')
                .gte('sent_at', cutoff);

            const alreadyFollowedUp = new Set((followUps || []).map(f => f.candidate_id));

            let count = 0;
            for (const candidate of candidates) {
                if (alreadyFollowedUp.has(candidate.id) || !candidate.email) continue;

                await recruitmentQueue.add('no-response-followup', {
                    candidateId: candidate.id,
                    candidateEmail: candidate.email,
                    candidateName: `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim(),
                    stage: candidate.pipeline_stage,
                });
                count++;
            }

            if (count > 0) console.log(`📧 Queued ${count} no-response follow-ups`);
        } catch (err) {
            logErrorToSlack('error', { category: 'cron', action: 'recruitment.followup', message: err.message, module: 'scheduler' });
        }
    });

    // 3. Stagnant candidates alert — weekly Monday at 9am Chile (12:00 UTC)
    //    Candidates in "Nuevo" for >7 days with no email sent
    cron.schedule('0 12 * * 1', async () => {
        console.log('⏰ Cron: Recruitment stagnant candidates check');
        try {
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

            const { data: stagnant } = await supabaseAdmin
                .from('recruitment_candidates')
                .select('id, first_name, last_name, email, created_at')
                .eq('pipeline_stage', 'Nuevo')
                .lt('created_at', sevenDaysAgo);

            if (!stagnant?.length) {
                console.log('✅ No stagnant recruitment candidates');
                return;
            }

            // Check which have zero emails
            const { data: sentLogs } = await supabaseAdmin
                .from('recruitment_email_logs')
                .select('candidate_id')
                .in('candidate_id', stagnant.map(s => s.id));

            const hasEmail = new Set((sentLogs || []).map(l => l.candidate_id));
            const noContact = stagnant.filter(s => !hasEmail.has(s.id));

            if (noContact.length > 0) {
                await recruitmentQueue.add('stagnant-candidates-alert', {
                    candidates: noContact.map(c => ({
                        id: c.id,
                        name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
                        email: c.email,
                        createdAt: c.created_at,
                    })),
                    count: noContact.length,
                });
                console.log(`⚠️ Found ${noContact.length} stagnant candidates without any contact`);
            }
        } catch (err) {
            logErrorToSlack('error', { category: 'cron', action: 'recruitment.stagnant', message: err.message, module: 'scheduler' });
        }
    });

    // ─── Gmail: Renew Pub/Sub watch (daily at 2am Chile = 5am UTC) ───
    // Gmail watch expires every 7 days; renewing daily ensures no gaps
    cron.schedule('0 5 * * *', async () => {
        console.log('⏰ Cron: Gmail Pub/Sub watch renewal');
        try {
            const { rows: accounts } = await pool.query(
                `SELECT id, agent_id, email_address, access_token, refresh_token FROM gmail_accounts WHERE purpose = 'agent' OR purpose IS NULL`
            );
            if (!accounts || accounts.length === 0) {
                console.log('✅ No Gmail accounts to renew watch for');
                return;
            }

            const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
            const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
            const GOOGLE_PUBSUB_TOPIC = process.env.GOOGLE_PUBSUB_TOPIC;

            for (const account of accounts) {
                try {
                    let accessToken = account.access_token;

                    // Try watch with current token
                    let watchRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/watch', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            topicName: GOOGLE_PUBSUB_TOPIC,
                            labelIds: ['INBOX'],
                        }),
                    });

                    // Refresh token if expired
                    if (watchRes.status === 401) {
                        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: new URLSearchParams({
                                client_id: GOOGLE_CLIENT_ID,
                                client_secret: GOOGLE_CLIENT_SECRET,
                                refresh_token: account.refresh_token,
                                grant_type: 'refresh_token',
                            }),
                        });
                        const tokenData = await tokenRes.json();
                        if (tokenData.error) {
                            console.error(`  ❌ Token refresh failed for ${account.email_address}: ${tokenData.error}`);
                            continue;
                        }
                        accessToken = tokenData.access_token;

                        // Update stored token
                        await pool.query(
                            `UPDATE gmail_accounts SET access_token = $1, updated_at = NOW() WHERE id = $2`,
                            [accessToken, account.id]
                        );

                        // Retry watch with new token
                        watchRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/watch', {
                            method: 'POST',
                            headers: {
                                Authorization: `Bearer ${accessToken}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                topicName: GOOGLE_PUBSUB_TOPIC,
                                labelIds: ['INBOX'],
                            }),
                        });
                    }

                    const watchData = await watchRes.json();
                    if (watchData.historyId) {
                        await pool.query(
                            `UPDATE gmail_accounts SET last_history_id = $1, updated_at = NOW() WHERE id = $2`,
                            [watchData.historyId, account.id]
                        );
                        console.log(`  ✅ Watch renewed for ${account.email_address} (historyId: ${watchData.historyId})`);
                    } else {
                        console.warn(`  ⚠️ Watch renewal for ${account.email_address}:`, JSON.stringify(watchData));
                    }
                } catch (accountErr) {
                    console.error(`  ❌ Watch renewal failed for ${account.email_address}:`, accountErr.message);
                }
            }
        } catch (err) {
            logErrorToSlack('error', { category: 'cron', action: 'gmail.watch_renewal', message: err.message, module: 'scheduler' });
        }
    });

    // ─── Recruitment: Web form emails (every 2 minutes) ───
    cron.schedule('*/2 * * * *', async () => {
        try {
            // Look up the info@ Gmail account
            const { rows: [infoAccount] } = await pool.query(
                `SELECT id, email_address, access_token, refresh_token FROM gmail_accounts WHERE email_address = 'info@remax-exclusive.cl' LIMIT 1`
            );
            if (!infoAccount) return;

            // Fetch recent unread emails
            const { google } = await import('googleapis');
            const oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET
            );
            oauth2Client.setCredentials({
                access_token: infoAccount.access_token,
                refresh_token: infoAccount.refresh_token,
            });

            const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

            // Search for unread emails from info@remax-exclusive.cl (form notifications)
            const listRes = await gmail.users.messages.list({
                userId: 'me',
                q: 'is:unread from:info@remax-exclusive.cl -subject:"Nuevos envíos de Calculadora comisiones"',
                maxResults: 10,
            });

            const messages = listRes.data.messages || [];
            if (messages.length === 0) return;

            console.log(`📧 Found ${messages.length} unread web form emails`);

            for (const msg of messages) {
                try {
                    const fullMsg = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
                    
                    // Extract HTML body
                    let htmlBody = '';
                    const payload = fullMsg.data.payload;
                    if (payload.body?.data) {
                        htmlBody = Buffer.from(payload.body.data, 'base64').toString('utf-8');
                    } else if (payload.parts) {
                        const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
                        if (htmlPart?.body?.data) {
                            htmlBody = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8');
                        }
                    }

                    if (htmlBody) {
                        await recruitmentQueue.add('process-web-form-email', {
                            html: htmlBody,
                            messageId: msg.id,
                        }, { jobId: `web-form-${msg.id}` });
                    }

                    // Mark as read
                    await gmail.users.messages.modify({
                        userId: 'me', id: msg.id,
                        requestBody: { removeLabelIds: ['UNREAD'] },
                    });
                } catch (msgErr) {
                    console.error(`Error processing message ${msg.id}:`, msgErr.message);
                }
            }
        } catch (err) {
            // Don't log error if account simply doesn't exist yet
            if (!err.message?.includes('undefined')) {
                logErrorToSlack('error', { category: 'cron', action: 'recruitment.web_form_monitor', message: err.message, module: 'scheduler' });
            }
        }
    });

    // =============================================
    // 🔔 TASK REMINDER NOTIFICATIONS
    // =============================================

    // 1. Punctual reminders — every 5 minutes
    //    Checks for tasks with reminder_minutes where (execution_date - reminder_minutes) <= now
    cron.schedule('*/5 * * * *', async () => {
        try {
            const { rows: tasks } = await pool.query(`
                SELECT t.id, t.action, t.description, t.execution_date, t.reminder_minutes,
                       t.is_all_day, t.agent_id, t.contact_id, t.property_id,
                       p.first_name AS agent_first, p.last_name AS agent_last,
                       p.email AS agent_email, p.phone AS agent_phone,
                       p.notification_preferences,
                       c.first_name AS contact_first, c.last_name AS contact_last,
                       prop.address AS property_address
                FROM crm_tasks t
                JOIN profiles p ON p.id = t.agent_id
                LEFT JOIN contacts c ON c.id = t.contact_id
                LEFT JOIN properties prop ON prop.id = t.property_id
                WHERE t.completed = false
                  AND t.is_all_day = false
                  AND t.reminder_minutes IS NOT NULL
                  AND t.execution_date > NOW()
                  AND (t.execution_date - (t.reminder_minutes || ' minutes')::interval) <= NOW()
                  AND NOT EXISTS (
                      SELECT 1 FROM notification_logs nl
                      WHERE nl.reminder_key = 'reminder:' || t.id::text || ':' || t.reminder_minutes::text
                  )
            `);

            if (tasks.length === 0) return;
            console.log(`🔔 Found ${tasks.length} task reminder(s) to send`);

            for (const task of tasks) {
                const prefs = task.notification_preferences || { email: true, whatsapp: true };
                const channels = [];
                if (prefs.email && task.agent_email) channels.push('email');
                if (prefs.whatsapp && task.agent_phone) channels.push('whatsapp');
                if (channels.length === 0) continue;

                await taskReminderQueue.add('send-reminder', {
                    type: 'reminder',
                    channels,
                    agent: {
                        id: task.agent_id,
                        name: `${task.agent_first || ''} ${task.agent_last || ''}`.trim(),
                        email: task.agent_email,
                        phone: task.agent_phone,
                    },
                    tasks: [{
                        id: task.id,
                        title: task.action,
                        description: task.description,
                        execution_date: task.execution_date,
                        execution_time: new Date(task.execution_date).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Santiago' }),
                        reminder_minutes: task.reminder_minutes,
                        contact_name: task.contact_first ? `${task.contact_first} ${task.contact_last || ''}`.trim() : null,
                        property_address: task.property_address,
                        is_all_day: false,
                    }],
                    reminder_key: `reminder:${task.id}:${task.reminder_minutes}`,
                }, { jobId: `reminder-${task.id}-${task.reminder_minutes}` });
            }
        } catch (err) {
            console.error('❌ Task reminder cron error:', err.message);
            logErrorToSlack('error', { category: 'cron', action: 'task_reminder.check', message: err.message, module: 'scheduler' });
        }
    });

    // 2. Daily 8am notifications (Chile time UTC-3 = 11:00 UTC)
    //    - If agent has daily_summary ON → send full summary (today's tasks + overdue)
    //    - If agent has daily_summary OFF → send individual all-day task notifications
    cron.schedule('0 11 * * *', async () => {
        console.log('⏰ Cron: Daily task notifications (8am Chile)');
        try {
            const todayKey = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

            // Get all agents with pending tasks for today or overdue
            const { rows: agentTasks } = await pool.query(`
                SELECT t.id, t.action, t.description, t.execution_date, t.reminder_minutes,
                       t.is_all_day, t.agent_id, t.contact_id, t.property_id,
                       p.first_name AS agent_first, p.last_name AS agent_last,
                       p.email AS agent_email, p.phone AS agent_phone,
                       p.notification_preferences,
                       c.first_name AS contact_first, c.last_name AS contact_last,
                       prop.address AS property_address,
                       CASE
                           WHEN (t.execution_date AT TIME ZONE 'America/Santiago')::date < CURRENT_DATE THEN true
                           ELSE false
                       END AS is_overdue
                FROM crm_tasks t
                JOIN profiles p ON p.id = t.agent_id
                LEFT JOIN contacts c ON c.id = t.contact_id
                LEFT JOIN properties prop ON prop.id = t.property_id
                WHERE t.completed = false
                  AND (
                      -- Today's tasks
                      (t.execution_date AT TIME ZONE 'America/Santiago')::date = CURRENT_DATE
                      -- Or overdue tasks from past days
                      OR (t.execution_date AT TIME ZONE 'America/Santiago')::date < CURRENT_DATE
                  )
                ORDER BY t.agent_id, t.is_all_day, t.execution_date
            `);

            if (agentTasks.length === 0) {
                console.log('✅ No daily task notifications to send');
                return;
            }

            // Group by agent
            const byAgent = {};
            for (const task of agentTasks) {
                if (!byAgent[task.agent_id]) {
                    byAgent[task.agent_id] = {
                        agent: {
                            id: task.agent_id,
                            name: `${task.agent_first || ''} ${task.agent_last || ''}`.trim(),
                            email: task.agent_email,
                            phone: task.agent_phone,
                        },
                        prefs: task.notification_preferences || { email: true, whatsapp: true, daily_summary: false },
                        tasks: [],
                    };
                }
                byAgent[task.agent_id].tasks.push({
                    id: task.id,
                    title: task.action,
                    description: task.description,
                    execution_date: task.execution_date,
                    execution_time: task.is_all_day ? null : new Date(task.execution_date).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Santiago' }),
                    reminder_minutes: task.reminder_minutes,
                    contact_name: task.contact_first ? `${task.contact_first} ${task.contact_last || ''}`.trim() : null,
                    property_address: task.property_address,
                    is_all_day: task.is_all_day,
                    is_overdue: task.is_overdue,
                });
            }

            let count = 0;
            for (const [agentId, group] of Object.entries(byAgent)) {
                const { agent, prefs, tasks } = group;
                const channels = [];
                if (prefs.email && agent.email) channels.push('email');
                if (prefs.whatsapp && agent.phone) channels.push('whatsapp');
                if (channels.length === 0) continue;

                const dedupKey = `daily:${agentId}:${todayKey}`;

                // Check dedup
                const { rows: existing } = await pool.query(
                    `SELECT 1 FROM notification_logs WHERE reminder_key = $1 LIMIT 1`,
                    [dedupKey]
                );
                if (existing.length > 0) continue;

                if (prefs.daily_summary) {
                    // Send full daily summary
                    await taskReminderQueue.add('send-reminder', {
                        type: 'daily_summary',
                        channels,
                        agent,
                        tasks,
                        reminder_key: dedupKey,
                    }, { jobId: `daily-summary-${agentId}-${todayKey}` });
                } else {
                    // Send only all-day task notifications individually
                    const allDayTasks = tasks.filter(t => t.is_all_day);
                    if (allDayTasks.length === 0) continue;

                    await taskReminderQueue.add('send-reminder', {
                        type: 'allday_8am',
                        channels,
                        agent,
                        tasks: allDayTasks,
                        reminder_key: dedupKey,
                    }, { jobId: `allday-8am-${agentId}-${todayKey}` });
                }
                count++;
            }

            if (count > 0) console.log(`🔔 Queued daily notifications for ${count} agent(s)`);
            else console.log('✅ No daily task notifications needed');
        } catch (err) {
            console.error('❌ Daily task notification error:', err.message);
            logErrorToSlack('error', { category: 'cron', action: 'task_reminder.daily', message: err.message, module: 'scheduler' });
        }
    });

    console.log('⏰ All cron jobs scheduled');
}
