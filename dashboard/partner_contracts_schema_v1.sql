-- =====================================================
-- TBD Marketing Solutions — Partner Contracts V1
-- Run this AFTER:
--   1) dashboard/supabase_schema_v2.sql
--   2) dashboard/admin_role_setup.sql
--   3) dashboard/signed_clients_schema_v15.sql (recommended)
-- Purpose:
--   - Add a DocuSign-style backend foundation for partner-specific contract templates
--   - Track contract requests, signer order, lifecycle events, and generated files
--   - Support admin-partner privacy with super-admin oversight
-- =====================================================

create extension if not exists "uuid-ossp";

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

create or replace function public.crm_contracts_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =====================================================
-- STATUS MODEL
-- request.status:
--   draft -> sent -> viewed -> partially_signed -> signed
--   draft/sent/viewed/partially_signed -> declined | voided | expired
-- signer.status:
--   draft -> queued -> sent -> viewed -> signed
--   sent/viewed -> declined | expired | bounced
-- =====================================================

create table if not exists public.crm_contract_templates (
  id uuid primary key default uuid_generate_v4(),
  owner_admin_id uuid not null references auth.users(id) on delete cascade,
  partner_profile_id uuid not null references public.crm_partner_profiles(id) on delete cascade,
  template_name text not null,
  template_slug text,
  description text,
  category text,
  latest_version_number integer not null default 0 check (latest_version_number >= 0),
  active_version_id uuid,
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_contract_templates_slug_unique unique (partner_profile_id, template_slug)
);

create index if not exists idx_contract_templates_owner on public.crm_contract_templates(owner_admin_id);
create index if not exists idx_contract_templates_partner on public.crm_contract_templates(partner_profile_id);
create index if not exists idx_contract_templates_active on public.crm_contract_templates(partner_profile_id, is_active);

drop trigger if exists set_crm_contract_templates_updated_at on public.crm_contract_templates;
create trigger set_crm_contract_templates_updated_at
before update on public.crm_contract_templates
for each row execute function public.crm_contracts_touch_updated_at();

create table if not exists public.crm_contract_template_versions (
  id uuid primary key default uuid_generate_v4(),
  owner_admin_id uuid not null references auth.users(id) on delete cascade,
  partner_profile_id uuid not null references public.crm_partner_profiles(id) on delete cascade,
  template_id uuid not null references public.crm_contract_templates(id) on delete cascade,
  version_number integer not null check (version_number > 0),
  version_label text,
  status text not null default 'draft' check (status in ('draft', 'ready', 'archived')),
  storage_bucket text not null default 'partner-contracts',
  storage_object_path text,
  source_file_url text,
  source_file_name text,
  source_file_mime_type text,
  file_size_bytes bigint,
  sha256 text,
  field_manifest jsonb not null default '[]'::jsonb,
  merge_tokens jsonb not null default '[]'::jsonb,
  notes text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_contract_template_versions_unique unique (template_id, version_number)
);

create index if not exists idx_contract_template_versions_template on public.crm_contract_template_versions(template_id, version_number desc);
create index if not exists idx_contract_template_versions_partner on public.crm_contract_template_versions(partner_profile_id);

drop trigger if exists set_crm_contract_template_versions_updated_at on public.crm_contract_template_versions;
create trigger set_crm_contract_template_versions_updated_at
before update on public.crm_contract_template_versions
for each row execute function public.crm_contracts_touch_updated_at();

alter table public.crm_contract_templates
  drop constraint if exists crm_contract_templates_active_version_fkey;

alter table public.crm_contract_templates
  add constraint crm_contract_templates_active_version_fkey
  foreign key (active_version_id) references public.crm_contract_template_versions(id) on delete set null;

