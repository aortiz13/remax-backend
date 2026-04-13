import express from 'express';
import Busboy from 'busboy';
import crypto from 'crypto';
import pool from '../lib/db.js';
import { uploadFile, getPublicUrl } from '../lib/storage.js';
import authMiddleware from '../middleware/auth.js';
import { extractFormFromTranscript } from '../services/openaiExtractor.js';
import { transcribeAudio } from '../services/openaiTranscriber.js';

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// ─── GET /api/meetings/me — Current user profile (for extension login) ────
router.get('/me', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, CONCAT(first_name, ' ', COALESCE(last_name, '')) AS full_name, email, role, avatar_url 
             FROM profiles WHERE id = $1`,
            [req.user.id || req.user.sub]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Profile not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('GET /me error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/meetings/candidates/search — Search candidates ──────────────
router.get('/candidates/search', async (req, res) => {
    try {
        const q = req.query.q?.trim();
        if (!q || q.length < 2) return res.json([]);

        const { rows } = await pool.query(
            `SELECT id, first_name, last_name, email, phone, pipeline_stage
             FROM recruitment_candidates
             WHERE (first_name || ' ' || COALESCE(last_name, '')) ILIKE $1
                OR email ILIKE $1
                OR phone ILIKE $1
             ORDER BY updated_at DESC
             LIMIT 10`,
            [`%${q}%`]
        );
        res.json(rows);
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/meetings/upload — Upload recording & transcribe ────────────
router.post('/upload', (req, res) => {
    const busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
    });

    let audioBuffer = null;
    let candidateId = null;
    let platform = 'google_meet';
    let audioContentType = 'audio/webm';

    busboy.on('file', (fieldname, file, info) => {
        if (fieldname === 'audio') {
            const chunks = [];
            audioContentType = info.mimeType || 'audio/webm';
            file.on('data', (chunk) => chunks.push(chunk));
            file.on('end', () => {
                audioBuffer = Buffer.concat(chunks);
            });
        }
    });

    busboy.on('field', (name, val) => {
        if (name === 'candidate_id') candidateId = val;
        if (name === 'platform') platform = val;
    });

    busboy.on('finish', async () => {
        try {
            if (!audioBuffer || !candidateId) {
                return res.status(400).json({ error: 'Missing audio file or candidate_id' });
            }

            const userId = req.user.id || req.user.sub;
            const meetingId = crypto.randomUUID();
            const fileExt = audioContentType.includes('webm') ? 'webm' : 'ogg';
            const storagePath = `recruitment-recordings/${candidateId}/${meetingId}.${fileExt}`;

            // 1. Upload audio to MinIO
            console.log(`[Meetings] Uploading ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB to ${storagePath}`);
            const recordingUrl = await uploadFile('remax-storage', storagePath, audioBuffer, audioContentType);

            // 2. Transcribe with OpenAI Whisper
            console.log('[Meetings] Transcribing with OpenAI Whisper...');
            let transcriptText = '';
            let transcriptJson = null;
            try {
                const whisperResult = await transcribeAudio(audioBuffer, fileExt);
                transcriptText = whisperResult.text || '';
                transcriptJson = whisperResult.segments || null;
                console.log(`[Meetings] Transcription complete: ${transcriptText.length} chars`);
            } catch (transcribeErr) {
                console.error('[Meetings] Transcription error (continuing):', transcribeErr.message);
                transcriptText = '[Error en transcripción: ' + transcribeErr.message + ']';
            }

            // 3. Calculate duration from audio (approximate from buffer size and bitrate)
            const durationSeconds = Math.round(audioBuffer.length / (128000 / 8)); // approx for 128kbps

            // 4. Insert into database
            const { rows } = await pool.query(
                `INSERT INTO recruitment_meetings 
                 (id, candidate_id, recording_url, recording_duration_seconds, recording_format,
                  transcript_text, transcript_json, meeting_type, meeting_platform,
                  recorded_by, started_at, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW(), NOW())
                 RETURNING *`,
                [
                    meetingId, candidateId, recordingUrl, durationSeconds, fileExt,
                    transcriptText, JSON.stringify(transcriptJson),
                    'recruitment_interview', platform, userId,
                ]
            );

            console.log(`[Meetings] ✅ Meeting ${meetingId} created for candidate ${candidateId}`);
            res.json({ meeting: rows[0] });

        } catch (err) {
            console.error('[Meetings] Upload error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    busboy.on('error', (err) => {
        console.error('[Meetings] Busboy error:', err);
        res.status(500).json({ error: 'File upload error' });
    });

    req.pipe(busboy);
});

// ─── POST /api/meetings/:id/extract-form — Extract form fields with GPT-4o ─
router.post('/:id/extract-form', async (req, res) => {
    try {
        const meetingId = req.params.id;

        // Get the meeting transcript
        const { rows: meetings } = await pool.query(
            'SELECT transcript_text FROM recruitment_meetings WHERE id = $1',
            [meetingId]
        );
        if (!meetings[0]) return res.status(404).json({ error: 'Meeting not found' });
        if (!meetings[0].transcript_text) return res.status(400).json({ error: 'No transcript available' });

        // Extract form with GPT-4o
        console.log(`[Meetings] Extracting form from meeting ${meetingId}...`);
        const extractedForm = await extractFormFromTranscript(meetings[0].transcript_text);

        // Save to database
        await pool.query(
            `UPDATE recruitment_meetings 
             SET extracted_form = $1, updated_at = NOW()
             WHERE id = $2`,
            [JSON.stringify(extractedForm), meetingId]
        );

        console.log(`[Meetings] ✅ Form extracted for meeting ${meetingId}`);
        res.json({ extracted_form: extractedForm });

    } catch (err) {
        console.error('[Meetings] Extract form error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/meetings/:id/apply-form — Apply extracted form to candidate ──
router.post('/:id/apply-form', async (req, res) => {
    try {
        const meetingId = req.params.id;
        const userId = req.user.id || req.user.sub;
        const overrides = req.body.overrides || {}; // Allow manual field overrides

        // Get meeting with extracted form
        const { rows: meetings } = await pool.query(
            'SELECT candidate_id, extracted_form FROM recruitment_meetings WHERE id = $1',
            [meetingId]
        );
        if (!meetings[0]) return res.status(404).json({ error: 'Meeting not found' });

        const form = { ...(meetings[0].extracted_form || {}), ...overrides };
        const candidateId = meetings[0].candidate_id;

        // Build update query dynamically
        const updates = [];
        const values = [];
        let idx = 1;

        if (form.first_name) { updates.push(`first_name = $${idx++}`); values.push(form.first_name); }
        if (form.last_name) { updates.push(`last_name = $${idx++}`); values.push(form.last_name); }
        if (form.age) { updates.push(`age = $${idx++}`); values.push(Number(form.age)); }
        if (form.current_occupation) { updates.push(`job_title = $${idx++}`); values.push(form.current_occupation); }
        if (form.is_available_full_time !== undefined && form.is_available_full_time !== null) {
            // Map full-time availability to trabajo_fijo_actual (inverse logic)
            updates.push(`trabajo_fijo_actual = $${idx++}`);
            values.push(!form.is_available_full_time); // If available full-time → no tiene trabajo fijo
        }

        updates.push(`updated_at = NOW()`);

        if (updates.length > 1) { // More than just updated_at
            values.push(candidateId);
            await pool.query(
                `UPDATE recruitment_candidates SET ${updates.join(', ')} WHERE id = $${idx}`,
                values
            );
        }

        // Mark form as applied
        await pool.query(
            `UPDATE recruitment_meetings 
             SET form_applied = true, form_applied_at = NOW(), form_applied_by = $1, updated_at = NOW()
             WHERE id = $2`,
            [userId, meetingId]
        );

        console.log(`[Meetings] ✅ Form applied to candidate ${candidateId} from meeting ${meetingId}`);
        res.json({ success: true, candidate_id: candidateId });

    } catch (err) {
        console.error('[Meetings] Apply form error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/meetings/candidate/:candidateId — List meetings for a candidate
router.get('/candidate/:candidateId', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT m.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) AS recorder_name
             FROM recruitment_meetings m
             LEFT JOIN profiles p ON p.id = m.recorded_by
             WHERE m.candidate_id = $1
             ORDER BY m.created_at DESC`,
            [req.params.candidateId]
        );
        res.json(rows);
    } catch (err) {
        console.error('[Meetings] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/meetings/:id — Get a single meeting ────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT m.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) AS recorder_name
             FROM recruitment_meetings m
             LEFT JOIN profiles p ON p.id = m.recorded_by
             WHERE m.id = $1`,
            [req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Meeting not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('[Meetings] Get error:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;
