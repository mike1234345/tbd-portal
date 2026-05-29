-- ============================================================
-- TBD Marketing Solutions — Combined migration v18
-- Includes: dialer_schema_v17 (Quo columns) + agent number assignments
-- Safe to run multiple times.
-- ============================================================

-- Run dialer_schema_v17.sql first if you haven't, OR just run this combined file
-- ============================================================
-- TBD Marketing Solutions — Call Command schema v17 (Quo edition)
-- Upgrades the v16 dialer schema for Quo (formerly OpenPhone)
-- Safe to run multiple times; uses ADD COLUMN IF NOT EXISTS.
-- ============================================================

-- 1. Make sure the base tables exist (created in v16); add Quo columns if missing.

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'quo',
  ADD COLUMN IF NOT EXISTS quo_call_id TEXT,
  ADD COLUMN IF NOT EXISTS quo_user_id TEXT,
  ADD COLUMN IF NOT EXISTS quo_phone_number_id TEXT,
  ADD COLUMN IF NOT EXISTS quo_conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS from_number TEXT,
  ADD COLUMN IF NOT EXISTS to_number TEXT,
  ADD COLUMN IF NOT EXISTS direction TEXT,
  ADD COLUMN IF NOT EXISTS source_module TEXT,
  ADD COLUMN IF NOT EXISTS agent_email TEXT,
  ADD COLUMN IF NOT EXISTS initiated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ringing_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS answered BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS voicemail_url TEXT,
  ADD COLUMN IF NOT EXISTS recording_url TEXT,
  ADD COLUMN IF NOT EXISTS recording_duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_summary_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_transcript TEXT,
  ADD COLUMN IF NOT EXISTS ai_transcript_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disposition TEXT,
  ADD COLUMN IF NOT EXISTS disposition_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disposition_notes TEXT;

ALTER TABLE call_events
  ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'quo',
  ADD COLUMN IF NOT EXISTS payload JSONB;

-- 2. Useful indexes for the new lookups in webhook + dial-link

CREATE INDEX IF NOT EXISTS idx_call_sessions_quo_call_id
  ON call_sessions (quo_call_id) WHERE quo_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_call_sessions_from_to_created
  ON call_sessions (from_number, to_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_sessions_status
  ON call_sessions (status);

CREATE INDEX IF NOT EXISTS idx_call_sessions_provider
  ON call_sessions (provider);

CREATE INDEX IF NOT EXISTS idx_call_events_call_session
  ON call_events (call_session_id, created_at DESC);

-- 3. Optional: number reputation tracking (so the dashboard can warn you
--    when one of your 3 Quo numbers starts getting flagged "Scam Likely").

CREATE TABLE IF NOT EXISTS quo_number_reputation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL UNIQUE,
  display_name TEXT,
  total_calls INTEGER DEFAULT 0,
  total_answered INTEGER DEFAULT 0,
  total_under_10s INTEGER DEFAULT 0,
  flagged_status TEXT,
  flagged_carriers TEXT[],
  flagged_at TIMESTAMPTZ,
  paused BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quo_number_reputation_paused
  ON quo_number_reputation (paused);

-- 4. RLS — keep it permissive for authenticated users like v16.
--    Adjust if you tighten access later.

ALTER TABLE quo_number_reputation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quo_number_reputation_select ON quo_number_reputation;
CREATE POLICY quo_number_reputation_select ON quo_number_reputation
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS quo_number_reputation_modify ON quo_number_reputation;
CREATE POLICY quo_number_reputation_modify ON quo_number_reputation
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- ============================================================
-- Done. Run this in Supabase SQL Editor after deploying.
-- ============================================================

-- ============================================================
-- TBD Marketing Solutions
-- Agent <-> Quo Number Assignments (admin-managed)
-- Safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_number_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  agent_email TEXT NOT NULL,
  agent_display_name TEXT,
  team_label TEXT,
  quo_phone_number TEXT NOT NULL,
  quo_phone_id TEXT,
  assigned_by UUID,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (agent_id),
  UNIQUE (quo_phone_number) -- one number per agent (1:1)
);

CREATE INDEX IF NOT EXISTS idx_agent_num_assign_agent_email
  ON agent_number_assignments (agent_email);

CREATE INDEX IF NOT EXISTS idx_agent_num_assign_number
  ON agent_number_assignments (quo_phone_number);

ALTER TABLE agent_number_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_num_assign_select ON agent_number_assignments;
CREATE POLICY agent_num_assign_select ON agent_number_assignments
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS agent_num_assign_modify ON agent_number_assignments;
CREATE POLICY agent_num_assign_modify ON agent_number_assignments
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- Touch updated_at on update
CREATE OR REPLACE FUNCTION agent_num_assign_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_num_assign_touch ON agent_number_assignments;
CREATE TRIGGER trg_agent_num_assign_touch
  BEFORE UPDATE ON agent_number_assignments
  FOR EACH ROW EXECUTE FUNCTION agent_num_assign_touch();
