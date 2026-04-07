import express from 'express';
import pool from '../lib/db.js';

const router = express.Router();

/**
 * GET /api/tracking/open/:tracking_id
 * Invoked by the 1x1 tracking pixel embedded in emails.
 */
router.get('/open/:tracking_id', async (req, res) => {
    try {
        const { tracking_id } = req.params;
        const userAgent = req.headers['user-agent'] || '';

        // Generate 1x1 transparent GIF buffer
        const transparentGif = Buffer.from(
            'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
            'base64'
        );

        // Always return the image immediately, but set headers so it's not cached
        res.set({
            'Content-Type': 'image/gif',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.send(transparentGif);

        // Check if tracking_id is a valid UUID to avoid SQL errors
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tracking_id)) {
            return;
        }

        // Detect Apple Mail Privacy Protection (often uses Mozilla/5.0 with no OS info, or CFNetwork) 
        // Detect Gmail Image Proxy (GoogleImageProxy)
        const isBotProxy = userAgent.includes('GoogleImageProxy') || userAgent.includes('Yahoo') || /bot|crawl|spider/i.test(userAgent);

        // Fetch the email record
        const emailRecordRes = await pool.query(`SELECT id, contact_id, opens_count, created_at, subject FROM email_tracking_logs WHERE id = $1`, [tracking_id]);
        if (emailRecordRes.rows.length === 0) return;

        const emailRow = emailRecordRes.rows[0];
        const contactId = emailRow.contact_id;
        if (!contactId) return; // If there is no contact attached, no need to log to CRM timeline

        // Calculate time-to-open to filter Apple Mail automatic pre-fetching
        const createdDate = new Date(emailRow.created_at);
        const timeDiffSeconds = (new Date() - createdDate) / 1000;
        
        // If it's opened in less than 5 seconds from creation, it's likely an automated proxy pre-load
        const isLikelyPreload = timeDiffSeconds < 5;

        // Still update the open count for analytics, but maybe don't blast the timeline if it's fake
        await pool.query(`
            UPDATE email_tracking_logs 
            SET opens_count = opens_count + 1, last_opened_at = NOW() 
            WHERE id = $1
        `, [tracking_id]);

        // Only log to timeline IF it's the first open AND it passes proxy/bot checks
        if (emailRow.opens_count === 0 && !isBotProxy && !isLikelyPreload) {
            await pool.query(`
                INSERT INTO activity_logs (actor_id, action, entity_type, entity_id, description, details, contact_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                null, // System actor
                'Email Opened',
                'EmailTracking',
                tracking_id,
                `El contacto leyó el correo: "${emailRow.subject || 'Sin asunto'}"`,
                { tracking_id, is_real_open: true },
                contactId
            ]);
        }
    } catch (err) {
        console.error('Error tracking email open:', err.message);
    }
});

/**
 * GET /api/tracking/click/:tracking_id
 * Invoked when a link inside an email is clicked.
 */
router.get('/click/:tracking_id', async (req, res) => {
    try {
        const { tracking_id } = req.params;
        const targetUrl = req.query.url;

        if (!targetUrl) {
            return res.status(400).send('Missing URL');
        }

        // Immediately redirect the user to not block UX
        res.redirect(302, targetUrl);

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tracking_id)) {
            return;
        }

        // Fetch the email record
        const emailRecordRes = await pool.query(`SELECT id, contact_id, subject FROM email_tracking_logs WHERE id = $1`, [tracking_id]);
        if (emailRecordRes.rows.length === 0) return;

        const emailRow = emailRecordRes.rows[0];
        const contactId = emailRow.contact_id;
        
        // Update click count in async
        await pool.query(`
            UPDATE email_tracking_logs 
            SET clicks_count = clicks_count + 1, last_clicked_at = NOW() 
            WHERE id = $1
        `, [tracking_id]);

        if (contactId) {
            await pool.query(`
                INSERT INTO activity_logs (actor_id, action, entity_type, entity_id, description, details, contact_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                null,
                'Email Link Clicked',
                'EmailTracking',
                tracking_id,
                `El contacto hizo clic en un enlace del correo: "${emailRow.subject || 'Sin asunto'}"`,
                { tracking_id, clicked_url: targetUrl },
                contactId
            ]);
        }
    } catch (err) {
        console.error('Error tracking email click:', err.message);
    }
});

export default router;
