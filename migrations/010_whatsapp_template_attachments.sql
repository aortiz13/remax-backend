-- ============================================================
-- 010 — Attachments for recruitment WhatsApp templates
--
-- Stores a JSONB array of attachments alongside each WhatsApp template:
--   [{ url, filename, mimeType, size }, ...]
--
-- Each attachment is uploaded via /api/recruitment/upload-attachment
-- (same endpoint used by email rule attachments) which puts the file
-- in MinIO and returns the public URL. At send time, the recruitment
-- WhatsApp worker downloads each URL and forwards the bytes to
-- Chatwoot as multipart attachments[].
--
-- WhatsApp Business hard limits per file: 16 MB for video / audio,
-- 5 MB for image, 100 MB for documents. The frontend enforces a 25 MB
-- generic limit (same as the email upload route) — anything larger
-- gets rejected at upload time.
-- ============================================================

BEGIN;

ALTER TABLE recruitment_whatsapp_templates
    ADD COLUMN IF NOT EXISTS attachments_json JSONB DEFAULT '[]'::jsonb;

COMMIT;
