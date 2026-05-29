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
