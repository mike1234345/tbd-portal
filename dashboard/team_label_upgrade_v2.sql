-- =====================================================
-- v3.5.7: Team label upgrade for crm_user_roles
-- Adds team_label column (if missing) and removes the
-- restrictive Your Team / Chay Team check so any team
-- name is allowed (matches v3.5.4 frontend behavior).
-- Safe to run multiple times.
-- =====================================================

alter table if exists public.crm_user_roles
  add column if not exists team_label text;

-- Drop the old restrictive constraint (only allowed 'Your Team' / 'Chay Team')
alter table if exists public.crm_user_roles
  drop constraint if exists crm_user_roles_team_label_check;

-- New constraint: 60-char limit (matches frontend), null allowed.
-- v3.6.2: drop first so this migration is idempotent (handles the case where it was added manually).
alter table if exists public.crm_user_roles
  drop constraint if exists crm_user_roles_team_label_length;

alter table if exists public.crm_user_roles
  add constraint crm_user_roles_team_label_length
  check (team_label is null or char_length(team_label) <= 60);

create index if not exists idx_crm_user_roles_team_label
  on public.crm_user_roles(team_label);

-- Force PostgREST to reload its schema cache so the API sees the new column immediately
notify pgrst, 'reload schema';
