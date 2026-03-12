import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { calendarQueue } from '../queues/index.js';

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

async function getAccessToken(refreshToken) {
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
    });
    const data = await response.json();
    return data.access_token;
}

// POST /api/calendar/sync — Sync calendar events
router.post('/sync', authMiddleware, async (req, res) => {
    try {
        const { action, reset, agentId: bodyAgentId, taskId, googleEventId, create_meet } = req.body;
        const agentId = req.isServiceCall ? bodyAgentId : req.user.id;

        if (!agentId) {
            return res.status(400).json({ error: 'Missing agentId' });
        }

        if (reset) {
            await supabaseAdmin.from('profiles').update({ google_sync_token: null }).eq('id', agentId);
        }

        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('google_refresh_token, google_sync_token')
            .eq('id', agentId)
            .single();

        if (profileError || !profile?.google_refresh_token) {
            return res.status(400).json({ error: 'Google Calendar not linked' });
        }

        const accessToken = await getAccessToken(profile.google_refresh_token);

        // --- DELETE FROM GOOGLE ---
        if (action === 'delete_from_google') {
            if (!googleEventId) return res.status(400).json({ error: 'Missing googleEventId' });

            let url, method = 'DELETE';
            if (googleEventId.startsWith('GT_')) {
                const taskIdReal = googleEventId.replace('GT_', '');
                url = `https://www.googleapis.com/tasks/v1/lists/@default/tasks/${taskIdReal}`;
            } else {
                url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventId}`;
            }

            const response = await fetch(url, {
                method,
                headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (response.ok || response.status === 404) {
                return res.json({ success: true });
            } else {
                const errorData = await response.json().catch(() => ({}));
                return res.status(response.status).json({ success: false, error: errorData });
            }
        }

        // --- SYNC FROM GOOGLE TO CRM ---
        if (action === 'sync_from_google') {
            const results = { events: 0, tasks: 0 };

            // 1. Fetch Calendar Events
            const baseCalendarUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
            const calParams = new URLSearchParams();
            if (profile.google_sync_token && !reset) {
                calParams.set('syncToken', profile.google_sync_token);
            } else {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                calParams.set('timeMin', today.toISOString());
                calParams.set('singleEvents', 'true');
                calParams.set('orderBy', 'startTime');
            }
            calParams.set('maxResults', '250');

            let allEvents = [];
            let nextPageToken;
            let nextSyncToken;

            do {
                const pageParams = new URLSearchParams(calParams);
                if (nextPageToken) pageParams.set('pageToken', nextPageToken);

                const calResponse = await fetch(`${baseCalendarUrl}?${pageParams.toString()}`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });

                if (calResponse.status === 410) {
                    await supabaseAdmin.from('profiles').update({ google_sync_token: null }).eq('id', agentId);
                    return res.json({ retry: true });
                }

                if (calResponse.ok) {
                    const data = await calResponse.json();
                    allEvents = allEvents.concat(data.items || []);
                    nextPageToken = data.nextPageToken;
                    nextSyncToken = data.nextSyncToken;
                } else {
                    console.error('Calendar fetch error:', calResponse.status);
                    break;
                }
            } while (nextPageToken);

            if (allEvents.length > 0) {
                const googleEventIds = allEvents.filter(e => e.status !== 'cancelled').map(e => e.id);
                const { data: existingTasks } = await supabaseAdmin
                    .from('crm_tasks')
                    .select('google_event_id, task_type')
                    .in('google_event_id', googleEventIds.length > 0 ? googleEventIds : ['__none__']);

                const typeMap = new Map(existingTasks?.map(t => [t.google_event_id, t.task_type]) || []);

                for (const event of allEvents) {
                    if (event.status === 'cancelled') {
                        await supabaseAdmin.from('crm_tasks').delete().eq('google_event_id', event.id);
                    } else {
                        const existingType = typeMap.get(event.id);
                        const taskData = {
                            agent_id: agentId,
                            action: event.summary || '(Sin título)',
                            description: event.description || '',
                            description_html: event.description || '',
                            execution_date: event.start?.dateTime || event.start?.date,
                            end_date: event.end?.dateTime || event.end?.date,
                            location: event.location || '',
                            hangout_link: event.hangoutLink || '',
                            attendees: event.attendees || [],
                            task_type: existingType || ((event.attendees?.length > 0) || event.location ? 'meeting' : 'task'),
                            is_all_day: !!event.start?.date,
                            google_event_id: event.id,
                            google_etag: event.etag,
                            last_synced_at: new Date().toISOString(),
                        };
                        if (taskData.execution_date) {
                            await supabaseAdmin.from('crm_tasks').upsert(taskData, { onConflict: 'google_event_id' });
                            results.events++;
                        }
                    }
                }
            }

            if (nextSyncToken) {
                await supabaseAdmin.from('profiles').update({ google_sync_token: nextSyncToken }).eq('id', agentId);
            }

            // 2. Fetch Google Tasks
            const tasksUrl = 'https://www.googleapis.com/tasks/v1/lists/@default/tasks?showCompleted=true&showHidden=true';
            const tasksResponse = await fetch(tasksUrl, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (tasksResponse.ok) {
                const data = await tasksResponse.json();
                const gTasks = data.items || [];
                for (const gTask of gTasks) {
                    const internalGId = `GT_${gTask.id}`;
                    if (gTask.deleted) {
                        await supabaseAdmin.from('crm_tasks').delete().eq('google_event_id', internalGId);
                    } else {
                        const taskData = {
                            agent_id: agentId,
                            action: gTask.title || '(Sin título)',
                            description: gTask.notes || '',
                            description_html: gTask.notes || '',
                            execution_date: gTask.due,
                            completed: gTask.status === 'completed',
                            task_type: 'task',
                            is_all_day: true,
                            google_event_id: internalGId,
                            google_etag: gTask.etag,
                            last_synced_at: new Date().toISOString(),
                        };
                        if (taskData.execution_date) {
                            await supabaseAdmin.from('crm_tasks').upsert(taskData, { onConflict: 'google_event_id' });
                            results.tasks++;
                        }
                    }
                }
            }

            return res.json({ success: true, results, count: results.events + results.tasks });
        }

        // --- PUSH LOCAL TASK TO GOOGLE ---
        if (action === 'push_to_google') {
            const { data: task, error: taskErr } = await supabaseAdmin.from('crm_tasks').select('*').eq('id', taskId).single();
            if (taskErr || !task) return res.status(404).json({ error: 'Task not found' });
            if (task.agent_id !== agentId) return res.status(403).json({ error: 'Unauthorized' });

            const shouldBeGoogleTask = task.task_type === 'task' && task.is_all_day;
            const currentlyIsGoogleTask = task.google_event_id?.startsWith('GT_');
            const currentlyIsCalendarEvent = task.google_event_id && !task.google_event_id.startsWith('GT_');

            // Handle type switching
            if (currentlyIsGoogleTask && !shouldBeGoogleTask) {
                const taskIdReal = task.google_event_id.replace('GT_', '');
                await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${taskIdReal}`, {
                    method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
                });
                task.google_event_id = null;
            } else if (currentlyIsCalendarEvent && shouldBeGoogleTask) {
                await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${task.google_event_id}`, {
                    method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
                });
                task.google_event_id = null;
            }

            if (shouldBeGoogleTask) {
                // Push as Google Task
                const googleTask = {
                    title: task.action,
                    notes: task.description_html || task.description,
                    due: task.execution_date ? new Date(task.execution_date).toISOString() : undefined,
                    status: task.completed ? 'completed' : 'needsAction',
                };

                let method = 'POST';
                let url = 'https://www.googleapis.com/tasks/v1/lists/@default/tasks';
                if (task.google_event_id?.startsWith('GT_')) {
                    method = 'PATCH';
                    url += `/${task.google_event_id.replace('GT_', '')}`;
                }

                const response = await fetch(url, {
                    method,
                    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(googleTask),
                });

                const result = await response.json();
                if (response.ok) {
                    await supabaseAdmin.from('crm_tasks').update({
                        google_event_id: `GT_${result.id}`,
                        google_etag: result.etag,
                        last_synced_at: new Date().toISOString(),
                    }).eq('id', taskId);
                    return res.json({ success: true, google_id: result.id });
                }
                return res.status(response.status).json({ success: false, error: result });
            } else {
                // Push as Calendar Event
                const attendees = [...(task.attendees || [])];
                if (task.contact_id) {
                    const { data: contact } = await supabaseAdmin.from('contacts').select('email').eq('id', task.contact_id).single();
                    if (contact?.email && !attendees.some(a => a.email === contact.email)) {
                        attendees.push({ email: contact.email });
                    }
                }

                const googleEvent = {
                    summary: task.action,
                    description: task.description_html || task.description,
                    location: task.location || '',
                    attendees,
                };

                if (task.is_all_day) {
                    googleEvent.start = { date: new Date(task.execution_date).toISOString().split('T')[0] };
                    const endDate = new Date(task.execution_date);
                    endDate.setDate(endDate.getDate() + 1);
                    googleEvent.end = { date: endDate.toISOString().split('T')[0] };
                } else {
                    googleEvent.start = { dateTime: new Date(task.execution_date).toISOString() };
                    googleEvent.end = { dateTime: new Date(task.end_date || (new Date(task.execution_date).getTime() + 3600000)).toISOString() };
                }

                if (req.body.create_meet) {
                    googleEvent.conferenceData = {
                        createRequest: {
                            requestId: crypto.randomUUID(),
                            conferenceSolutionKey: { type: 'hangoutsMeet' },
                        },
                    };
                }

                let method = 'POST';
                let url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
                if (req.body.create_meet) url += '?conferenceDataVersion=1';

                if (task.google_event_id && !task.google_event_id.startsWith('GT_')) {
                    method = 'PUT';
                    const baseIdUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${task.google_event_id}`;
                    url = req.body.create_meet ? `${baseIdUrl}?conferenceDataVersion=1` : baseIdUrl;
                }

                const response = await fetch(url, {
                    method,
                    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(googleEvent),
                });

                const result = await response.json();
                if (response.ok) {
                    await supabaseAdmin.from('crm_tasks').update({
                        google_event_id: result.id,
                        google_etag: result.etag,
                        hangout_link: result.hangoutLink || result.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri || task.hangout_link,
                        attendees: result.attendees || task.attendees,
                        last_synced_at: new Date().toISOString(),
                    }).eq('id', taskId);
                    return res.json({ success: true, google_id: result.id, hangout_link: result.hangoutLink });
                }
                return res.status(response.status).json({ success: false, error: result });
            }
        }

        res.status(404).json({ error: 'Action not found' });
    } catch (error) {
        console.error('Calendar sync error:', error);
        res.status(400).json({ error: error.message });
    }
});

export default router;
