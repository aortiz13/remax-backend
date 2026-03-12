import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pool from './lib/db.js';
import redis from './lib/redis.js';

// Routes
import authRoutes from './routes/auth.js';
import gmailRoutes from './routes/gmail.js';
import calendarRoutes from './routes/calendar.js';
import adminRoutes from './routes/admin.js';
import importRoutes from './routes/import.js';
import inviteRoutes from './routes/invite.js';
import webhookRoutes from './routes/webhooks.js';
import notificationRoutes from './routes/notifications.js';
import ttsRoutes from './routes/tts.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-client-info'],
}));
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/api/health', async (req, res) => {
    try {
        const dbResult = await pool.query('SELECT 1 AS ok');
        const redisOk = redis.status === 'ready';
        res.json({
            status: 'ok',
            db: dbResult.rows[0]?.ok === 1 ? 'connected' : 'error',
            redis: redisOk ? 'connected' : 'disconnected',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/gmail', gmailRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/import', importRoutes);
app.use('/api/invite', inviteRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/tts', ttsRoutes);

// Global error handler
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 RE/MAX API Server running on port ${PORT}`);
});
