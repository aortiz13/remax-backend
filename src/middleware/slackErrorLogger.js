import { slackQueue } from '../queues/index.js';
import pool from '../lib/db.js';

/**
 * Log an error to both console, the database (system_audit_logs), and Slack via BullMQ queue.
 * Non-blocking: failures are silently ignored.
 *
 * @param {'error'|'warning'} level
 * @param {{ category: string, action: string, message: string, module?: string, details?: object, error_code?: string }} opts
 */
export async function logErrorToSlack(level, { category, action, message, module, details, error_code }) {
    console.error(`[${level}] ${category}/${action}: ${message}`);

    // 1. Persist to system_audit_logs (works even if Redis/Slack is down)
    try {
        await pool.query(
            `INSERT INTO system_audit_logs (level, category, action, message, module, details, error_code)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
            [level, category, action, message, module || null, details ? JSON.stringify(details) : null, error_code || null]
        );
    } catch {
        // DB write is non-critical — do not let it break the flow
    }

    // 2. Send to Slack via BullMQ queue
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
