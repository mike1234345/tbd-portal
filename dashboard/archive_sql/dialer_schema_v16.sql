-- =====================================================
-- TBD Marketing Solutions — V16 Dialer Foundation (Mock Mode)
-- Run this AFTER:
--   1) dashboard/supabase_schema_v2.sql
--   2) dashboard/admin_role_setup.sql
-- Purpose:
--   - Add phone system settings, call sessions, call events, call notes, and recording metadata
--   - Support browser softphone mock mode now, then Telnyx wiring later
--   - Keep admin/super_admin global visibility while standard agents only access their own call data
-- =====================================================

create extension if not exists "uuid-ossp";

-- ===== Role helpers (safe to re-run) =====
create or replace function public.crm_is_super_admin(check_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.crm_user_roles r
    where r.user_id = check_user
      and r.role = 'super_admin'
  );
$$;

create or replace function public.crm_is_admin(check_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.crm_user_roles r
    where r.user_id = check_user
      and r.role in ('super_admin', 'admin')
  );
$$;

create or replace function public.crm_touch_v16_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Checks whether the current authenticated user can access the call session.
create or replace function public.crm_can_access_call_session(check_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.crm_call_sessions s
    where s.id = check_session_id
      and (
        public.crm_is_admin(auth.uid())
        or s.agent_user_id = auth.uid()
      )
  );
$$;

-- ===== Phone system settings =====
create table if not exists public.crm_phone_system_settings (
  id uuid primary key default uuid_generate_v4(),
  provider text not null default 'telnyx',
  integration_status text not null default 'not_connected' check (integration_status in ('not_connected', 'mock_mode', 'configured', 'live')),
  dialing_mode text not null default 'browser_softphone_mock' check (dialing_mode in ('browser_softphone_mock', 'browser_softphone_live', 'click_to_call', 'server_assisted')),
  recording_enabled boolean not null default true,
  inbound_enabled boolean not null default false,
  auto_log_calls boolean not null default true,
  business_number text,
  webhook_url text,
  webhook_status text not null default 'not_configured' check (webhook_status in ('not_configured', 'placeholder_ready', 'live_ready', 'error')),
  notes_required_on_complete boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_phone_system_settings_provider_unique unique (provider)
);

create index if not exists idx_crm_phone_system_settings_provider on public.crm_phone_system_settings(provider);

drop trigger if exists set_crm_phone_system_settings_updated_at on public.crm_phone_system_settings;
create trigger set_crm_phone_system_settings_updated_at
before update on public.crm_phone_system_settings
for each row execute function public.crm_touch_v16_updated_at();

