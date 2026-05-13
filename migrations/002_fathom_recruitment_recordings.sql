-- ============================================================
-- RE/MAX Exclusive — Fathom Recruitment Recordings
-- Adds Fathom.video integration columns to recruitment_meetings
-- so Pre-filtro meetings recorded by Fathom can be auto-ingested
-- via webhook and surfaced in the candidate timeline.
-- Ejecutar en: psql $DATABASE_URL -f migrations/002_fathom_recruitment_recordings.sql
-- ============================================================

ALTER TABLE recruitment_meetings
    ADD COLUMN IF NOT EXISTS fathom_recording_id TEXT,
    ADD COLUMN IF NOT EXISTS fathom_share_url    TEXT,
    ADD COLUMN IF NOT EXISTS fathom_meeting_url  TEXT,
    ADD COLUMN IF NOT EXISTS summary             TEXT,
    ADD COLUMN IF NOT EXISTS action_items        JSONB,
    ADD COLUMN IF NOT EXISTS meeting_source      TEXT DEFAULT 'desktop_recorder',
    ADD COLUMN IF NOT EXISTS ended_at            TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS invitee_emails      TEXT[];

-- Idempotent ingestion: prevent duplicate inserts from webhook retries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recruitment_meetings_fathom_recording
    ON recruitment_meetings (fathom_recording_id)
    WHERE fathom_recording_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recruitment_meetings_candidate_started
    ON recruitment_meetings (candidate_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_recruitment_meetings_source
    ON recruitment_meetings (meeting_source);

-- Webhook ingestion log (for audit / replay)
CREATE TABLE IF NOT EXISTS fathom_webhook_events (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type         TEXT NOT NULL,
    fathom_recording_id TEXT,
    candidate_id       UUID REFERENCES recruitment_candidates(id) ON DELETE SET NULL,
    meeting_id         UUID REFERENCES recruitment_meetings(id) ON DELETE SET NULL,
    matched_email      TEXT,
    status             TEXT NOT NULL CHECK (status IN ('ingested', 'no_match', 'duplicate', 'error')),
    error_message      TEXT,
    payload            JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fathom_webhook_received
    ON fathom_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_fathom_webhook_status
    ON fathom_webhook_events (status);
