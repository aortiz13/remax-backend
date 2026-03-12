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
import storageRoutes from './routes/storage.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Internal service URLs (Docker network)
const GOTRUE_URL = process.env.GOTRUE_URL || 'http://remax-auth:9999';
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://remax-rest:3001';
const MINIO_INTERNAL_URL = `http://${process.env.MINIO_ENDPOINT || 'remax-storage'}:${process.env.MINIO_PORT || '9000'}`;

// =============================================
// CORS — inject headers into ALL responses
// =============================================
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info, x-supabase-api-version, range, prefer, x-upsert, accept-profile, content-profile',
    'Access-Control-Expose-Headers': 'content-range, x-supabase-api-version',
};

// Handle ALL preflight OPTIONS globally
app.options('*', (req, res) => {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    res.status(204).end();
});

// Add CORS headers to every response
app.use((req, res, next) => {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    next();
});

// Helmet ONLY for non-proxy API routes (applied later)
// NOT here — it adds cross-origin-resource-policy: same-origin
// which blocks cross-origin fetch from the browser

// Helper: inject CORS headers AND remove blocking headers from proxied responses
const onProxyRes = (proxyRes) => {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => {
        proxyRes.headers[k] = v;
    });
    // Remove headers that block cross-origin access
    delete proxyRes.headers['cross-origin-resource-policy'];
    delete proxyRes.headers['cross-origin-opener-policy'];
    delete proxyRes.headers['cross-origin-embedder-policy'];
    delete proxyRes.headers['x-frame-options'];
};

// =============================================
// REVERSE PROXY — Supabase-compatible paths
// =============================================

// /auth/v1/* → GoTrue
app.use('/auth/v1', createProxyMiddleware({
    target: GOTRUE_URL,
    changeOrigin: true,
    pathRewrite: { '^/auth/v1': '' },
    onProxyRes,
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
    onProxyRes,
    onError: (err, req, res) => {
        console.error('REST proxy error:', err.message);
        res.status(502).json({ error: 'REST service unavailable' });
    },
}));

// /storage/v1/* → Supabase Storage-compatible API (MinIO backend)
app.use('/storage/v1', storageRoutes);

// =============================================
// MIDDLEWARE for API routes (after proxies)
// =============================================
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/api/health', async (req, res) => {
    try {
        const dbResult = await pool.query('SELECT 1 AS ok');
        const redisOk = redis.status === 'ready';

        let authOk = false;
        try {
            const authRes = await fetch(`${GOTRUE_URL}/health`);
            authOk = authRes.ok;
        } catch { }

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

// Legacy Supabase Edge Function path fallback
// Maps /functions/v1/<name> → /api/<route> for old frontend clients
const LEGACY_FUNCTION_MAP = {
    'google-calendar-sync': '/api/calendar/sync',
    'gmail-auth-url': '/api/gmail/auth-url',
    'gmail-auth-callback': '/api/gmail/callback',
    'gmail-send': '/api/gmail/send',
    'invite-agent': '/api/invite/agent',
    'admin-action': '/api/admin/action',
    'import-remax-listings': '/api/import/remax-listings',
    'google-auth': '/api/auth/google',
    'slack-error-alert': '/api/notifications/slack-alert',
    'generate-tts': '/api/tts/generate',
    'send-notification': '/api/notifications/send',
};

app.all('/functions/v1/:functionName', (req, res) => {
    const route = LEGACY_FUNCTION_MAP[req.params.functionName];
    if (!route) {
        return res.status(404).json({ error: `Unknown function: ${req.params.functionName}` });
    }
    // Internally redirect to the correct route
    req.url = route;
    app.handle(req, res);
});

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