-- ===== Call sessions =====
create table if not exists public.crm_call_sessions (
  id uuid primary key default uuid_generate_v4(),
  call_session_code text not null unique,
  provider text not null default 'mock',
  provider_call_id text,
  provider_leg_id text,
  direction text not null check (direction in ('outbound', 'inbound')),
  call_mode text not null default 'mock' check (call_mode in ('mock', 'live')),
  status text not null default 'draft' check (status in ('draft', 'dialing', 'ringing', 'connected', 'completed', 'missed', 'no_answer', 'busy', 'failed', 'canceled')),
  from_number text,
  to_number text not null,
  normalized_to_number text,
  lead_id uuid references public.crm_leads(id) on delete set null,
  signed_client_id uuid,
  agent_user_id uuid references auth.users(id) on delete set null,
  agent_name text,
  source_module text not null default 'dialer' check (source_module in ('dialer', 'leads', 'map', 'appointments', 'signed_clients', 'manual')),
  source_record_label text,
  started_at timestamptz,
  ringing_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  talk_time_seconds integer not null default 0 check (talk_time_seconds >= 0),
  recording_enabled boolean not null default true,
  recording_status text not null default 'not_requested' check (recording_status in ('not_requested', 'queued', 'recording', 'processing', 'ready', 'failed')),
  primary_note text,
  disposition text check (disposition in ('sale', 'appointment_set', 'callback_requested', 'left_voicemail', 'no_answer', 'busy', 'wrong_number', 'not_interested', 'do_not_call', 'qualified', 'unqualified', 'other')),
  disposition_detail text,
  follow_up_required boolean not null default false,
  follow_up_at timestamptz,
  appointment_requested boolean not null default false,
  outcome_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_crm_call_sessions_agent_user_id on public.crm_call_sessions(agent_user_id);
create index if not exists idx_crm_call_sessions_lead_id on public.crm_call_sessions(lead_id);
create index if not exists idx_crm_call_sessions_signed_client_id on public.crm_call_sessions(signed_client_id);
create index if not exists idx_crm_call_sessions_status on public.crm_call_sessions(status);
create index if not exists idx_crm_call_sessions_started_at on public.crm_call_sessions(started_at desc);
create index if not exists idx_crm_call_sessions_to_number on public.crm_call_sessions(to_number);
create index if not exists idx_crm_call_sessions_created_at on public.crm_call_sessions(created_at desc);

drop trigger if exists set_crm_call_sessions_updated_at on public.crm_call_sessions;
create trigger set_crm_call_sessions_updated_at
before update on public.crm_call_sessions
for each row execute function public.crm_touch_v16_updated_at();

-- ===== Call events =====
create table if not exists public.crm_call_events (
  id uuid primary key default uuid_generate_v4(),
  call_session_id uuid not null references public.crm_call_sessions(id) on delete cascade,
  event_type text not null check (event_type in ('session_created', 'dial_started', 'ringing_started', 'call_connected', 'call_ended', 'note_saved', 'disposition_saved', 'recording_marked', 'recording_ready', 'status_changed', 'follow_up_set', 'session_updated', 'session_deleted', 'provider_placeholder_called')),
  event_label text,
  event_payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_crm_call_events_session_id on public.crm_call_events(call_session_id);
create index if not exists idx_crm_call_events_type on public.crm_call_events(event_type);
create index if not exists idx_crm_call_events_created_at on public.crm_call_events(created_at desc);

-- ===== Call notes =====
create table if not exists public.crm_call_notes (
  id uuid primary key default uuid_generate_v4(),
  call_session_id uuid not null references public.crm_call_sessions(id) on delete cascade,
  agent_user_id uuid references auth.users(id) on delete set null,
  note_type text not null default 'call_note' check (note_type in ('call_note', 'wrap_up_note', 'follow_up_note', 'recording_note')),
  note_body text not null,
  is_private boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_crm_call_notes_session_id on public.crm_call_notes(call_session_id);
create index if not exists idx_crm_call_notes_agent_user_id on public.crm_call_notes(agent_user_id);
create index if not exists idx_crm_call_notes_created_at on public.crm_call_notes(created_at desc);

drop trigger if exists set_crm_call_notes_updated_at on public.crm_call_notes;
create trigger set_crm_call_notes_updated_at
before update on public.crm_call_notes
for each row execute function public.crm_touch_v16_updated_at();

-- ===== Call recordings =====
create table if not exists public.crm_call_recordings (
  id uuid primary key default uuid_generate_v4(),
  call_session_id uuid not null references public.crm_call_sessions(id) on delete cascade,
  provider text not null default 'mock',
  provider_recording_id text,
  recording_status text not null default 'processing' check (recording_status in ('processing', 'ready', 'failed', 'not_available')),
  recording_url text,
  recording_duration_seconds integer not null default 0 check (recording_duration_seconds >= 0),
  recording_started_at timestamptz,
  recording_ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_crm_call_recordings_session_id on public.crm_call_recordings(call_session_id);
create index if not exists idx_crm_call_recordings_status on public.crm_call_recordings(recording_status);
create index if not exists idx_crm_call_recordings_created_at on public.crm_call_recordings(created_at desc);

drop trigger if exists set_crm_call_recordings_updated_at on public.crm_call_recordings;
create trigger set_crm_call_recordings_updated_at
before update on public.crm_call_recordings
for each row execute function public.crm_touch_v16_updated_at();

-- ===== Seed default phone system row =====
insert into public.crm_phone_system_settings (
  provider,
  integration_status,
  dialing_mode,
  recording_enabled,
  inbound_enabled,
  auto_log_calls,
  business_number,
  webhook_url,
  webhook_status,
  notes_required_on_complete
)
values (
  'telnyx',
  'mock_mode',
  'browser_softphone_mock',
  true,
  false,
  true,
  null,
  '/.netlify/functions/telnyx-webhook',
  'placeholder_ready',
  true
)
on conflict (provider) do update
set integration_status = excluded.integration_status,
    dialing_mode = excluded.dialing_mode,
    recording_enabled = excluded.recording_enabled,
    inbound_enabled = excluded.inbound_enabled,
    auto_log_calls = excluded.auto_log_calls,
    webhook_url = excluded.webhook_url,
    webhook_status = excluded.webhook_status,
    notes_required_on_complete = excluded.notes_required_on_complete,
    updated_at = now();

-- ===== RLS =====
alter table public.crm_phone_system_settings enable row level security;
alter table public.crm_call_sessions enable row level security;
alter table public.crm_call_events enable row level security;
alter table public.crm_call_notes enable row level security;
alter table public.crm_call_recordings enable row level security;

-- Phone system settings: all authenticated users can read; admins manage changes.
drop policy if exists "crm_phone_settings_read" on public.crm_phone_system_settings;
drop policy if exists "crm_phone_settings_insert" on public.crm_phone_system_settings;
drop policy if exists "crm_phone_settings_update" on public.crm_phone_system_settings;
drop policy if exists "crm_phone_settings_delete" on public.crm_phone_system_settings;

create policy "crm_phone_settings_read"
on public.crm_phone_system_settings
for select
to authenticated
using (true);

create policy "crm_phone_settings_insert"
on public.crm_phone_system_settings
for insert
to authenticated
with check (public.crm_is_admin(auth.uid()));

create policy "crm_phone_settings_update"
on public.crm_phone_system_settings
for update
to authenticated
using (public.crm_is_admin(auth.uid()))
with check (public.crm_is_admin(auth.uid()));

create policy "crm_phone_settings_delete"
on public.crm_phone_system_settings
for delete
to authenticated
using (public.crm_is_admin(auth.uid()));

-- Call sessions: admin/super_admin can see all; standard agents only their own rows.
drop policy if exists "crm_call_sessions_read" on public.crm_call_sessions;
drop policy if exists "crm_call_sessions_insert" on public.crm_call_sessions;
drop policy if exists "crm_call_sessions_update" on public.crm_call_sessions;
drop policy if exists "crm_call_sessions_delete" on public.crm_call_sessions;

create policy "crm_call_sessions_read"
on public.crm_call_sessions
for select
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or agent_user_id = auth.uid()
);

create policy "crm_call_sessions_insert"
on public.crm_call_sessions
for insert
to authenticated
with check (
  public.crm_is_admin(auth.uid())
  or agent_user_id = auth.uid()
);

create policy "crm_call_sessions_update"
on public.crm_call_sessions
for update
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or agent_user_id = auth.uid()
)
with check (
  public.crm_is_admin(auth.uid())
  or agent_user_id = auth.uid()
);

create policy "crm_call_sessions_delete"
on public.crm_call_sessions
for delete
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or agent_user_id = auth.uid()
);

-- Call events
DROP POLICY if exists "crm_call_events_read" on public.crm_call_events;
DROP POLICY if exists "crm_call_events_insert" on public.crm_call_events;
DROP POLICY if exists "crm_call_events_update" on public.crm_call_events;
DROP POLICY if exists "crm_call_events_delete" on public.crm_call_events;

create policy "crm_call_events_read"
on public.crm_call_events
for select
to authenticated
using (public.crm_can_access_call_session(call_session_id));

create policy "crm_call_events_insert"
on public.crm_call_events
for insert
to authenticated
with check (
  public.crm_can_access_call_session(call_session_id)
  and (
    created_by is null
    or created_by = auth.uid()
    or public.crm_is_admin(auth.uid())
  )
);

create policy "crm_call_events_update"
on public.crm_call_events
for update
to authenticated
using (public.crm_is_admin(auth.uid()))
with check (public.crm_is_admin(auth.uid()));

create policy "crm_call_events_delete"
on public.crm_call_events
for delete
to authenticated
using (public.crm_is_admin(auth.uid()));

-- Call notes
DROP POLICY if exists "crm_call_notes_read" on public.crm_call_notes;
DROP POLICY if exists "crm_call_notes_insert" on public.crm_call_notes;
DROP POLICY if exists "crm_call_notes_update" on public.crm_call_notes;
DROP POLICY if exists "crm_call_notes_delete" on public.crm_call_notes;

create policy "crm_call_notes_read"
on public.crm_call_notes
for select
to authenticated
using (public.crm_can_access_call_session(call_session_id));

create policy "crm_call_notes_insert"
on public.crm_call_notes
for insert
to authenticated
with check (
  public.crm_can_access_call_session(call_session_id)
  and (
    agent_user_id is null
    or agent_user_id = auth.uid()
    or public.crm_is_admin(auth.uid())
  )
);

create policy "crm_call_notes_update"
on public.crm_call_notes
for update
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or agent_user_id = auth.uid()
)
with check (
  public.crm_is_admin(auth.uid())
  or agent_user_id = auth.uid()
);

create policy "crm_call_notes_delete"
on public.crm_call_notes
for delete
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or agent_user_id = auth.uid()
);

-- Call recordings
DROP POLICY if exists "crm_call_recordings_read" on public.crm_call_recordings;
DROP POLICY if exists "crm_call_recordings_insert" on public.crm_call_recordings;
DROP POLICY if exists "crm_call_recordings_update" on public.crm_call_recordings;
DROP POLICY if exists "crm_call_recordings_delete" on public.crm_call_recordings;

create policy "crm_call_recordings_read"
on public.crm_call_recordings
for select
to authenticated
using (public.crm_can_access_call_session(call_session_id));

create policy "crm_call_recordings_insert"
on public.crm_call_recordings
for insert
to authenticated
with check (public.crm_can_access_call_session(call_session_id));

create policy "crm_call_recordings_update"
on public.crm_call_recordings
for update
to authenticated
using (public.crm_can_access_call_session(call_session_id))
with check (public.crm_can_access_call_session(call_session_id));

create policy "crm_call_recordings_delete"
on public.crm_call_recordings
for delete
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or public.crm_can_access_call_session(call_session_id)
);

notify pgrst, 'reload schema';
