import { Queue } from 'bullmq';
import { redisConnection } from '../lib/redis.js';

const defaultOpts = { connection: redisConnection };

export const emailQueue = new Queue('email', defaultOpts);
export const calendarQueue = new Queue('calendar', defaultOpts);
export const importQueue = new Queue('import', defaultOpts);
export const notificationQueue = new Queue('notification', defaultOpts);
export const ttsQueue = new Queue('tts', defaultOpts);
export const slackQueue = new Queue('slack-alert', defaultOpts);
export const inviteQueue = new Queue('invite', defaultOpts);
export const cleanupQueue = new Queue('cleanup', defaultOpts);
export const gmailWebhookQueue = new Queue('gmail-webhook', defaultOpts);
export const calendarWebhookQueue = new Queue('calendar-webhook', defaultOpts);
export const youtubeQueue = new Queue('youtube-sync', defaultOpts);
export const cameraReminderQueue = new Queue('camera-reminder', defaultOpts);

console.log('📋 All BullMQ queues initialized');
