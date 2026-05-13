-- Recruitment application form fields
-- Adds columns required by the public /postular form (replaces the Google Form)

ALTER TABLE recruitment_candidates
    ADD COLUMN IF NOT EXISTS birth_date       DATE,
    ADD COLUMN IF NOT EXISTS marital_status   TEXT,
    ADD COLUMN IF NOT EXISTS address          TEXT,
    ADD COLUMN IF NOT EXISTS current_company  TEXT,
    ADD COLUMN IF NOT EXISTS education_level  TEXT,
    ADD COLUMN IF NOT EXISTS application_submitted_at TIMESTAMPTZ;
