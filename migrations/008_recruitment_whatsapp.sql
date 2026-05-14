-- ============================================================
-- 008 — Recruitment WhatsApp automation (via Chatwoot)
--
-- Mirrors the email automation flow but for WhatsApp messages sent
-- through the self-hosted Chatwoot instance at wssp.remax-exclusive.cl.
--
-- Adds:
--   1. recruitment_whatsapp_templates: reusable message bodies with
--      Mustache-style placeholders ({{nombre}}, {{evento:...}}, etc.).
--   2. recruitment_whatsapp_logs: one row per send attempt (status,
--      content, chatwoot ids, etc.) — same shape as the email logs.
--   3. chatwoot_contact_id / chatwoot_conversation_id on
--      recruitment_candidates so we don't re-create a contact every time.
--   4. whatsapp_template_id (+ ab_whatsapp_template_b_id) on
--      recruitment_automation_rules so a rule with action_type =
--      'send_whatsapp' can pick a template and optionally A/B-test it.
-- ============================================================

BEGIN;

-- ─── 1. Templates ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recruitment_whatsapp_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    body        TEXT NOT NULL,
    category    TEXT DEFAULT 'General',
    is_default  BOOLEAN DEFAULT FALSE,
    created_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_category
    ON recruitment_whatsapp_templates(category);

-- ─── 2. Logs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recruitment_whatsapp_logs (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id             UUID,
    template_id              UUID,
    ab_variant               TEXT,           -- 'A' | 'B' | NULL
    body                     TEXT NOT NULL,
    to_phone                 TEXT,
    chatwoot_contact_id      BIGINT,
    chatwoot_conversation_id BIGINT,
    chatwoot_message_id      BIGINT,
    status                   TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed
    sent_at                  TIMESTAMPTZ DEFAULT NOW(),
    metadata                 JSONB
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_candidate
    ON recruitment_whatsapp_logs(candidate_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_status
    ON recruitment_whatsapp_logs(status);

-- ─── 3. Chatwoot ids cached on the candidate ────────────────────
ALTER TABLE recruitment_candidates
    ADD COLUMN IF NOT EXISTS chatwoot_contact_id      BIGINT,
    ADD COLUMN IF NOT EXISTS chatwoot_conversation_id BIGINT;

-- ─── 4. Rule columns for the new action_type 'send_whatsapp' ────
ALTER TABLE recruitment_automation_rules
    ADD COLUMN IF NOT EXISTS whatsapp_template_id          UUID,
    ADD COLUMN IF NOT EXISTS ab_whatsapp_template_b_id     UUID;

-- FK constraints so PostgREST can resolve the joins. SET NULL on delete
-- so dropping a template doesn't cascade and break the automation rule.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name = 'recruitment_automation_rules_whatsapp_template_fk'
    ) THEN
        ALTER TABLE recruitment_automation_rules
            ADD CONSTRAINT recruitment_automation_rules_whatsapp_template_fk
            FOREIGN KEY (whatsapp_template_id)
            REFERENCES recruitment_whatsapp_templates(id)
            ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name = 'recruitment_automation_rules_ab_whatsapp_template_b_fk'
    ) THEN
        ALTER TABLE recruitment_automation_rules
            ADD CONSTRAINT recruitment_automation_rules_ab_whatsapp_template_b_fk
            FOREIGN KEY (ab_whatsapp_template_b_id)
            REFERENCES recruitment_whatsapp_templates(id)
            ON DELETE SET NULL;
    END IF;
END$$;

COMMIT;
