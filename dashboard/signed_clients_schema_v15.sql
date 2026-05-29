-- =====================================================
-- TBD Marketing Solutions — V15 Signed Clients + Partner Payout Tracker
-- Run this AFTER:
--   1) dashboard/supabase_schema_v2.sql
--   2) dashboard/admin_role_setup.sql
-- Purpose:
--   - Add signed clients, partner profiles, deal templates, deal items, and transactions
--   - Support super_admin oversight with admin-partner privacy isolation
--   - Support both incoming and outgoing partner payment flows
-- =====================================================

create extension if not exists "uuid-ossp";

-- ===== Role helpers =====
alter table if exists public.crm_user_roles
  drop constraint if exists crm_user_roles_role_check;

alter table if exists public.crm_user_roles
  add constraint crm_user_roles_role_check
  check (role in ('super_admin', 'admin', 'agent'));

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

create or replace function public.crm_can_access_partner_scope(row_owner_admin_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.crm_is_super_admin(auth.uid()) or row_owner_admin_id = auth.uid();
$$;

create or replace function public.crm_touch_v15_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ===== Partner profiles =====
create table if not exists public.crm_partner_profiles (
  id uuid primary key default uuid_generate_v4(),
  admin_user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null,
  business_name text,
  partner_status text not null default 'active' check (partner_status in ('active', 'inactive')),
  preferred_payment_method text default 'zelle' check (preferred_payment_method in ('zelle', 'cash', 'check', 'wire', 'ach', 'card', 'other')),
  notes_private text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_partner_profiles_admin_user_id on public.crm_partner_profiles(admin_user_id);
create index if not exists idx_partner_profiles_status on public.crm_partner_profiles(partner_status);

drop trigger if exists set_crm_partner_profiles_updated_at on public.crm_partner_profiles;
create trigger set_crm_partner_profiles_updated_at
before update on public.crm_partner_profiles
for each row execute function public.crm_touch_v15_updated_at();

-- ===== Partner deal templates =====
create table if not exists public.crm_partner_deal_templates (
  id uuid primary key default uuid_generate_v4(),
  partner_profile_id uuid not null references public.crm_partner_profiles(id) on delete cascade,
  template_name text not null,
  item_type text not null check (item_type in (
    'commission_per_signed_client',
    'training_fee',
    'membership_fee',
    'upfront_fee',
    'profit_share',
    'tarp_placement',
    'mold_removal',
    'bonus',
    'reimbursement',
    'adjustment',
    'custom'
  )),
  item_scope text not null default 'client' check (item_scope in ('client', 'partner')),
  direction text not null check (direction in ('incoming', 'outgoing')),
  calculation_type text not null check (calculation_type in ('fixed_amount', 'per_signed_client', 'percent_profit', 'percent_revenue', 'manual')),
  flat_amount numeric(12,2),
  percent_rate numeric(7,4),
  quantity_default numeric(12,2) not null default 1 check (quantity_default > 0),
  trigger_event text not null default 'client_signed' check (trigger_event in ('client_signed', 'partner_onboard', 'profit_recorded', 'manual')),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_partner_deal_templates_amount_rule check (
    (calculation_type in ('fixed_amount', 'per_signed_client', 'manual') and flat_amount is not null)
    or (calculation_type in ('percent_profit', 'percent_revenue') and percent_rate is not null)
  )
);

create index if not exists idx_partner_deal_templates_profile_id on public.crm_partner_deal_templates(partner_profile_id);
create index if not exists idx_partner_deal_templates_active on public.crm_partner_deal_templates(partner_profile_id, is_active, trigger_event);

drop trigger if exists set_crm_partner_deal_templates_updated_at on public.crm_partner_deal_templates;
create trigger set_crm_partner_deal_templates_updated_at
before update on public.crm_partner_deal_templates
for each row execute function public.crm_touch_v15_updated_at();

-- ===== Signed clients =====
create table if not exists public.crm_signed_clients (
  id uuid primary key default uuid_generate_v4(),
  owner_admin_id uuid not null references auth.users(id),
  created_by uuid not null references auth.users(id),
  lead_id uuid references public.crm_leads(id) on delete set null,
  appointment_id uuid references public.crm_appointments(id) on delete set null,
  client_name text not null,
  company_name text,
  phone text,
  email text,
  property_address text not null,
  city text not null,
  state text not null,
  zip text,
  service_type text,
  signed_date date not null,
  job_status text not null default 'signed' check (job_status in ('signed', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  client_status text not null default 'active' check (client_status in ('active', 'on_hold', 'completed', 'cancelled')),
  contract_value numeric(12,2) not null default 0 check (contract_value >= 0),
  profit_amount numeric(12,2) not null default 0 check (profit_amount >= 0),
  deal_terms_snapshot jsonb not null default '[]'::jsonb,
  notes_private text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_signed_clients_owner_admin_id on public.crm_signed_clients(owner_admin_id);
create index if not exists idx_signed_clients_signed_date on public.crm_signed_clients(signed_date desc);
create index if not exists idx_signed_clients_client_status on public.crm_signed_clients(client_status);
create index if not exists idx_signed_clients_job_status on public.crm_signed_clients(job_status);
create index if not exists idx_signed_clients_lead_id on public.crm_signed_clients(lead_id);

create index if not exists idx_signed_clients_search on public.crm_signed_clients
using gin (to_tsvector('english',
  coalesce(client_name,'') || ' ' ||
  coalesce(property_address,'') || ' ' ||
  coalesce(city,'') || ' ' ||
  coalesce(email,'')
));

drop trigger if exists set_crm_signed_clients_updated_at on public.crm_signed_clients;
create trigger set_crm_signed_clients_updated_at
before update on public.crm_signed_clients
for each row execute function public.crm_touch_v15_updated_at();

-- ===== Deal items =====
create table if not exists public.crm_partner_deal_items (
  id uuid primary key default uuid_generate_v4(),
  owner_admin_id uuid not null references auth.users(id),
  signed_client_id uuid references public.crm_signed_clients(id) on delete cascade,
  partner_profile_id uuid not null references public.crm_partner_profiles(id) on delete cascade,
  template_id uuid references public.crm_partner_deal_templates(id) on delete set null,
  item_scope text not null default 'client' check (item_scope in ('client', 'partner')),
  item_name text not null,
  item_type text not null check (item_type in (
    'commission_per_signed_client',
    'training_fee',
    'membership_fee',
    'upfront_fee',
    'profit_share',
    'tarp_placement',
    'mold_removal',
    'bonus',
    'reimbursement',
    'adjustment',
    'custom'
  )),
  direction text not null check (direction in ('incoming', 'outgoing')),
  calculation_type text not null check (calculation_type in ('fixed_amount', 'per_signed_client', 'percent_profit', 'percent_revenue', 'manual')),
  flat_amount numeric(12,2),
  percent_rate numeric(7,4),
  quantity numeric(12,2) not null default 1 check (quantity > 0),
  expected_amount numeric(12,2) not null default 0 check (expected_amount >= 0),
  status text not null default 'due' check (status in ('draft', 'due', 'partial', 'paid', 'waived', 'void')),
  applies_on date,
  notes text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_partner_deal_items_scope_rule check (
    (item_scope = 'partner' and signed_client_id is null)
    or (item_scope = 'client' and signed_client_id is not null)
  )
);

create index if not exists idx_deal_items_owner_admin_id on public.crm_partner_deal_items(owner_admin_id);
create index if not exists idx_deal_items_signed_client_id on public.crm_partner_deal_items(signed_client_id);
create index if not exists idx_deal_items_partner_profile_id on public.crm_partner_deal_items(partner_profile_id);
create index if not exists idx_deal_items_status on public.crm_partner_deal_items(status);

drop trigger if exists set_crm_partner_deal_items_updated_at on public.crm_partner_deal_items;
create trigger set_crm_partner_deal_items_updated_at
before update on public.crm_partner_deal_items
for each row execute function public.crm_touch_v15_updated_at();

-- ===== Transactions =====
create table if not exists public.crm_partner_transactions (
  id uuid primary key default uuid_generate_v4(),
  owner_admin_id uuid not null references auth.users(id),
  partner_profile_id uuid not null references public.crm_partner_profiles(id) on delete cascade,
  signed_client_id uuid references public.crm_signed_clients(id) on delete set null,
  deal_item_id uuid references public.crm_partner_deal_items(id) on delete set null,
  direction text not null check (direction in ('incoming', 'outgoing')),
  transaction_type text not null check (transaction_type in (
    'commission_payment',
    'training_payment',
    'membership_fee',
    'upfront_fee',
    'advance',
    'profit_share',
    'bonus',
    'reimbursement',
    'adjustment',
    'refund',
    'other'
  )),
  transaction_date date not null,
  amount numeric(12,2) not null check (amount > 0),
  payment_method text not null default 'zelle' check (payment_method in ('zelle', 'cash', 'check', 'wire', 'ach', 'card', 'other')),
  reference_number text,
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed', 'void')),
  recorded_by uuid not null references auth.users(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_transactions_owner_admin_id on public.crm_partner_transactions(owner_admin_id);
create index if not exists idx_transactions_signed_client_id on public.crm_partner_transactions(signed_client_id);
create index if not exists idx_transactions_deal_item_id on public.crm_partner_transactions(deal_item_id);
create index if not exists idx_transactions_transaction_date on public.crm_partner_transactions(transaction_date desc);
create index if not exists idx_transactions_partner_profile_id on public.crm_partner_transactions(partner_profile_id);

drop trigger if exists set_crm_partner_transactions_updated_at on public.crm_partner_transactions;
create trigger set_crm_partner_transactions_updated_at
before update on public.crm_partner_transactions
for each row execute function public.crm_touch_v15_updated_at();

-- ===== Calculation helpers =====
create or replace function public.crm_compute_deal_item_expected_amount()
returns trigger
language plpgsql
as $$
declare
  client_contract_value numeric(12,2) := 0;
  client_profit_amount numeric(12,2) := 0;
  resolved_owner uuid;
begin
  if new.partner_profile_id is not null then
    select admin_user_id into resolved_owner
    from public.crm_partner_profiles
    where id = new.partner_profile_id;

    if resolved_owner is not null then
      new.owner_admin_id = resolved_owner;
    end if;
  end if;

  if new.signed_client_id is not null then
    select contract_value, profit_amount, owner_admin_id
      into client_contract_value, client_profit_amount, resolved_owner
    from public.crm_signed_clients
    where id = new.signed_client_id;

    if resolved_owner is not null then
      new.owner_admin_id = resolved_owner;
    end if;
  end if;

  if new.calculation_type = 'fixed_amount' then
    new.expected_amount = round(coalesce(new.flat_amount, 0) * coalesce(new.quantity, 1), 2);
  elsif new.calculation_type = 'per_signed_client' then
    new.expected_amount = round(coalesce(new.flat_amount, 0) * coalesce(new.quantity, 1), 2);
  elsif new.calculation_type = 'manual' then
    new.expected_amount = round(coalesce(new.flat_amount, 0), 2);
  elsif new.calculation_type = 'percent_profit' then
    new.expected_amount = round((coalesce(client_profit_amount, 0) * coalesce(new.percent_rate, 0)) / 100.0, 2);
  elsif new.calculation_type = 'percent_revenue' then
    new.expected_amount = round((coalesce(client_contract_value, 0) * coalesce(new.percent_rate, 0)) / 100.0, 2);
  else
    new.expected_amount = 0;
  end if;

  return new;
end;
$$;

drop trigger if exists calc_crm_partner_deal_items_expected_amount on public.crm_partner_deal_items;
create trigger calc_crm_partner_deal_items_expected_amount
before insert or update of signed_client_id, partner_profile_id, calculation_type, flat_amount, percent_rate, quantity
on public.crm_partner_deal_items
for each row execute function public.crm_compute_deal_item_expected_amount();

create or replace function public.crm_prepare_partner_transaction()
returns trigger
language plpgsql
as $$
declare
  resolved_owner uuid;
  resolved_profile uuid;
begin
  if new.deal_item_id is not null then
    select owner_admin_id, partner_profile_id, signed_client_id
      into resolved_owner, resolved_profile, new.signed_client_id
    from public.crm_partner_deal_items
    where id = new.deal_item_id;

    if resolved_owner is not null then
      new.owner_admin_id = resolved_owner;
    end if;
    if resolved_profile is not null then
      new.partner_profile_id = resolved_profile;
    end if;
  elsif new.signed_client_id is not null then
    select owner_admin_id into resolved_owner
    from public.crm_signed_clients
    where id = new.signed_client_id;

    if resolved_owner is not null then
      new.owner_admin_id = resolved_owner;
    end if;
  elsif new.partner_profile_id is not null then
    select admin_user_id into resolved_owner
    from public.crm_partner_profiles
    where id = new.partner_profile_id;

    if resolved_owner is not null then
      new.owner_admin_id = resolved_owner;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists prep_crm_partner_transactions on public.crm_partner_transactions;
create trigger prep_crm_partner_transactions
before insert or update of owner_admin_id, partner_profile_id, signed_client_id, deal_item_id
on public.crm_partner_transactions
for each row execute function public.crm_prepare_partner_transaction();

create or replace function public.crm_refresh_deal_item_status(target_deal_item_id uuid)
returns void
language plpgsql
as $$
declare
  expected_total numeric(12,2) := 0;
  paid_total numeric(12,2) := 0;
  current_status text;
begin
  if target_deal_item_id is null then
    return;
  end if;

  select expected_amount, status
    into expected_total, current_status
  from public.crm_partner_deal_items
  where id = target_deal_item_id;

  if not found then
    return;
  end if;

  if current_status in ('waived', 'void') then
    return;
  end if;

  select coalesce(sum(amount), 0)
    into paid_total
  from public.crm_partner_transactions
  where deal_item_id = target_deal_item_id
    and status = 'completed';

  update public.crm_partner_deal_items
  set status = case
      when coalesce(expected_total, 0) <= 0 then 'draft'
      when paid_total = 0 then 'due'
      when paid_total < expected_total then 'partial'
      else 'paid'
    end,
    updated_at = now()
  where id = target_deal_item_id;
end;
$$;

create or replace function public.crm_sync_deal_item_status_from_txn()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform public.crm_refresh_deal_item_status(old.deal_item_id);
    return old;
  end if;

  perform public.crm_refresh_deal_item_status(new.deal_item_id);

  if tg_op = 'UPDATE' and old.deal_item_id is distinct from new.deal_item_id then
    perform public.crm_refresh_deal_item_status(old.deal_item_id);
  end if;

  return new;
end;
$$;

drop trigger if exists sync_crm_deal_item_status_from_txn on public.crm_partner_transactions;
create trigger sync_crm_deal_item_status_from_txn
after insert or update or delete on public.crm_partner_transactions
for each row execute function public.crm_sync_deal_item_status_from_txn();

-- ===== Template snapshot + seeding =====
create or replace function public.crm_sync_partner_profiles()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_count integer := 0;
begin
  insert into public.crm_partner_profiles (
    admin_user_id,
    display_name,
    business_name,
    partner_status,
    preferred_payment_method
  )
  select
    r.user_id,
    coalesce(nullif(trim(r.display_name), ''), split_part(coalesce(r.email, 'partner@example.com'), '@', 1), 'Partner'),
    null,
    'active',
    'zelle'
  from public.crm_user_roles r
  where r.role = 'admin'
  on conflict (admin_user_id) do update
  set display_name = excluded.display_name,
      updated_at = now();

  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

create or replace function public.crm_seed_signed_client_deal_items()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_profile_id uuid;
  snapshot jsonb := '[]'::jsonb;
begin
  perform public.crm_sync_partner_profiles();

  select id into resolved_profile_id
  from public.crm_partner_profiles
  where admin_user_id = new.owner_admin_id
  limit 1;

  if resolved_profile_id is null then
    insert into public.crm_partner_profiles (admin_user_id, display_name, partner_status, preferred_payment_method)
    values (
      new.owner_admin_id,
      coalesce((select display_name from public.crm_user_roles where user_id = new.owner_admin_id), 'Partner'),
      'active',
      'zelle'
    )
    on conflict (admin_user_id) do update
    set updated_at = now()
    returning id into resolved_profile_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'template_id', t.id,
      'template_name', t.template_name,
      'item_type', t.item_type,
      'item_scope', t.item_scope,
      'direction', t.direction,
      'calculation_type', t.calculation_type,
      'flat_amount', t.flat_amount,
      'percent_rate', t.percent_rate,
      'quantity_default', t.quantity_default,
      'trigger_event', t.trigger_event,
      'sort_order', t.sort_order,
      'notes', t.notes
    ) order by t.sort_order, t.created_at), '[]'::jsonb)
    into snapshot
  from public.crm_partner_deal_templates t
  where t.partner_profile_id = resolved_profile_id
    and t.is_active = true
    and t.item_scope = 'client'
    and t.trigger_event = 'client_signed';

  update public.crm_signed_clients
  set deal_terms_snapshot = snapshot,
      updated_at = now()
  where id = new.id;

  insert into public.crm_partner_deal_items (
    owner_admin_id,
    signed_client_id,
    partner_profile_id,
    template_id,
    item_scope,
    item_name,
    item_type,
    direction,
    calculation_type,
    flat_amount,
    percent_rate,
    quantity,
    status,
    applies_on,
    notes,
    created_by
  )
  select
    new.owner_admin_id,
    new.id,
    resolved_profile_id,
    t.id,
    t.item_scope,
    t.template_name,
    t.item_type,
    t.direction,
    t.calculation_type,
    t.flat_amount,
    t.percent_rate,
    t.quantity_default,
    'due',
    new.signed_date,
    t.notes,
    new.created_by
  from public.crm_partner_deal_templates t
  where t.partner_profile_id = resolved_profile_id
    and t.is_active = true
    and t.item_scope = 'client'
    and t.trigger_event = 'client_signed';

  return new;
end;
$$;

drop trigger if exists seed_crm_signed_client_deal_items on public.crm_signed_clients;
create trigger seed_crm_signed_client_deal_items
after insert on public.crm_signed_clients
for each row execute function public.crm_seed_signed_client_deal_items();

create or replace function public.crm_refresh_percent_deal_items_from_client()
returns trigger
language plpgsql
as $$
begin
  if (old.contract_value is distinct from new.contract_value)
    or (old.profit_amount is distinct from new.profit_amount) then
    update public.crm_partner_deal_items
    set updated_at = now()
    where signed_client_id = new.id
      and calculation_type in ('percent_profit', 'percent_revenue')
      and status not in ('waived', 'void');
  end if;
  return new;
end;
$$;

drop trigger if exists refresh_percent_deal_items_from_client on public.crm_signed_clients;
create trigger refresh_percent_deal_items_from_client
after update of contract_value, profit_amount on public.crm_signed_clients
for each row execute function public.crm_refresh_percent_deal_items_from_client();

-- ===== Summary views =====
create or replace view public.v_signed_client_financials
with (security_invoker = true)
as
with item_totals as (
  select
    di.signed_client_id,
    count(*) filter (where di.status not in ('void', 'waived')) as active_item_count,
    coalesce(sum(case when di.direction = 'incoming' and di.status not in ('void', 'waived') then di.expected_amount else 0 end), 0)::numeric(12,2) as incoming_expected,
    coalesce(sum(case when di.direction = 'outgoing' and di.status not in ('void', 'waived') then di.expected_amount else 0 end), 0)::numeric(12,2) as outgoing_expected
  from public.crm_partner_deal_items di
  where di.signed_client_id is not null
  group by di.signed_client_id
),
transaction_totals as (
  select
    tx.signed_client_id,
    coalesce(sum(case when tx.direction = 'incoming' and tx.status = 'completed' then tx.amount else 0 end), 0)::numeric(12,2) as incoming_received,
    coalesce(sum(case when tx.direction = 'outgoing' and tx.status = 'completed' then tx.amount else 0 end), 0)::numeric(12,2) as outgoing_paid,
    max(tx.transaction_date) as last_transaction_date
  from public.crm_partner_transactions tx
  where tx.signed_client_id is not null
  group by tx.signed_client_id
)
select
  sc.id as signed_client_id,
  sc.owner_admin_id,
  coalesce(it.incoming_expected, 0)::numeric(12,2) as incoming_expected,
  coalesce(tt.incoming_received, 0)::numeric(12,2) as incoming_received,
  coalesce(it.outgoing_expected, 0)::numeric(12,2) as outgoing_expected,
  coalesce(tt.outgoing_paid, 0)::numeric(12,2) as outgoing_paid,
  (coalesce(it.incoming_expected, 0) - coalesce(it.outgoing_expected, 0))::numeric(12,2) as net_expected,
  (coalesce(tt.incoming_received, 0) - coalesce(tt.outgoing_paid, 0))::numeric(12,2) as net_actual,
  greatest(coalesce(it.incoming_expected, 0) - coalesce(tt.incoming_received, 0), 0)::numeric(12,2) as outstanding_receivable,
  greatest(coalesce(it.outgoing_expected, 0) - coalesce(tt.outgoing_paid, 0), 0)::numeric(12,2) as outstanding_payable,
  case
    when coalesce(it.active_item_count, 0) = 0 then 'no_items'
    when greatest(coalesce(it.incoming_expected, 0) - coalesce(tt.incoming_received, 0), 0) = 0
      and greatest(coalesce(it.outgoing_expected, 0) - coalesce(tt.outgoing_paid, 0), 0) = 0 then 'settled'
    when (coalesce(it.incoming_expected, 0) > 0 and coalesce(tt.incoming_received, 0) = 0 and coalesce(it.outgoing_expected, 0) = 0)
      or (coalesce(it.outgoing_expected, 0) > 0 and coalesce(tt.outgoing_paid, 0) = 0 and coalesce(it.incoming_expected, 0) = 0)
      or ((coalesce(it.incoming_expected, 0) + coalesce(it.outgoing_expected, 0)) > 0 and (coalesce(tt.incoming_received, 0) + coalesce(tt.outgoing_paid, 0)) = 0) then 'due'
    when (
      (coalesce(it.incoming_expected, 0) > 0 and coalesce(tt.incoming_received, 0) > 0 and coalesce(tt.incoming_received, 0) < coalesce(it.incoming_expected, 0))
      or (coalesce(it.outgoing_expected, 0) > 0 and coalesce(tt.outgoing_paid, 0) > 0 and coalesce(tt.outgoing_paid, 0) < coalesce(it.outgoing_expected, 0))
    ) then 'partial'
    when coalesce(it.incoming_expected, 0) > 0 and coalesce(it.outgoing_expected, 0) > 0 then 'mixed'
    else 'due'
  end as financial_status,
  tt.last_transaction_date
from public.crm_signed_clients sc
left join item_totals it on it.signed_client_id = sc.id
left join transaction_totals tt on tt.signed_client_id = sc.id;

create or replace view public.v_partner_financial_summary
with (security_invoker = true)
as
select
  sc.owner_admin_id,
  count(*) filter (where sc.client_status in ('active', 'on_hold')) as active_signed_clients,
  coalesce(sum(v.incoming_expected), 0)::numeric(12,2) as total_incoming_expected,
  coalesce(sum(v.incoming_received), 0)::numeric(12,2) as total_incoming_received,
  coalesce(sum(v.outgoing_expected), 0)::numeric(12,2) as total_outgoing_expected,
  coalesce(sum(v.outgoing_paid), 0)::numeric(12,2) as total_outgoing_paid,
  coalesce(sum(v.net_expected), 0)::numeric(12,2) as net_expected,
  coalesce(sum(v.net_actual), 0)::numeric(12,2) as net_actual,
  coalesce(sum(v.outstanding_receivable), 0)::numeric(12,2) as outstanding_receivable,
  coalesce(sum(v.outstanding_payable), 0)::numeric(12,2) as outstanding_payable,
  max(v.last_transaction_date) as last_transaction_date
from public.crm_signed_clients sc
left join public.v_signed_client_financials v on v.signed_client_id = sc.id
group by sc.owner_admin_id;

grant select on public.v_signed_client_financials to authenticated;
grant select on public.v_partner_financial_summary to authenticated;

-- ===== RLS =====
alter table public.crm_partner_profiles enable row level security;
alter table public.crm_partner_deal_templates enable row level security;
alter table public.crm_signed_clients enable row level security;
alter table public.crm_partner_deal_items enable row level security;
alter table public.crm_partner_transactions enable row level security;

-- Partner profiles policies
drop policy if exists "crm_partner_profiles_read" on public.crm_partner_profiles;
drop policy if exists "crm_partner_profiles_insert" on public.crm_partner_profiles;
drop policy if exists "crm_partner_profiles_update" on public.crm_partner_profiles;
drop policy if exists "crm_partner_profiles_delete" on public.crm_partner_profiles;

create policy "crm_partner_profiles_read"
on public.crm_partner_profiles
for select
to authenticated
using (
  public.crm_is_super_admin(auth.uid())
  or admin_user_id = auth.uid()
);

create policy "crm_partner_profiles_insert"
on public.crm_partner_profiles
for insert
to authenticated
with check (
  public.crm_is_super_admin(auth.uid())
  or admin_user_id = auth.uid()
);

create policy "crm_partner_profiles_update"
on public.crm_partner_profiles
for update
to authenticated
using (
  public.crm_is_super_admin(auth.uid())
  or admin_user_id = auth.uid()
)
with check (
  public.crm_is_super_admin(auth.uid())
  or admin_user_id = auth.uid()
);

create policy "crm_partner_profiles_delete"
on public.crm_partner_profiles
for delete
to authenticated
using (
  public.crm_is_super_admin(auth.uid())
);

-- Templates policies
drop policy if exists "crm_partner_templates_read" on public.crm_partner_deal_templates;
drop policy if exists "crm_partner_templates_insert" on public.crm_partner_deal_templates;
drop policy if exists "crm_partner_templates_update" on public.crm_partner_deal_templates;
drop policy if exists "crm_partner_templates_delete" on public.crm_partner_deal_templates;

create policy "crm_partner_templates_read"
on public.crm_partner_deal_templates
for select
to authenticated
using (
  public.crm_is_super_admin(auth.uid())
  or exists (
    select 1
    from public.crm_partner_profiles p
    where p.id = crm_partner_deal_templates.partner_profile_id
      and p.admin_user_id = auth.uid()
  )
);

create policy "crm_partner_templates_insert"
on public.crm_partner_deal_templates
for insert
to authenticated
with check (
  public.crm_is_super_admin(auth.uid())
  or exists (
    select 1
    from public.crm_partner_profiles p
    where p.id = crm_partner_deal_templates.partner_profile_id
      and p.admin_user_id = auth.uid()
  )
);

create policy "crm_partner_templates_update"
on public.crm_partner_deal_templates
for update
to authenticated
using (
  public.crm_is_super_admin(auth.uid())
  or exists (
    select 1
    from public.crm_partner_profiles p
    where p.id = crm_partner_deal_templates.partner_profile_id
      and p.admin_user_id = auth.uid()
  )
)
with check (
  public.crm_is_super_admin(auth.uid())
  or exists (
    select 1
    from public.crm_partner_profiles p
    where p.id = crm_partner_deal_templates.partner_profile_id
      and p.admin_user_id = auth.uid()
  )
);

create policy "crm_partner_templates_delete"
on public.crm_partner_deal_templates
for delete
to authenticated
using (
  public.crm_is_super_admin(auth.uid())
  or exists (
    select 1
    from public.crm_partner_profiles p
    where p.id = crm_partner_deal_templates.partner_profile_id
      and p.admin_user_id = auth.uid()
  )
);

-- Signed clients policies
drop policy if exists "crm_signed_clients_read" on public.crm_signed_clients;
drop policy if exists "crm_signed_clients_insert" on public.crm_signed_clients;
drop policy if exists "crm_signed_clients_update" on public.crm_signed_clients;
drop policy if exists "crm_signed_clients_delete" on public.crm_signed_clients;

create policy "crm_signed_clients_read"
on public.crm_signed_clients
for select
to authenticated
using (
  public.crm_can_access_partner_scope(owner_admin_id)
);

create policy "crm_signed_clients_insert"
on public.crm_signed_clients
for insert
to authenticated
with check (
  public.crm_can_access_partner_scope(owner_admin_id)
  and (
    public.crm_is_super_admin(auth.uid())
    or owner_admin_id = auth.uid()
  )
);

create policy "crm_signed_clients_update"
on public.crm_signed_clients
for update
to authenticated
using (
  public.crm_can_access_partner_scope(owner_admin_id)
)
with check (
  public.crm_can_access_partner_scope(owner_admin_id)
  and (
    public.crm_is_super_admin(auth.uid())
    or owner_admin_id = auth.uid()
  )
);

create policy "crm_signed_clients_delete"
on public.crm_signed_clients
for delete
to authenticated
using (
  public.crm_can_access_partner_scope(owner_admin_id)
);

-- Deal items policies
drop policy if exists "crm_partner_deal_items_read" on public.crm_partner_deal_items;
drop policy if exists "crm_partner_deal_items_insert" on public.crm_partner_deal_items;
drop policy if exists "crm_partner_deal_items_update" on public.crm_partner_deal_items;
drop policy if exists "crm_partner_deal_items_delete" on public.crm_partner_deal_items;

create policy "crm_partner_deal_items_read"
on public.crm_partner_deal_items
for select
to authenticated
using (
  public.crm_can_access_partner_scope(owner_admin_id)
);

create policy "crm_partner_deal_items_insert"
on public.crm_partner_deal_items
for insert
to authenticated
with check (
  public.crm_can_access_partner_scope(owner_admin_id)
  and (
    public.crm_is_super_admin(auth.uid())
    or owner_admin_id = auth.uid()
  )
);

create policy "crm_partner_deal_items_update"
on public.crm_partner_deal_items
for update
to authenticated
using (
  public.crm_can_access_partner_scope(owner_admin_id)
)
with check (
  public.crm_can_access_partner_scope(owner_admin_id)
  and (
    public.crm_is_super_admin(auth.uid())
    or owner_admin_id = auth.uid()
  )
);

create policy "crm_partner_deal_items_delete"
on public.crm_partner_deal_items
for delete
to authenticated
using (
  public.crm_can_access_partner_scope(owner_admin_id)
);

-- Transactions policies
drop policy if exists "crm_partner_transactions_read" on public.crm_partner_transactions;
drop policy if exists "crm_partner_transactions_insert" on public.crm_partner_transactions;
drop policy if exists "crm_partner_transactions_update" on public.crm_partner_transactions;
drop policy if exists "crm_partner_transactions_delete" on public.crm_partner_transactions;

create policy "crm_partner_transactions_read"
on public.crm_partner_transactions
for select
to authenticated
using (
  public.crm_can_access_partner_scope(owner_admin_id)
);

create policy "crm_partner_transactions_insert"
on public.crm_partner_transactions
for insert
to authenticated
with check (
  public.crm_can_access_partner_scope(owner_admin_id)
  and (
    public.crm_is_super_admin(auth.uid())
    or owner_admin_id = auth.uid()
  )
);

create policy "crm_partner_transactions_update"
on public.crm_partner_transactions
for update
to authenticated
using (
  public.crm_can_access_partner_scope(owner_admin_id)
)
with check (
  public.crm_can_access_partner_scope(owner_admin_id)
  and (
    public.crm_is_super_admin(auth.uid())
    or owner_admin_id = auth.uid()
  )
);

create policy "crm_partner_transactions_delete"
on public.crm_partner_transactions
for delete
to authenticated
using (
  public.crm_can_access_partner_scope(owner_admin_id)
);

select public.crm_sync_partner_profiles();

notify pgrst, 'reload schema';
