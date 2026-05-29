-- =====================================================
-- TBD Marketing Solutions — V2 CACHE-BYPASS RESET
-- Uses brand-new table names to avoid stale PostgREST schema cache
-- Tables: crm_leads, crm_call_attempts, crm_appointments
-- Safe approach when old table names keep throwing schema cache errors
-- =====================================================

-- WARNING: This only drops the V2 tables below.
-- Your old leads/call_attempts/appointments tables are left untouched.

create extension if not exists "uuid-ossp";

drop table if exists public.crm_appointments cascade;
drop table if exists public.crm_call_attempts cascade;
drop table if exists public.crm_leads cascade;
drop function if exists public.crm_update_updated_at() cascade;

-- ===== crm_leads =====
create table public.crm_leads (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  contact_name text,
  phone text,
  email text,
  address text,
  city text,
  state text,
  zip text,
  damage_type text,
  source text,
  assigned_agent uuid references auth.users(id) on delete set null,
  status text default 'New',
  insurance_carrier text,
  claim_number text,
  policy_number text,
  notes text
);

-- ===== crm_call_attempts =====
create table public.crm_call_attempts (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz default now(),
  lead_id uuid references public.crm_leads(id) on delete cascade,
  agent_id uuid references auth.users(id) on delete set null,
  answered boolean default false,
  allowed_presentation boolean default false,
  appointment_booked boolean default false,
  call_outcome text,
  duration_seconds int default 0,
  notes text
);

-- ===== crm_appointments =====
create table public.crm_appointments (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  lead_id uuid references public.crm_leads(id) on delete cascade,
  agent_id uuid references auth.users(id) on delete set null,
  call_id uuid references public.crm_call_attempts(id) on delete set null,
  scheduled_for timestamptz,
  duration_minutes int default 60,
  appointment_type text default 'Inspection',
  location text,
  status text default 'Scheduled',
  outcome text,
  signed_amount numeric(10,2),
  reminder_sent boolean default false,
  notes text
);

-- ===== updated_at trigger =====
create or replace function public.crm_update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_crm_leads_updated_at before update on public.crm_leads
  for each row execute function public.crm_update_updated_at();

create trigger set_crm_appts_updated_at before update on public.crm_appointments
  for each row execute function public.crm_update_updated_at();

-- ===== indexes =====
create index idx_crm_leads_status on public.crm_leads(status);
create index idx_crm_leads_agent on public.crm_leads(assigned_agent);
create index idx_crm_leads_damage on public.crm_leads(damage_type);
create index idx_crm_leads_created on public.crm_leads(created_at desc);
create index idx_crm_calls_lead on public.crm_call_attempts(lead_id);
create index idx_crm_calls_agent on public.crm_call_attempts(agent_id);
create index idx_crm_calls_created on public.crm_call_attempts(created_at desc);
create index idx_crm_calls_outcome on public.crm_call_attempts(call_outcome);
create index idx_crm_appts_lead on public.crm_appointments(lead_id);
create index idx_crm_appts_agent on public.crm_appointments(agent_id);
create index idx_crm_appts_scheduled on public.crm_appointments(scheduled_for);
create index idx_crm_appts_status on public.crm_appointments(status);

-- ===== RLS =====
alter table public.crm_leads enable row level security;
alter table public.crm_call_attempts enable row level security;
alter table public.crm_appointments enable row level security;

create policy "crm_leads_read" on public.crm_leads for select to authenticated using (true);
create policy "crm_leads_insert" on public.crm_leads for insert to authenticated with check (true);
create policy "crm_leads_update" on public.crm_leads for update to authenticated using (true);
create policy "crm_leads_delete" on public.crm_leads for delete to authenticated using (true);

create policy "crm_calls_read" on public.crm_call_attempts for select to authenticated using (true);
create policy "crm_calls_insert" on public.crm_call_attempts for insert to authenticated with check (true);
create policy "crm_calls_update" on public.crm_call_attempts for update to authenticated using (true);
create policy "crm_calls_delete" on public.crm_call_attempts for delete to authenticated using (true);

create policy "crm_appts_read" on public.crm_appointments for select to authenticated using (true);
create policy "crm_appts_insert" on public.crm_appointments for insert to authenticated with check (true);
create policy "crm_appts_update" on public.crm_appointments for update to authenticated using (true);
create policy "crm_appts_delete" on public.crm_appointments for delete to authenticated using (true);

