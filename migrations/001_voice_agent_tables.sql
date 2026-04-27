-- ============================================================
-- RE/MAX Exclusive — Voice Agent Tables
-- Ejecutar en: psql postgres://postgres:5a58ca9a00e2837be764@panel.remax-exclusive.cl:5432/postgres?sslmode=disable
-- ============================================================

CREATE TABLE IF NOT EXISTS voice_calls (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    retell_call_id    TEXT UNIQUE NOT NULL,
    direction         TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    from_phone        TEXT,
    to_phone          TEXT,
    status            TEXT DEFAULT 'ongoing' CHECK (status IN ('ongoing', 'completed', 'failed', 'no_answer')),
    duration_seconds  INTEGER,
    recording_url     TEXT,
    transcript        TEXT,
    summary           TEXT,
    sentiment         TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative')),
    intent            TEXT,
    action_taken      TEXT,
    campaign_id       UUID,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    ended_at          TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_calls_created    ON voice_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_calls_direction  ON voice_calls (direction);
CREATE INDEX IF NOT EXISTS idx_voice_calls_status     ON voice_calls (status);
CREATE INDEX IF NOT EXISTS idx_voice_calls_campaign   ON voice_calls (campaign_id);

-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_leads (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id           UUID REFERENCES voice_calls (id) ON DELETE CASCADE,
    name              TEXT,
    email             TEXT,
    phone             TEXT,
    operation_type    TEXT CHECK (operation_type IN ('compra', 'arriendo', 'venta', 'administracion', 'consulta')),
    property_interest TEXT,
    budget_range      TEXT,
    additional_info   JSONB DEFAULT '{}',
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_leads_call ON call_leads (call_id);

-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_actions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id       UUID REFERENCES voice_calls (id) ON DELETE CASCADE,
    action_type   TEXT NOT NULL,
    action_data   JSONB DEFAULT '{}',
    success       BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_actions_call ON call_actions (call_id);

-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outbound_campaigns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    type            TEXT DEFAULT 'debt_collection' CHECK (type IN ('debt_collection', 'follow_up', 'announcement')),
    status          TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'completed', 'paused')),
    scheduled_at    TIMESTAMPTZ,
    script_prompt   TEXT,
    total_contacts  INTEGER DEFAULT 0,
    calls_made      INTEGER DEFAULT 0,
    calls_answered  INTEGER DEFAULT 0,
    created_by      UUID,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status    ON outbound_campaigns (status);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled ON outbound_campaigns (scheduled_at) WHERE status = 'scheduled';

-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaign_contacts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id      UUID NOT NULL REFERENCES outbound_campaigns (id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    phone            TEXT NOT NULL,
    property_address TEXT,
    debt_amount      NUMERIC(12, 2),
    debt_months      INTEGER,
    manager_name     TEXT,
    manager_phone    TEXT,
    additional_data  JSONB DEFAULT '{}',
    call_status      TEXT DEFAULT 'pending' CHECK (call_status IN ('pending', 'called', 'no_answer', 'failed')),
    call_id          UUID REFERENCES voice_calls (id),
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign ON campaign_contacts (campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_status   ON campaign_contacts (call_status);
