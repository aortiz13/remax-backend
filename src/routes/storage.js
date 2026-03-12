import { Router } from 'express';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import authMiddleware from '../middleware/auth.js';

const router = Router();

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'remax-storage';
const MINIO_PORT = process.env.MINIO_PORT || '9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ROOT_USER || process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_ROOT_PASSWORD || process.env.MINIO_SECRET_KEY || 'minioadmin';
const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL || `https://remax-crm-remax-storage.jzuuqr.easypanel.host`;

const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: `http://${MINIO_ENDPOINT}:${MINIO_PORT}`,
    forcePathStyle: true,
    credentials: {
        accessKeyId: MINIO_ACCESS_KEY,
        secretAccessKey: MINIO_SECRET_KEY,
    },
});

// POST /storage/v1/object/sign/:bucket/*path — Create signed URLs (Supabase-compatible)
router.post('/object/sign/:bucket/*', authMiddleware, async (req, res) => {
    try {
        const bucket = req.params.bucket;
        const key = req.params[0]; // wildcard path
        const { expiresIn } = req.body;
        const expiry = expiresIn || 3600;

        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const signedUrl = await getSignedUrl(s3, command, { expiresIn: expiry });

        // Replace internal URL with public URL
        const publicUrl = signedUrl.replace(`http://${MINIO_ENDPOINT}:${MINIO_PORT}`, MINIO_PUBLIC_URL);

        res.json({
            signedURL: publicUrl,
            signedUrl: publicUrl, // Supabase client uses both
        });
    } catch (error) {
        console.error('Storage sign error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// POST /storage/v1/object/:bucket/*path — Upload file (Supabase-compatible)
router.post('/object/:bucket/*', authMiddleware, async (req, res) => {
    try {
        const bucket = req.params.bucket;
        const key = req.params[0];

        // Collect raw body
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);

        const command = new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: req.headers['content-type'] || 'application/octet-stream',
        });

        await s3.send(command);

        res.json({
            Key: `${bucket}/${key}`,
            Id: key,
        });
    } catch (error) {
        console.error('Storage upload error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// PUT /storage/v1/object/:bucket/*path — Upload/update file (alternative)
router.put('/object/:bucket/*', authMiddleware, async (req, res) => {
    try {
        const bucket = req.params.bucket;
        const key = req.params[0];

        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);

        const command = new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: req.headers['content-type'] || 'application/octet-stream',
        });

        await s3.send(command);
        res.json({ Key: `${bucket}/${key}`, Id: key });
    } catch (error) {
        console.error('Storage update error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// DELETE /storage/v1/object/:bucket — Remove files (Supabase sends array of paths)
router.delete('/object/:bucket', authMiddleware, async (req, res) => {
    try {
        const bucket = req.params.bucket;
        const { prefixes } = req.body; // Supabase client sends { prefixes: [...paths] }

        if (Array.isArray(prefixes)) {
            const deleteParams = {
                Bucket: bucket,
                Delete: {
                    Objects: prefixes.map(p => ({ Key: p })),
                },
            };
            await s3.send(new DeleteObjectsCommand(deleteParams));
        }

        res.json([]);
    } catch (error) {
        console.error('Storage delete error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// GET /storage/v1/object/public/:bucket/*path — Download public file
router.get('/object/public/:bucket/*', async (req, res) => {
    try {
        const bucket = req.params.bucket;
        const key = req.params[0];

        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const response = await s3.send(command);

        res.set('Content-Type', response.ContentType || 'application/octet-stream');
        if (response.ContentLength) res.set('Content-Length', String(response.ContentLength));

        response.Body.pipe(res);
    } catch (error) {
        console.error('Storage public download error:', error.message);
        res.status(404).json({ error: 'File not found' });
    }
});

// GET /storage/v1/object/sign/:bucket/*path — Redirect to signed URL 
router.get('/object/sign/:bucket/*', async (req, res) => {
    try {
        const bucket = req.params.bucket;
        const key = req.params[0];
        const token = req.query.token;

        // If there's a token query param, it's a pre-signed URL redirect
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
        const publicUrl = signedUrl.replace(`http://${MINIO_ENDPOINT}:${MINIO_PORT}`, MINIO_PUBLIC_URL);

        res.redirect(publicUrl);
    } catch (error) {
        console.error('Storage sign redirect error:', error.message);
        res.status(404).json({ error: 'File not found' });
    }
});

// GET /storage/v1/object/authenticated/:bucket/*path — Download authenticated file
router.get('/object/authenticated/:bucket/*', authMiddleware, async (req, res) => {
    try {
        const bucket = req.params.bucket;
        const key = req.params[0];

        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const response = await s3.send(command);

        res.set('Content-Type', response.ContentType || 'application/octet-stream');
        if (response.ContentLength) res.set('Content-Length', String(response.ContentLength));

        response.Body.pipe(res);
    } catch (error) {
        console.error('Storage auth download error:', error.message);
        res.status(404).json({ error: 'File not found' });
    }
});

export default router;
