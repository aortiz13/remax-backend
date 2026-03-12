import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import authMiddleware from '../middleware/auth.js';

const router = Router();
const jsonParser = express.json({ limit: '10mb' }); // Only for routes that need JSON body

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'remax-storage';
const MINIO_PORT = process.env.MINIO_PORT || '9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ROOT_USER || process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_ROOT_PASSWORD || process.env.MINIO_SECRET_KEY || 'minioadmin';
const SIGN_SECRET = process.env.GOTRUE_JWT_SECRET || 'storage-sign-secret';

const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: `http://${MINIO_ENDPOINT}:${MINIO_PORT}`,
    forcePathStyle: true,
    credentials: {
        accessKeyId: MINIO_ACCESS_KEY,
        secretAccessKey: MINIO_SECRET_KEY,
    },
});

// S3/MinIO requires hyphens in bucket names, but Supabase uses underscores
function normalizeBucket(name) {
    return name.replace(/_/g, '-');
}

// Helper: create a simple signed token for file access
function createSignToken(bucket, key, expiresAt) {
    const payload = `${bucket}:${key}:${expiresAt}`;
    return crypto.createHmac('sha256', SIGN_SECRET).update(payload).digest('hex');
}

function verifySignToken(bucket, key, expiresAt, token) {
    const expected = createSignToken(bucket, key, expiresAt);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token)) && Date.now() < expiresAt;
}

// POST /storage/v1/object/sign/:bucket/*path — Create signed URLs (Supabase-compatible)
router.post('/object/sign/:bucket/*', jsonParser, authMiddleware, async (req, res) => {
    try {
        const bucket = normalizeBucket(req.params.bucket);
        const key = req.params[0];
        const expiresIn = req.body?.expiresIn || 3600;
        const expiresAt = Date.now() + (expiresIn * 1000);
        const token = createSignToken(bucket, key, expiresAt);

        // Return a relative path — Supabase client prepends {baseUrl}/storage/v1
        const signedURL = `/object/sign/${bucket}/${key}?token=${token}&expires=${expiresAt}`;

        res.json({ signedURL });
    } catch (error) {
        console.error('Storage sign error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// GET /storage/v1/object/sign/:bucket/*path — Serve signed file (proxied from MinIO)
router.get('/object/sign/:bucket/*', async (req, res) => {
    try {
        const bucket = normalizeBucket(req.params.bucket);
        const key = req.params[0];
        const { token, expires } = req.query;

        console.log(`[Storage] GET sign request: bucket=${bucket}, key=${key}, hasToken=${!!token}, expires=${expires}`);

        if (!token || !expires || !verifySignToken(bucket, key, parseInt(expires), token)) {
            console.log(`[Storage] Token verification failed`);
            return res.status(403).json({ error: 'Invalid or expired signed URL' });
        }

        console.log(`[Storage] Token verified, fetching from MinIO: ${MINIO_ENDPOINT}:${MINIO_PORT}/${bucket}/${key}`);
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const response = await s3.send(command);

        // Determine content type from key
        const ext = key.split('.').pop()?.toLowerCase();
        const contentTypes = {
            pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
            gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
            doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
            ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
            zip: 'application/zip', txt: 'text/plain', csv: 'text/csv',
        };

        res.set('Content-Type', response.ContentType || contentTypes[ext] || 'application/octet-stream');
        if (response.ContentLength) res.set('Content-Length', String(response.ContentLength));
        res.set('Cache-Control', 'private, max-age=3600');
        // Allow iframe embedding for preview
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('Cross-Origin-Embedder-Policy');
        res.set('Content-Disposition', 'inline');
        res.set('X-Content-Type-Options', 'nosniff');

        response.Body.pipe(res);
    } catch (error) {
        console.error('[Storage] Signed download error:', error.name, error.message, error.$metadata?.httpStatusCode);
        res.status(404).json({ error: 'File not found', details: error.message });
    }
});

// POST /storage/v1/object/:bucket/*path — Upload file (Supabase-compatible)
router.post('/object/:bucket/*', authMiddleware, async (req, res) => {
    try {
        const bucket = normalizeBucket(req.params.bucket);
        const key = req.params[0];

        // Collect raw body
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);

        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: req.headers['content-type'] || 'application/octet-stream',
        }));

        res.json({ Key: `${bucket}/${key}`, Id: key });
    } catch (error) {
        console.error('Storage upload error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// PUT /storage/v1/object/:bucket/*path — Upload/update file
router.put('/object/:bucket/*', authMiddleware, async (req, res) => {
    try {
        const bucket = normalizeBucket(req.params.bucket);
        const key = req.params[0];

        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);

        await s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: req.headers['content-type'] || 'application/octet-stream',
        }));

        res.json({ Key: `${bucket}/${key}`, Id: key });
    } catch (error) {
        console.error('Storage update error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// DELETE /storage/v1/object/:bucket — Remove files (Supabase sends { prefixes: [...] })
router.delete('/object/:bucket', jsonParser, authMiddleware, async (req, res) => {
    try {
        const bucket = normalizeBucket(req.params.bucket);
        const { prefixes } = req.body || {};

        if (Array.isArray(prefixes) && prefixes.length > 0) {
            await s3.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: prefixes.map(p => ({ Key: p })) },
            }));
        }

        res.json([]);
    } catch (error) {
        console.error('Storage delete error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// GET /storage/v1/object/public/:bucket/*path — Download public file (proxied)
router.get('/object/public/:bucket/*', async (req, res) => {
    try {
        const bucket = normalizeBucket(req.params.bucket);
        const key = req.params[0];

        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

        res.set('Content-Type', response.ContentType || 'application/octet-stream');
        if (response.ContentLength) res.set('Content-Length', String(response.ContentLength));

        response.Body.pipe(res);
    } catch (error) {
        console.error('Storage public download error:', error.message);
        res.status(404).json({ error: 'File not found' });
    }
});

// GET /storage/v1/object/authenticated/:bucket/*path — Download authenticated file
router.get('/object/authenticated/:bucket/*', authMiddleware, async (req, res) => {
    try {
        const bucket = normalizeBucket(req.params.bucket);
        const key = req.params[0];

        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

        res.set('Content-Type', response.ContentType || 'application/octet-stream');
        if (response.ContentLength) res.set('Content-Length', String(response.ContentLength));

        response.Body.pipe(res);
    } catch (error) {
        console.error('Storage auth download error:', error.message);
        res.status(404).json({ error: 'File not found' });
    }
});

export default router;
