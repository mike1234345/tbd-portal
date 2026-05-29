-- =====================================================
-- TBD Marketing Solutions — Admin / Agent / Super Admin Access Setup
-- Run this AFTER dashboard/supabase_schema_v2.sql
-- Purpose:
--   1) Create crm_user_roles for role-based dashboard access
--   2) Add super_admin support for owner-only oversight
--   3) Make call logs private per agent while admins / super admin can see everything
--   4) Keep leads + appointments shared for all authenticated users
-- =====================================================

create table if not exists public.crm_user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'agent' check (role in ('super_admin', 'admin', 'agent')),
  display_name text,
  email text,
  team_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.crm_user_roles
  add column if not exists team_label text;

alter table if exists public.crm_user_roles
  drop constraint if exists crm_user_roles_role_check;

alter table if exists public.crm_user_roles
  add constraint crm_user_roles_role_check
  check (role in ('super_admin', 'admin', 'agent'));

alter table if exists public.crm_user_roles
  drop constraint if exists crm_user_roles_team_label_check;

alter table if exists public.crm_user_roles
  add constraint crm_user_roles_team_label_check
  check (team_label is null or team_label in ('Your Team', 'Chay Team'));

create or replace function public.crm_update_role_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_crm_user_roles_updated_at on public.crm_user_roles;
create trigger set_crm_user_roles_updated_at
before update on public.crm_user_roles
for each row execute function public.crm_update_role_updated_at();

alter table public.crm_user_roles enable row level security;

drop policy if exists "crm_roles_read" on public.crm_user_roles;
create policy "crm_roles_read"
on public.crm_user_roles
for select
to authenticated
using (true);

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

-- Optional but recommended: create role rows for all existing auth users.
insert into public.crm_user_roles (user_id, role, display_name, email)
select
  u.id,
  'agent',
  coalesce(nullif(split_part(u.email, '@', 1), ''), 'Agent'),
  u.email
from auth.users u
on conflict (user_id) do update
set email = excluded.email,
    display_name = coalesce(public.crm_user_roles.display_name, excluded.display_name);

-- IMPORTANT:
-- Replace YOUR_SUPER_ADMIN_EMAIL_HERE with the one owner account that should see everything.
insert into public.crm_user_roles (user_id, role, display_name, email)
select
  u.id,
  'super_admin',
  coalesce(nullif(split_part(u.email, '@', 1), ''), 'Owner'),
  u.email
from auth.users u
where lower(u.email) = lower('YOUR_SUPER_ADMIN_EMAIL_HERE')
on conflict (user_id) do update
set role = 'super_admin',
    email = excluded.email,
    display_name = coalesce(public.crm_user_roles.display_name, excluded.display_name);

-- OPTIONAL:
-- Promote partner users to admin one-by-one.
-- Example:
-- insert into public.crm_user_roles (user_id, role, display_name, email)
-- select u.id, 'admin', coalesce(nullif(split_part(u.email, '@', 1), ''), 'Partner'), u.email
-- from auth.users u
-- where lower(u.email) = lower('partner@example.com')
-- on conflict (user_id) do update
-- set role = 'admin',
--     email = excluded.email,
--     display_name = coalesce(public.crm_user_roles.display_name, excluded.display_name);
--
-- OPTIONAL TEAM LABELS:
-- Tag agents so appointments and call logs can be split by team.
-- Example:
-- update public.crm_user_roles set team_label = 'Your Team' where lower(email) in ('agent1@example.com', 'agent2@example.com');
-- update public.crm_user_roles set team_label = 'Chay Team' where lower(email) in ('chayagent1@example.com', 'chayagent2@example.com');

-- Keep leads shared across the whole authenticated team.
drop policy if exists "crm_leads_read" on public.crm_leads;
drop policy if exists "crm_leads_insert" on public.crm_leads;
drop policy if exists "crm_leads_update" on public.crm_leads;
drop policy if exists "crm_leads_delete" on public.crm_leads;

create policy "crm_leads_read"
on public.crm_leads
for select
to authenticated
using (true);

create policy "crm_leads_insert"
on public.crm_leads
for insert
to authenticated
with check (true);

create policy "crm_leads_update"
on public.crm_leads
for update
to authenticated
using (true)
with check (true);

create policy "crm_leads_delete"
on public.crm_leads
for delete
to authenticated
using (true);

-- Keep appointments shared across the whole authenticated team.
drop policy if exists "crm_appts_read" on public.crm_appointments;
drop policy if exists "crm_appts_insert" on public.crm_appointments;
drop policy if exists "crm_appts_update" on public.crm_appointments;
drop policy if exists "crm_appts_delete" on public.crm_appointments;

create policy "crm_appts_read"
on public.crm_appointments
for select
to authenticated
using (true);

create policy "crm_appts_insert"
on public.crm_appointments
for insert
to authenticated
with check (true);

create policy "crm_appts_update"
on public.crm_appointments
for update
to authenticated
using (true)
with check (true);

create policy "crm_appts_delete"
on public.crm_appointments
for delete
to authenticated
using (true);

-- Restrict call logs so agents only see their own, while admin + super_admin see all.
drop policy if exists "crm_calls_read" on public.crm_call_attempts;
drop policy if exists "crm_calls_insert" on public.crm_call_attempts;
drop policy if exists "crm_calls_update" on public.crm_call_attempts;
drop policy if exists "crm_calls_delete" on public.crm_call_attempts;

create policy "crm_calls_read"
on public.crm_call_attempts
for select
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or agent_id = auth.uid()
);

create policy "crm_calls_insert"
on public.crm_call_attempts
for insert
to authenticated
with check (
  public.crm_is_admin(auth.uid())
  or agent_id = auth.uid()
);

create policy "crm_calls_update"
on public.crm_call_attempts
for update
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or agent_id = auth.uid()
)
with check (
  public.crm_is_admin(auth.uid())
  or agent_id = auth.uid()
);

create policy "crm_calls_delete"
on public.crm_call_attempts
for delete
to authenticated
using (
  public.crm_is_admin(auth.uid())
  or agent_id = auth.uid()
);

create index if not exists idx_crm_user_roles_role on public.crm_user_roles(role);
create index if not exists idx_crm_user_roles_email on public.crm_user_roles(email);
create index if not exists idx_crm_calls_agent_id on public.crm_call_attempts(agent_id);
create index if not exists idx_crm_appts_agent_id on public.crm_appointments(agent_id);

notify pgrst, 'reload schema';
