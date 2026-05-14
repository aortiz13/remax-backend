-- Migration 006: Bidirectional Google Calendar sync for recruitment
-- Connects emprendedores@remax-exclusive.cl's Google Calendar with recruitment_tasks.

ALTER TABLE gmail_accounts
    ADD COLUMN IF NOT EXISTS calendar_sync_token TEXT,
    ADD COLUMN IF NOT EXISTS calendar_watch_channel_id TEXT,
    ADD COLUMN IF NOT EXISTS calendar_watch_resource_id TEXT,
    ADD COLUMN IF NOT EXISTS calendar_watch_expiration TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS calendar_id TEXT DEFAULT 'primary';

ALTER TABLE recruitment_tasks
    ADD COLUMN IF NOT EXISTS google_event_id TEXT,
    ADD COLUMN IF NOT EXISTS google_etag TEXT,
    ADD COLUMN IF NOT EXISTS is_external BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS send_invitation BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS location TEXT,
    ADD COLUMN IF NOT EXISTS last_google_sync_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_recruitment_tasks_google_event_id
    ON recruitment_tasks(google_event_id)
    WHERE google_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gmail_accounts_calendar_channel_id
    ON gmail_accounts(calendar_watch_channel_id)
    WHERE calendar_watch_channel_id IS NOT NULL;
