import { slackQueue } from '../queues/index.js';

/**
 * Log an error to both console and Slack via BullMQ queue.
 * Non-blocking: Slack failures are silently ignored.
 *
 * @param {'error'|'warning'} level
 * @param {{ category: string, action: string, message: string, module?: string, details?: object, error_code?: string }} opts
 */
export async function logErrorToSlack(level, { category, action, message, module, details, error_code }) {
    console.error(`[${level}] ${category}/${action}: ${message}`);
    try {
        await slackQueue.add('slack-alert', {
            level,
            category,
            action,
            message,
            module,
            details,
            error_code,
        }, {
            attempts: 2,
            backoff: { type: 'exponential', delay: 2000 },
        });
    } catch {
        // Slack alert is non-critical — do not let it break the flow
    }
}
