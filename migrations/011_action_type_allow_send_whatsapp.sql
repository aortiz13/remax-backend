-- ============================================================
-- 011 — Allow 'send_whatsapp' in recruitment_automation_rules
--
-- The action_type column has a CHECK constraint that pre-dated the
-- send_whatsapp action introduced in migration 008. Inserting a rule
-- with action_type = 'send_whatsapp' was failing with:
--
--   new row for relation "recruitment_automation_rules" violates
--   check constraint "recruitment_automation_rules_action_type_check"
--
-- Drop the old constraint and re-add it with the WhatsApp value
-- whitelisted.
-- ============================================================

BEGIN;

ALTER TABLE recruitment_automation_rules
    DROP CONSTRAINT IF EXISTS recruitment_automation_rules_action_type_check;

ALTER TABLE recruitment_automation_rules
    ADD CONSTRAINT recruitment_automation_rules_action_type_check
    CHECK (action_type IN ('send_email', 'send_whatsapp', 'create_task'));

COMMIT;