create table if not exists public.crm_contract_requests (
  id uuid primary key default uuid_generate_v4(),
  owner_admin_id uuid not null references auth.users(id) on delete cascade,
  partner_profile_id uuid not null references public.crm_partner_profiles(id) on delete cascade,
  template_id uuid not null references public.crm_contract_templates(id) on delete restrict,
  template_version_id uuid references public.crm_contract_template_versions(id) on delete set null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  signed_client_id uuid references public.crm_signed_clients(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  request_title text not null,
  email_subject text,
  email_message text,
  client_name text,
  client_email text,
  cc_emails text[] not null default '{}',
  expires_at timestamptz,
  sent_at timestamptz,
  viewed_at timestamptz,
  completed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'sent', 'viewed', 'partially_signed', 'signed', 'declined', 'voided', 'expired')),
  public_signing_slug text not null unique,
  request_payload jsonb not null default '{}'::jsonb,
  signed_pdf_path text,
  audit_pdf_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_contract_requests_owner on public.crm_contract_requests(owner_admin_id, created_at desc);
create index if not exists idx_contract_requests_partner on public.crm_contract_requests(partner_profile_id, created_at desc);
create index if not exists idx_contract_requests_status on public.crm_contract_requests(status, created_at desc);
create index if not exists idx_contract_requests_template on public.crm_contract_requests(template_id, created_at desc);
create index if not exists idx_contract_requests_lead on public.crm_contract_requests(lead_id);

drop trigger if exists set_crm_contract_requests_updated_at on public.crm_contract_requests;
create trigger set_crm_contract_requests_updated_at
before update on public.crm_contract_requests
for each row execute function public.crm_contracts_touch_updated_at();

create table if not exists public.crm_contract_signers (
  id uuid primary key default uuid_generate_v4(),
  owner_admin_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null references public.crm_contract_requests(id) on delete cascade,
  signer_role text not null default 'client' check (signer_role in ('client', 'co_signer', 'partner', 'custom')),
  signer_name text not null,
  signer_email text not null,
  signer_phone text,
  routing_order integer not null default 1 check (routing_order > 0),
  status text not null default 'draft' check (status in ('draft', 'queued', 'sent', 'viewed', 'signed', 'declined', 'expired', 'bounced', 'skipped')),
  sent_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  last_email_at timestamptz,
  signing_token text not null unique,
  decision_note text,
  signature_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_contract_signers_request_order_unique unique (request_id, routing_order, signer_email)
);

create index if not exists idx_contract_signers_request on public.crm_contract_signers(request_id, routing_order asc);
create index if not exists idx_contract_signers_owner on public.crm_contract_signers(owner_admin_id, request_id);
create index if not exists idx_contract_signers_status on public.crm_contract_signers(status, routing_order asc);

drop trigger if exists set_crm_contract_signers_updated_at on public.crm_contract_signers;
create trigger set_crm_contract_signers_updated_at
before update on public.crm_contract_signers
for each row execute function public.crm_contracts_touch_updated_at();

