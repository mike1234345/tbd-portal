-- =====================================================
-- TBD Marketing Solutions — Training Progress Schema
-- Run this AFTER:
--   1) dashboard/supabase_schema_v2.sql
--   2) dashboard/admin_role_setup.sql
--   3) dashboard/messages_schema.sql (optional but recommended before app launch)
-- Purpose:
--   Persist training drill progress per agent in Supabase
--   Keep daily completion counts accurate across devices
--   Allow admins to report on team training later
-- =====================================================

create extension if not exists "uuid-ossp";

create table if not exists public.crm_training_progress (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  module_key text not null check (module_key in ('roofing', 'plumbing')),
  completed_count integer not null default 0,
  mastered_count integer not null default 0,
  last_drill_index integer not null default 0,
  last_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_training_progress_user_module_unique unique (user_id, module_key)
);

create table if not exists public.crm_training_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  module_key text not null check (module_key in ('roofing', 'plumbing')),
  event_type text not null check (event_type in ('completed', 'mastered', 'progressed')),
  created_at timestamptz not null default now()
);

create or replace function public.crm_update_training_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_crm_training_progress_updated_at on public.crm_training_progress;
create trigger set_crm_training_progress_updated_at
before update on public.crm_training_progress
for each row execute function public.crm_update_training_updated_at();

create index if not exists idx_crm_training_progress_user on public.crm_training_progress(user_id);
create index if not exists idx_crm_training_progress_module on public.crm_training_progress(module_key);
create index if not exists idx_crm_training_events_user on public.crm_training_events(user_id);
create index if not exists idx_crm_training_events_created on public.crm_training_events(created_at desc);
create index if not exists idx_crm_training_events_module on public.crm_training_events(module_key);

alter table public.crm_training_progress enable row level security;
alter table public.crm_training_events enable row level security;

drop policy if exists "crm_training_progress_read" on public.crm_training_progress;
create policy "crm_training_progress_read"
on public.crm_training_progress
for select
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or user_id = auth.uid()
);

drop policy if exists "crm_training_progress_insert" on public.crm_training_progress;
create policy "crm_training_progress_insert"
on public.crm_training_progress
for insert
to authenticated
with check (
  public.crm_is_admin(auth.uid())
  or user_id = auth.uid()
);

drop policy if exists "crm_training_progress_update" on public.crm_training_progress;
create policy "crm_training_progress_update"
on public.crm_training_progress
for update
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or user_id = auth.uid()
)
with check (
  public.crm_is_admin(auth.uid())
  or user_id = auth.uid()
);

drop policy if exists "crm_training_progress_delete" on public.crm_training_progress;
create policy "crm_training_progress_delete"
on public.crm_training_progress
for delete
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or user_id = auth.uid()
);

drop policy if exists "crm_training_events_read" on public.crm_training_events;
create policy "crm_training_events_read"
on public.crm_training_events
for select
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or user_id = auth.uid()
);

drop policy if exists "crm_training_events_insert" on public.crm_training_events;
create policy "crm_training_events_insert"
on public.crm_training_events
for insert
to authenticated
with check (
  public.crm_is_admin(auth.uid())
  or user_id = auth.uid()
);

drop policy if exists "crm_training_events_delete" on public.crm_training_events;
create policy "crm_training_events_delete"
on public.crm_training_events
for delete
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or user_id = auth.uid()
);

notify pgrst, 'reload schema';
