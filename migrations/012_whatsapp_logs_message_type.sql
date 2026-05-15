-- ============================================================
-- 012 — Make recruitment_whatsapp_logs.message_type optional
--
-- An earlier (manual?) schema for recruitment_whatsapp_logs had a
-- NOT NULL `message_type` column that our INSERT statement didn't
-- supply, so /api/recruitment/candidates/:id/stage-changed failed
-- with:
--
--   null value in column "message_type" of relation
--   "recruitment_whatsapp_logs" violates not-null constraint
--
-- The application now writes message_type = 'outgoing' explicitly,
-- but we also drop the NOT NULL and set a default so any historical
-- row or future caller without the field doesn't break the insert.
-- ============================================================

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'recruitment_whatsapp_logs'
           AND column_name = 'message_type'
    ) THEN
        ALTER TABLE recruitment_whatsapp_logs
            ALTER COLUMN message_type DROP NOT NULL;
        ALTER TABLE recruitment_whatsapp_logs
            ALTER COLUMN message_type SET DEFAULT 'outgoing';
        UPDATE recruitment_whatsapp_logs
           SET message_type = 'outgoing'
         WHERE message_type IS NULL;
    END IF;
END$$;

COMMIT;