create table if not exists public.crm_contract_events (
  id uuid primary key default uuid_generate_v4(),
  owner_admin_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid references public.crm_contract_requests(id) on delete cascade,
  signer_id uuid references public.crm_contract_signers(id) on delete set null,
  template_id uuid references public.crm_contract_templates(id) on delete set null,
  event_type text not null check (event_type in (
    'template_created',
    'template_updated',
    'template_version_created',
    'request_created',
    'request_updated',
    'request_sent',
    'request_voided',
    'request_expired',
    'request_completed',
    'email_queued',
    'email_sent',
    'email_failed',
    'signer_viewed',
    'signer_signed',
    'signer_declined',
    'signer_bounced',
    'file_attached'
  )),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_type text not null default 'user' check (actor_type in ('system', 'user', 'signer', 'api')),
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_contract_events_request on public.crm_contract_events(request_id, created_at desc);
create index if not exists idx_contract_events_owner on public.crm_contract_events(owner_admin_id, created_at desc);
create index if not exists idx_contract_events_template on public.crm_contract_events(template_id, created_at desc);

create table if not exists public.crm_contract_files (
  id uuid primary key default uuid_generate_v4(),
  owner_admin_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid references public.crm_contract_requests(id) on delete cascade,
  signer_id uuid references public.crm_contract_signers(id) on delete set null,
  template_id uuid references public.crm_contract_templates(id) on delete set null,
  template_version_id uuid references public.crm_contract_template_versions(id) on delete set null,
  file_kind text not null check (file_kind in ('template_source', 'template_preview', 'request_snapshot', 'signed_pdf', 'audit_pdf', 'attachment')),
  storage_bucket text not null default 'partner-contracts',
  storage_object_path text,
  source_file_url text,
  file_name text,
  file_mime_type text,
  file_size_bytes bigint,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_contract_files_request on public.crm_contract_files(request_id, created_at desc);
create index if not exists idx_contract_files_template on public.crm_contract_files(template_id, created_at desc);
create index if not exists idx_contract_files_owner on public.crm_contract_files(owner_admin_id, created_at desc);

create or replace function public.crm_contracts_recalc_request_status(target_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer := 0;
  v_signed integer := 0;
  v_declined integer := 0;
  v_viewed integer := 0;
  v_sent integer := 0;
  v_partially integer := 0;
  v_next_status text := 'draft';
  v_existing_status text := 'draft';
begin
  select coalesce(status, 'draft')
    into v_existing_status
  from public.crm_contract_requests
  where id = target_request_id;

  select
    count(*),
    count(*) filter (where status = 'signed'),
    count(*) filter (where status = 'declined'),
    count(*) filter (where status = 'viewed'),
    count(*) filter (where status in ('sent', 'queued', 'viewed', 'signed', 'declined', 'expired', 'bounced')),
    count(*) filter (where status = 'signed')
  into v_total, v_signed, v_declined, v_viewed, v_sent, v_partially
  from public.crm_contract_signers
  where request_id = target_request_id;

  if v_existing_status in ('voided', 'expired') then
    v_next_status := v_existing_status;
  elsif v_total = 0 then
    v_next_status := 'draft';
  elsif v_declined > 0 then
    v_next_status := 'declined';
  elsif v_signed = v_total then
    v_next_status := 'signed';
  elsif v_signed > 0 then
    v_next_status := 'partially_signed';
  elsif v_viewed > 0 then
    v_next_status := 'viewed';
  elsif v_sent > 0 then
    v_next_status := 'sent';
  else
    v_next_status := 'draft';
  end if;

  update public.crm_contract_requests
     set status = v_next_status,
         sent_at = case when v_next_status in ('sent', 'viewed', 'partially_signed', 'signed', 'declined') and sent_at is null then now() else sent_at end,
         viewed_at = case when v_next_status in ('viewed', 'partially_signed', 'signed') and viewed_at is null then now() else viewed_at end,
         declined_at = case when v_next_status = 'declined' and declined_at is null then now() else declined_at end,
         completed_at = case when v_next_status = 'signed' and completed_at is null then now() else completed_at end,
         updated_at = now()
   where id = target_request_id;
end;
$$;

create or replace function public.crm_contract_signers_recalc_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.crm_contracts_recalc_request_status(coalesce(new.request_id, old.request_id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_contract_signers_recalc_request_status on public.crm_contract_signers;
create trigger trg_contract_signers_recalc_request_status
after insert or update or delete on public.crm_contract_signers
for each row execute function public.crm_contract_signers_recalc_trigger();

create or replace view public.v_contract_request_summary as
select
  r.id,
  r.owner_admin_id,
  r.partner_profile_id,
  p.display_name as partner_name,
  r.template_id,
  t.template_name,
  r.template_version_id,
  tv.version_number as template_version_number,
  r.lead_id,
  r.signed_client_id,
  r.request_title,
  r.client_name,
  r.client_email,
  r.status,
  r.sent_at,
  r.viewed_at,
  r.completed_at,
  r.declined_at,
  r.expires_at,
  r.created_at,
  r.updated_at,
  coalesce(s.signer_count, 0) as signer_count,
  coalesce(s.sent_count, 0) as sent_count,
  coalesce(s.viewed_count, 0) as viewed_count,
  coalesce(s.signed_count, 0) as signed_count,
  coalesce(s.declined_count, 0) as declined_count,
  s.next_signer_name,
  s.next_signer_email,
  s.next_routing_order
from public.crm_contract_requests r
left join public.crm_partner_profiles p on p.id = r.partner_profile_id
left join public.crm_contract_templates t on t.id = r.template_id
left join public.crm_contract_template_versions tv on tv.id = r.template_version_id
left join lateral (
  select
    count(*) as signer_count,
    count(*) filter (where cs.status in ('sent', 'viewed', 'signed', 'declined', 'expired', 'bounced')) as sent_count,
    count(*) filter (where cs.status in ('viewed', 'signed')) as viewed_count,
    count(*) filter (where cs.status = 'signed') as signed_count,
    count(*) filter (where cs.status = 'declined') as declined_count,
    (
      select signer_name from public.crm_contract_signers x
      where x.request_id = r.id and x.status in ('queued', 'sent', 'viewed')
      order by x.routing_order asc, x.created_at asc
      limit 1
    ) as next_signer_name,
    (
      select signer_email from public.crm_contract_signers x
      where x.request_id = r.id and x.status in ('queued', 'sent', 'viewed')
      order by x.routing_order asc, x.created_at asc
      limit 1
    ) as next_signer_email,
    (
      select routing_order from public.crm_contract_signers x
      where x.request_id = r.id and x.status in ('queued', 'sent', 'viewed')
      order by x.routing_order asc, x.created_at asc
      limit 1
    ) as next_routing_order
  from public.crm_contract_signers cs
  where cs.request_id = r.id
) s on true;

alter table public.crm_contract_templates enable row level security;
alter table public.crm_contract_template_versions enable row level security;
alter table public.crm_contract_requests enable row level security;
alter table public.crm_contract_signers enable row level security;
alter table public.crm_contract_events enable row level security;
alter table public.crm_contract_files enable row level security;

drop policy if exists "contract_templates_read" on public.crm_contract_templates;
create policy "contract_templates_read"
on public.crm_contract_templates
for select
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_templates_write" on public.crm_contract_templates;
create policy "contract_templates_write"
on public.crm_contract_templates
for all
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))
with check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_template_versions_read" on public.crm_contract_template_versions;
create policy "contract_template_versions_read"
on public.crm_contract_template_versions
for select
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_template_versions_write" on public.crm_contract_template_versions;
create policy "contract_template_versions_write"
on public.crm_contract_template_versions
for all
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))
with check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_requests_read" on public.crm_contract_requests;
create policy "contract_requests_read"
on public.crm_contract_requests
for select
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_requests_write" on public.crm_contract_requests;
create policy "contract_requests_write"
on public.crm_contract_requests
for all
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))
with check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_signers_read" on public.crm_contract_signers;
create policy "contract_signers_read"
on public.crm_contract_signers
for select
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_signers_write" on public.crm_contract_signers;
create policy "contract_signers_write"
on public.crm_contract_signers
for all
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))
with check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_events_read" on public.crm_contract_events;
create policy "contract_events_read"
on public.crm_contract_events
for select
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_events_write" on public.crm_contract_events;
create policy "contract_events_write"
on public.crm_contract_events
for all
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))
with check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_files_read" on public.crm_contract_files;
create policy "contract_files_read"
on public.crm_contract_files
for select
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));

drop policy if exists "contract_files_write" on public.crm_contract_files;
create policy "contract_files_write"
on public.crm_contract_files
for all
to authenticated
using (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))
with check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));
