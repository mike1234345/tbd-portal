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