-- ===== sample data =====
insert into public.crm_leads (id, contact_name, phone, email, address, city, state, zip, damage_type, source, status, insurance_carrier, notes) values
  ('11111111-1111-1111-1111-111111111111', 'John Smith', '555-0101', 'john.smith@example.com', '123 Oak Lane', 'Houston', 'TX', '77001', 'Water', 'Cold Call List', 'Booked', 'State Farm', 'Roof leak after March storms'),
  ('22222222-2222-2222-2222-222222222222', 'Maria Garcia', '555-0102', 'maria.garcia@example.com', '456 Palm Ave', 'Miami', 'FL', '33101', 'Mold', 'Referral', 'In Progress', 'Allstate', 'Bathroom mold, claim already filed'),
  ('33333333-3333-3333-3333-333333333333', 'Robert Johnson', '555-0103', 'robert.j@example.com', '789 Elm Street', 'Dallas', 'TX', '75201', 'Fire', 'Storm Map', 'Booked', 'Liberty Mutual', 'Kitchen fire damage Mar 2026'),
  ('44444444-4444-4444-4444-444444444444', 'Linda Brown', '555-0104', 'linda.brown@example.com', '321 Beach Rd', 'Tampa', 'FL', '33601', 'Storm', 'Cold Call List', 'New', 'Citizens', 'Hurricane Ian impact area'),
  ('55555555-5555-5555-5555-555555555555', 'Carlos Rivera', '555-0105', 'carlos.r@example.com', '654 Pine Drive', 'Orlando', 'FL', '32801', 'Water', 'Door-knock', 'Booked', 'Progressive', 'Burst pipe in laundry'),
  ('66666666-6666-6666-6666-666666666666', 'Susan Lee', '555-0106', 'susan.lee@example.com', '987 Cedar Court', 'Austin', 'TX', '78701', 'Multi', 'Referral', 'Closed', 'USAA', 'Storm and water full restoration');

insert into public.crm_call_attempts (lead_id, answered, allowed_presentation, appointment_booked, call_outcome, duration_seconds, notes, created_at) values
  ('11111111-1111-1111-1111-111111111111', true, true, true, 'Booked', 420, 'Great call, agreed to free inspection', now() - interval '2 days'),
  ('22222222-2222-2222-2222-222222222222', true, true, false, 'Callback requested', 320, 'Wants info first, follow up Tuesday', now() - interval '1 day'),
  ('22222222-2222-2222-2222-222222222222', false, false, false, 'Voicemail', 45, 'Left voicemail with brief intro', now() - interval '3 days'),
  ('33333333-3333-3333-3333-333333333333', true, true, true, 'Booked', 380, 'Inspector confirmed for next week', now() - interval '4 days'),
  ('44444444-4444-4444-4444-444444444444', false, false, false, 'No answer', 20, 'Will retry this evening', now() - interval '6 hours'),
  ('44444444-4444-4444-4444-444444444444', true, false, false, 'Not interested', 90, 'Said not interested but tone uncertain', now() - interval '2 hours'),
  ('55555555-5555-5555-5555-555555555555', true, true, true, 'Booked', 510, 'URGENT burst pipe, scheduled same-day', now() - interval '12 hours'),
  ('66666666-6666-6666-6666-666666666666', true, true, true, 'Booked', 600, 'Repeat client, easy close', now() - interval '30 days');

insert into public.crm_appointments (lead_id, scheduled_for, duration_minutes, appointment_type, location, status, outcome, signed_amount, notes) values
  ('11111111-1111-1111-1111-111111111111', now() + interval '2 days' + interval '10 hours', 60, 'Inspection', '123 Oak Lane, Houston TX', 'Scheduled', null, null, 'Bring moisture meter and ladder'),
  ('33333333-3333-3333-3333-333333333333', now() + interval '5 days' + interval '14 hours', 90, 'Inspection', '789 Elm Street, Dallas TX', 'Scheduled', null, null, 'Fire damage assessment'),
  ('55555555-5555-5555-5555-555555555555', now() + interval '6 hours', 60, 'Inspection', '654 Pine Drive, Orlando FL', 'Scheduled', null, null, 'URGENT burst pipe'),
  ('66666666-6666-6666-6666-666666666666', now() - interval '14 days', 90, 'Sign Contract', 'Office', 'Signed', 'Customer signed full restoration', 24500.00, 'Down payment received'),
  ('22222222-2222-2222-2222-222222222222', now() - interval '7 days', 45, 'Strategy Call', 'Phone', 'No-show', 'Did not answer scheduled call', null, 'Reschedule attempted twice');

notify pgrst, 'reload schema';
