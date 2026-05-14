-- ============================================================
-- 005 — Rule-driven post-meeting automation
--
-- 1. Adds attachments_json to recruitment_automation_rules so each
--    email rule can have its own attached files.
-- 2. Seeds the default Aprobado / Desaprobado rules using the
--    is_default templates from migration 004. The Aprobado rule
--    carries the "Por qué ser un Agente RE/MAX" PDF as attachment.
--
-- Idempotent: skips inserts if a rule already exists for that
-- stage + action_type combination.
-- ============================================================

BEGIN;

ALTER TABLE recruitment_automation_rules
    ADD COLUMN IF NOT EXISTS attachments_json JSONB DEFAULT '[]'::jsonb;

-- Default Aprobado rule: send Aprobación template + PDF attachment
INSERT INTO recruitment_automation_rules (
    trigger_stage, action_type, template_id, attachments_json,
    is_active, ab_enabled, delay_minutes, created_at, updated_at
)
SELECT
    'aprobado',
    'send_email',
    (SELECT id FROM recruitment_email_templates
        WHERE category = 'Aprobación' AND is_default = true
        ORDER BY updated_at DESC NULLS LAST LIMIT 1),
    jsonb_build_array(
        jsonb_build_object(
            'url', 'https://res.cloudinary.com/dhzmkxbek/image/upload/v1771201266/Por_que%CC%81_ser_un_Agente_REMAX_-_I_Trimestre_2026_veqbvc.pdf',
            'filename', 'Por que ser un Agente RE-MAX.pdf',
            'mimeType', 'application/pdf'
        )
    ),
    true,
    false,
    0,
    NOW(),
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM recruitment_automation_rules
     WHERE trigger_stage = 'aprobado' AND action_type = 'send_email'
);

-- Default Desaprobado rule: send Rechazo template (no attachment)
INSERT INTO recruitment_automation_rules (
    trigger_stage, action_type, template_id, attachments_json,
    is_active, ab_enabled, delay_minutes, created_at, updated_at
)
SELECT
    'desaprobado',
    'send_email',
    (SELECT id FROM recruitment_email_templates
        WHERE category = 'Rechazo' AND is_default = true
        ORDER BY updated_at DESC NULLS LAST LIMIT 1),
    '[]'::jsonb,
    true,
    false,
    0,
    NOW(),
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM recruitment_automation_rules
     WHERE trigger_stage = 'desaprobado' AND action_type = 'send_email'
);

COMMIT;
