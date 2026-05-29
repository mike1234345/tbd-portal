-- =====================================================================
-- TBD Marketing Solutions — Quo / Call Command full schema (v19)
-- Self-contained. Safe to re-run.
-- Creates everything the Quo Netlify functions + Call Command tab need.
-- Run this in Supabase SQL Editor.
-- =====================================================================

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ---------- shared touch() ----------
create or replace function public.tbd_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =====================================================================
-- 1) call_sessions  (unprefixed - matches quo-webhook.js / dialer.js)
-- =====================================================================
create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  provider text default 'quo',
  status text default 'draft',
  direction text default 'outbound',
  from_number text,
  to_number text,
  lead_id uuid,
  source_module text default 'call_command',
  agent_email text,
  agent_user_id uuid,

  -- Quo identifiers
  quo_call_id text,
  quo_user_id text,
  quo_phone_number_id text,
  quo_conversation_id text,

  -- Lifecycle timestamps
  initiated_at timestamptz,
  ringing_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  answered boolean default false,
  duration_seconds integer,

  -- Media
  voicemail_url text,
  recording_url text,
  recording_duration_seconds integer,

  -- AI
  ai_summary text,
  ai_summary_at timestamptz,
  ai_transcript text,
  ai_transcript_at timestamptz,

  -- Disposition
  disposition text,
  disposition_at timestamptz,
  disposition_notes text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_call_sessions_quo_call_id
  on public.call_sessions (quo_call_id) where quo_call_id is not null;
create index if not exists idx_call_sessions_from_to_created
  on public.call_sessions (from_number, to_number, created_at desc);
create index if not exists idx_call_sessions_status
  on public.call_sessions (status);
create index if not exists idx_call_sessions_provider
  on public.call_sessions (provider);
create index if not exists idx_call_sessions_agent_email
  on public.call_sessions (agent_email);
create index if not exists idx_call_sessions_lead_id
  on public.call_sessions (lead_id);

drop trigger if exists trg_call_sessions_touch on public.call_sessions;
create trigger trg_call_sessions_touch
  before update on public.call_sessions
  for each row execute function public.tbd_touch_updated_at();

-- =====================================================================
-- 2) call_events
-- =====================================================================
create table if not exists public.call_events (
  id uuid primary key default gen_random_uuid(),
  call_session_id uuid references public.call_sessions(id) on delete cascade,
  provider text default 'quo',
  event_type text,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_call_events_session_created
  on public.call_events (call_session_id, created_at desc);
create index if not exists idx_call_events_type
  on public.call_events (event_type);

-- =====================================================================
-- 3) agent_number_assignments  (the one that was missing)
-- =====================================================================
create table if not exists public.agent_number_assignments (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null,
  agent_email text not null,
  agent_display_name text,
  team_label text,
  quo_phone_number text not null,
  quo_phone_id text,
  assigned_by uuid,
  assigned_at timestamptz default now(),
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (agent_id),
  unique (quo_phone_number)
);

create index if not exists idx_agent_num_assign_email
  on public.agent_number_assignments (agent_email);
create index if not exists idx_agent_num_assign_number
  on public.agent_number_assignments (quo_phone_number);

drop trigger if exists trg_agent_num_assign_touch on public.agent_number_assignments;
create trigger trg_agent_num_assign_touch
  before update on public.agent_number_assignments
  for each row execute function public.tbd_touch_updated_at();

-- =====================================================================
-- 4) quo_number_reputation  (Scam Likely tracking)
-- =====================================================================
create table if not exists public.quo_number_reputation (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  display_name text,
  total_calls integer default 0,
  total_answered integer default 0,
  total_under_10s integer default 0,
  flagged_status text,
  flagged_carriers text[],
  flagged_at timestamptz,
  paused boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_quo_reputation_paused
  on public.quo_number_reputation (paused);

drop trigger if exists trg_quo_reputation_touch on public.quo_number_reputation;
create trigger trg_quo_reputation_touch
  before update on public.quo_number_reputation
  for each row execute function public.tbd_touch_updated_at();

-- =====================================================================
-- 5) RLS policies (permissive for authenticated users)
-- =====================================================================
alter table public.call_sessions             enable row level security;
alter table public.call_events               enable row level security;
alter table public.agent_number_assignments  enable row level security;
alter table public.quo_number_reputation     enable row level security;

-- call_sessions
drop policy if exists call_sessions_select on public.call_sessions;
create policy call_sessions_select on public.call_sessions
  for select using (auth.role() = 'authenticated');
drop policy if exists call_sessions_modify on public.call_sessions;
create policy call_sessions_modify on public.call_sessions
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- call_events
drop policy if exists call_events_select on public.call_events;
create policy call_events_select on public.call_events
  for select using (auth.role() = 'authenticated');
drop policy if exists call_events_modify on public.call_events;
create policy call_events_modify on public.call_events
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- agent_number_assignments
drop policy if exists agent_num_assign_select on public.agent_number_assignments;
create policy agent_num_assign_select on public.agent_number_assignments
  for select using (auth.role() = 'authenticated');
drop policy if exists agent_num_assign_modify on public.agent_number_assignments;
create policy agent_num_assign_modify on public.agent_number_assignments
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- quo_number_reputation
drop policy if exists quo_reputation_select on public.quo_number_reputation;
create policy quo_reputation_select on public.quo_number_reputation
  for select using (auth.role() = 'authenticated');
drop policy if exists quo_reputation_modify on public.quo_number_reputation;
create policy quo_reputation_modify on public.quo_number_reputation
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- =====================================================================
-- 6) Tell PostgREST to reload its schema cache so the API sees new tables
-- =====================================================================
notify pgrst, 'reload schema';

-- =====================================================================
-- Done. Verify with:
--   select to_regclass('public.agent_number_assignments');
--   select to_regclass('public.call_sessions');
--   select to_regclass('public.call_events');
--   select to_regclass('public.quo_number_reputation');
-- All four should return their full table name.
-- =====================================================================
