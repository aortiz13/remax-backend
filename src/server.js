import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createProxyMiddleware } from 'http-proxy-middleware';
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

// Internal service URLs (Docker network)
const GOTRUE_URL = process.env.GOTRUE_URL || 'http://remax-auth:9999';
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://remax-rest:3001';
const MINIO_INTERNAL_URL = `http://${process.env.MINIO_ENDPOINT || 'remax-storage'}:${process.env.MINIO_PORT || '9000'}`;

// =============================================
// MIDDLEWARE — MUST be before proxies for CORS
// =============================================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-client-info', 'x-supabase-api-version', 'range', 'prefer'],
}));

// =============================================
// REVERSE PROXY — Supabase-compatible paths
// These make @supabase/supabase-js work seamlessly
// =============================================

// /auth/v1/* → GoTrue
app.use('/auth/v1', createProxyMiddleware({
    target: GOTRUE_URL,
    changeOrigin: true,
    pathRewrite: { '^/auth/v1': '' },
    onError: (err, req, res) => {
        console.error('Auth proxy error:', err.message);
        res.status(502).json({ error: 'Auth service unavailable' });
    },
}));

// /rest/v1/* → PostgREST
app.use('/rest/v1', createProxyMiddleware({
    target: POSTGREST_URL,
    changeOrigin: true,
    pathRewrite: { '^/rest/v1': '' },
    onError: (err, req, res) => {
        console.error('REST proxy error:', err.message);
        res.status(502).json({ error: 'REST service unavailable' });
    },
}));

// /storage/v1/object/public/* → MinIO (public file access)
app.use('/storage/v1/object/public', createProxyMiddleware({
    target: MINIO_INTERNAL_URL,
    changeOrigin: true,
    pathRewrite: { '^/storage/v1/object/public': '' },
    onError: (err, req, res) => {
        console.error('Storage proxy error:', err.message);
        res.status(502).json({ error: 'Storage service unavailable' });
    },
}));

// Body parser (after proxies so they handle their own body parsing)
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/api/health', async (req, res) => {
    try {
        const dbResult = await pool.query('SELECT 1 AS ok');
        const redisOk = redis.status === 'ready';

        // Check GoTrue
        let authOk = false;
        try {
            const authRes = await fetch(`${GOTRUE_URL}/health`);
            authOk = authRes.ok;
        } catch { }

        // Check PostgREST
        let restOk = false;
        try {
            const restRes = await fetch(`${POSTGREST_URL}/`);
            restOk = restRes.ok;
        } catch { }

        res.json({
            status: 'ok',
            db: dbResult.rows[0]?.ok === 1 ? 'connected' : 'error',
            redis: redisOk ? 'connected' : 'disconnected',
            auth: authOk ? 'connected' : 'disconnected',
            rest: restOk ? 'connected' : 'disconnected',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// API routes (migrated Edge Functions)
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
    console.log(`🚀 RE/MAX API Gateway running on port ${PORT}`);
    console.log(`   Auth → ${GOTRUE_URL}`);
    console.log(`   REST → ${POSTGREST_URL}`);
    console.log(`   Storage → ${MINIO_INTERNAL_URL}`);
});
