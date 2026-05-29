/* build:1780028952622 */
// One-click Setup for Partner Contracts.
// Endpoints:
//   GET  /.netlify/functions/partner-contracts-setup?resource=status  - returns config + DB readiness
//   POST /.netlify/functions/partner-contracts-setup                  - actions:
//          action=run_migrations            -> auto-creates tables, bucket, policies, settings table
//          action=save_settings             -> stores token / from email / etc. in crm_app_settings
//          action=send_test_email           -> sends a one-off Postmark email to verify the token
//          action=generate_webhook_secret   -> creates a random secret and stores it
//
// Restricted to super_admin sessions.

const crypto = require('node:crypto');

const {
  response,
  corsHeaders,
  readJsonBody,
  cleanEmail,
  cleanText,
  requireAdminSession,
  getRequiredSupabase
} = require('./_partner-contracts-utils');

// SQL files are inlined directly here as string literals so the Netlify bundler
// always includes them with the function. No external requires, no fs reads.
const PARTNER_CONTRACTS_SQL_V1 = "-- =====================================================\n-- TBD Marketing Solutions — Partner Contracts V1\n-- Run this AFTER:\n--   1) dashboard/supabase_schema_v2.sql\n--   2) dashboard/admin_role_setup.sql\n--   3) dashboard/signed_clients_schema_v15.sql (recommended)\n-- Purpose:\n--   - Add a DocuSign-style backend foundation for partner-specific contract templates\n--   - Track contract requests, signer order, lifecycle events, and generated files\n--   - Support admin-partner privacy with super-admin oversight\n-- =====================================================\n\ncreate extension if not exists \"uuid-ossp\";\n\ncreate or replace function public.crm_is_super_admin(check_user uuid)\nreturns boolean\nlanguage sql\nstable\nsecurity definer\nset search_path = public\nas $$\n  select exists (\n    select 1\n    from public.crm_user_roles r\n    where r.user_id = check_user\n      and r.role = 'super_admin'\n  );\n$$;\n\ncreate or replace function public.crm_is_admin(check_user uuid)\nreturns boolean\nlanguage sql\nstable\nsecurity definer\nset search_path = public\nas $$\n  select exists (\n    select 1\n    from public.crm_user_roles r\n    where r.user_id = check_user\n      and r.role in ('super_admin', 'admin')\n  );\n$$;\n\ncreate or replace function public.crm_can_access_partner_scope(row_owner_admin_id uuid)\nreturns boolean\nlanguage sql\nstable\nsecurity definer\nset search_path = public\nas $$\n  select public.crm_is_super_admin(auth.uid()) or row_owner_admin_id = auth.uid();\n$$;\n\ncreate or replace function public.crm_contracts_touch_updated_at()\nreturns trigger\nlanguage plpgsql\nas $$\nbegin\n  new.updated_at = now();\n  return new;\nend;\n$$;\n\n-- =====================================================\n-- STATUS MODEL\n-- request.status:\n--   draft -> sent -> viewed -> partially_signed -> signed\n--   draft/sent/viewed/partially_signed -> declined | voided | expired\n-- signer.status:\n--   draft -> queued -> sent -> viewed -> signed\n--   sent/viewed -> declined | expired | bounced\n-- =====================================================\n\ncreate table if not exists public.crm_contract_templates (\n  id uuid primary key default uuid_generate_v4(),\n  owner_admin_id uuid not null references auth.users(id) on delete cascade,\n  partner_profile_id uuid not null references public.crm_partner_profiles(id) on delete cascade,\n  template_name text not null,\n  template_slug text,\n  description text,\n  category text,\n  latest_version_number integer not null default 0 check (latest_version_number >= 0),\n  active_version_id uuid,\n  is_active boolean not null default true,\n  created_by uuid not null references auth.users(id) on delete restrict,\n  created_at timestamptz not null default now(),\n  updated_at timestamptz not null default now(),\n  constraint crm_contract_templates_slug_unique unique (partner_profile_id, template_slug)\n);\n\ncreate index if not exists idx_contract_templates_owner on public.crm_contract_templates(owner_admin_id);\ncreate index if not exists idx_contract_templates_partner on public.crm_contract_templates(partner_profile_id);\ncreate index if not exists idx_contract_templates_active on public.crm_contract_templates(partner_profile_id, is_active);\n\ndrop trigger if exists set_crm_contract_templates_updated_at on public.crm_contract_templates;\ncreate trigger set_crm_contract_templates_updated_at\nbefore update on public.crm_contract_templates\nfor each row execute function public.crm_contracts_touch_updated_at();\n\ncreate table if not exists public.crm_contract_template_versions (\n  id uuid primary key default uuid_generate_v4(),\n  owner_admin_id uuid not null references auth.users(id) on delete cascade,\n  partner_profile_id uuid not null references public.crm_partner_profiles(id) on delete cascade,\n  template_id uuid not null references public.crm_contract_templates(id) on delete cascade,\n  version_number integer not null check (version_number > 0),\n  version_label text,\n  status text not null default 'draft' check (status in ('draft', 'ready', 'archived')),\n  storage_bucket text not null default 'partner-contracts',\n  storage_object_path text,\n  source_file_url text,\n  source_file_name text,\n  source_file_mime_type text,\n  file_size_bytes bigint,\n  sha256 text,\n  field_manifest jsonb not null default '[]'::jsonb,\n  merge_tokens jsonb not null default '[]'::jsonb,\n  notes text,\n  created_by uuid not null references auth.users(id) on delete restrict,\n  created_at timestamptz not null default now(),\n  updated_at timestamptz not null default now(),\n  constraint crm_contract_template_versions_unique unique (template_id, version_number)\n);\n\ncreate index if not exists idx_contract_template_versions_template on public.crm_contract_template_versions(template_id, version_number desc);\ncreate index if not exists idx_contract_template_versions_partner on public.crm_contract_template_versions(partner_profile_id);\n\ndrop trigger if exists set_crm_contract_template_versions_updated_at on public.crm_contract_template_versions;\ncreate trigger set_crm_contract_template_versions_updated_at\nbefore update on public.crm_contract_template_versions\nfor each row execute function public.crm_contracts_touch_updated_at();\n\nalter table public.crm_contract_templates\n  drop constraint if exists crm_contract_templates_active_version_fkey;\n\nalter table public.crm_contract_templates\n  add constraint crm_contract_templates_active_version_fkey\n  foreign key (active_version_id) references public.crm_contract_template_versions(id) on delete set null;\n\ncreate table if not exists public.crm_contract_requests (\n  id uuid primary key default uuid_generate_v4(),\n  owner_admin_id uuid not null references auth.users(id) on delete cascade,\n  partner_profile_id uuid not null references public.crm_partner_profiles(id) on delete cascade,\n  template_id uuid not null references public.crm_contract_templates(id) on delete restrict,\n  template_version_id uuid references public.crm_contract_template_versions(id) on delete set null,\n  lead_id uuid references public.crm_leads(id) on delete set null,\n  signed_client_id uuid references public.crm_signed_clients(id) on delete set null,\n  created_by uuid not null references auth.users(id) on delete restrict,\n  request_title text not null,\n  email_subject text,\n  email_message text,\n  client_name text,\n  client_email text,\n  cc_emails text[] not null default '{}',\n  expires_at timestamptz,\n  sent_at timestamptz,\n  viewed_at timestamptz,\n  completed_at timestamptz,\n  declined_at timestamptz,\n  voided_at timestamptz,\n  status text not null default 'draft' check (status in ('draft', 'sent', 'viewed', 'partially_signed', 'signed', 'declined', 'voided', 'expired')),\n  public_signing_slug text not null unique,\n  request_payload jsonb not null default '{}'::jsonb,\n  signed_pdf_path text,\n  audit_pdf_path text,\n  created_at timestamptz not null default now(),\n  updated_at timestamptz not null default now()\n);\n\ncreate index if not exists idx_contract_requests_owner on public.crm_contract_requests(owner_admin_id, created_at desc);\ncreate index if not exists idx_contract_requests_partner on public.crm_contract_requests(partner_profile_id, created_at desc);\ncreate index if not exists idx_contract_requests_status on public.crm_contract_requests(status, created_at desc);\ncreate index if not exists idx_contract_requests_template on public.crm_contract_requests(template_id, created_at desc);\ncreate index if not exists idx_contract_requests_lead on public.crm_contract_requests(lead_id);\n\ndrop trigger if exists set_crm_contract_requests_updated_at on public.crm_contract_requests;\ncreate trigger set_crm_contract_requests_updated_at\nbefore update on public.crm_contract_requests\nfor each row execute function public.crm_contracts_touch_updated_at();\n\ncreate table if not exists public.crm_contract_signers (\n  id uuid primary key default uuid_generate_v4(),\n  owner_admin_id uuid not null references auth.users(id) on delete cascade,\n  request_id uuid not null references public.crm_contract_requests(id) on delete cascade,\n  signer_role text not null default 'client' check (signer_role in ('client', 'co_signer', 'partner', 'custom')),\n  signer_name text not null,\n  signer_email text not null,\n  signer_phone text,\n  routing_order integer not null default 1 check (routing_order > 0),\n  status text not null default 'draft' check (status in ('draft', 'queued', 'sent', 'viewed', 'signed', 'declined', 'expired', 'bounced', 'skipped')),\n  sent_at timestamptz,\n  viewed_at timestamptz,\n  signed_at timestamptz,\n  declined_at timestamptz,\n  last_email_at timestamptz,\n  signing_token text not null unique,\n  decision_note text,\n  signature_payload jsonb not null default '{}'::jsonb,\n  created_at timestamptz not null default now(),\n  updated_at timestamptz not null default now(),\n  constraint crm_contract_signers_request_order_unique unique (request_id, routing_order, signer_email)\n);\n\ncreate index if not exists idx_contract_signers_request on public.crm_contract_signers(request_id, routing_order asc);\ncreate index if not exists idx_contract_signers_owner on public.crm_contract_signers(owner_admin_id, request_id);\ncreate index if not exists idx_contract_signers_status on public.crm_contract_signers(status, routing_order asc);\n\ndrop trigger if exists set_crm_contract_signers_updated_at on public.crm_contract_signers;\ncreate trigger set_crm_contract_signers_updated_at\nbefore update on public.crm_contract_signers\nfor each row execute function public.crm_contracts_touch_updated_at();\n\ncreate table if not exists public.crm_contract_events (\n  id uuid primary key default uuid_generate_v4(),\n  owner_admin_id uuid not null references auth.users(id) on delete cascade,\n  request_id uuid references public.crm_contract_requests(id) on delete cascade,\n  signer_id uuid references public.crm_contract_signers(id) on delete set null,\n  template_id uuid references public.crm_contract_templates(id) on delete set null,\n  event_type text not null check (event_type in (\n    'template_created',\n    'template_updated',\n    'template_version_created',\n    'request_created',\n    'request_updated',\n    'request_sent',\n    'request_voided',\n    'request_expired',\n    'request_completed',\n    'email_queued',\n    'email_sent',\n    'email_failed',\n    'signer_viewed',\n    'signer_signed',\n    'signer_declined',\n    'signer_bounced',\n    'file_attached'\n  )),\n  actor_user_id uuid references auth.users(id) on delete set null,\n  actor_type text not null default 'user' check (actor_type in ('system', 'user', 'signer', 'api')),\n  event_data jsonb not null default '{}'::jsonb,\n  created_at timestamptz not null default now()\n);\n\ncreate index if not exists idx_contract_events_request on public.crm_contract_events(request_id, created_at desc);\ncreate index if not exists idx_contract_events_owner on public.crm_contract_events(owner_admin_id, created_at desc);\ncreate index if not exists idx_contract_events_template on public.crm_contract_events(template_id, created_at desc);\n\ncreate table if not exists public.crm_contract_files (\n  id uuid primary key default uuid_generate_v4(),\n  owner_admin_id uuid not null references auth.users(id) on delete cascade,\n  request_id uuid references public.crm_contract_requests(id) on delete cascade,\n  signer_id uuid references public.crm_contract_signers(id) on delete set null,\n  template_id uuid references public.crm_contract_templates(id) on delete set null,\n  template_version_id uuid references public.crm_contract_template_versions(id) on delete set null,\n  file_kind text not null check (file_kind in ('template_source', 'template_preview', 'request_snapshot', 'signed_pdf', 'audit_pdf', 'attachment')),\n  storage_bucket text not null default 'partner-contracts',\n  storage_object_path text,\n  source_file_url text,\n  file_name text,\n  file_mime_type text,\n  file_size_bytes bigint,\n  created_by uuid references auth.users(id) on delete set null,\n  created_at timestamptz not null default now()\n);\n\ncreate index if not exists idx_contract_files_request on public.crm_contract_files(request_id, created_at desc);\ncreate index if not exists idx_contract_files_template on public.crm_contract_files(template_id, created_at desc);\ncreate index if not exists idx_contract_files_owner on public.crm_contract_files(owner_admin_id, created_at desc);\n\ncreate or replace function public.crm_contracts_recalc_request_status(target_request_id uuid)\nreturns void\nlanguage plpgsql\nsecurity definer\nset search_path = public\nas $$\ndeclare\n  v_total integer := 0;\n  v_signed integer := 0;\n  v_declined integer := 0;\n  v_viewed integer := 0;\n  v_sent integer := 0;\n  v_partially integer := 0;\n  v_next_status text := 'draft';\n  v_existing_status text := 'draft';\nbegin\n  select coalesce(status, 'draft')\n    into v_existing_status\n  from public.crm_contract_requests\n  where id = target_request_id;\n\n  select\n    count(*),\n    count(*) filter (where status = 'signed'),\n    count(*) filter (where status = 'declined'),\n    count(*) filter (where status = 'viewed'),\n    count(*) filter (where status in ('sent', 'queued', 'viewed', 'signed', 'declined', 'expired', 'bounced')),\n    count(*) filter (where status = 'signed')\n  into v_total, v_signed, v_declined, v_viewed, v_sent, v_partially\n  from public.crm_contract_signers\n  where request_id = target_request_id;\n\n  if v_existing_status in ('voided', 'expired') then\n    v_next_status := v_existing_status;\n  elsif v_total = 0 then\n    v_next_status := 'draft';\n  elsif v_declined > 0 then\n    v_next_status := 'declined';\n  elsif v_signed = v_total then\n    v_next_status := 'signed';\n  elsif v_signed > 0 then\n    v_next_status := 'partially_signed';\n  elsif v_viewed > 0 then\n    v_next_status := 'viewed';\n  elsif v_sent > 0 then\n    v_next_status := 'sent';\n  else\n    v_next_status := 'draft';\n  end if;\n\n  update public.crm_contract_requests\n     set status = v_next_status,\n         sent_at = case when v_next_status in ('sent', 'viewed', 'partially_signed', 'signed', 'declined') and sent_at is null then now() else sent_at end,\n         viewed_at = case when v_next_status in ('viewed', 'partially_signed', 'signed') and viewed_at is null then now() else viewed_at end,\n         declined_at = case when v_next_status = 'declined' and declined_at is null then now() else declined_at end,\n         completed_at = case when v_next_status = 'signed' and completed_at is null then now() else completed_at end,\n         updated_at = now()\n   where id = target_request_id;\nend;\n$$;\n\ncreate or replace function public.crm_contract_signers_recalc_trigger()\nreturns trigger\nlanguage plpgsql\nsecurity definer\nset search_path = public\nas $$\nbegin\n  perform public.crm_contracts_recalc_request_status(coalesce(new.request_id, old.request_id));\n  return coalesce(new, old);\nend;\n$$;\n\ndrop trigger if exists trg_contract_signers_recalc_request_status on public.crm_contract_signers;\ncreate trigger trg_contract_signers_recalc_request_status\nafter insert or update or delete on public.crm_contract_signers\nfor each row execute function public.crm_contract_signers_recalc_trigger();\n\ncreate or replace view public.v_contract_request_summary as\nselect\n  r.id,\n  r.owner_admin_id,\n  r.partner_profile_id,\n  p.display_name as partner_name,\n  r.template_id,\n  t.template_name,\n  r.template_version_id,\n  tv.version_number as template_version_number,\n  r.lead_id,\n  r.signed_client_id,\n  r.request_title,\n  r.client_name,\n  r.client_email,\n  r.status,\n  r.sent_at,\n  r.viewed_at,\n  r.completed_at,\n  r.declined_at,\n  r.expires_at,\n  r.created_at,\n  r.updated_at,\n  coalesce(s.signer_count, 0) as signer_count,\n  coalesce(s.sent_count, 0) as sent_count,\n  coalesce(s.viewed_count, 0) as viewed_count,\n  coalesce(s.signed_count, 0) as signed_count,\n  coalesce(s.declined_count, 0) as declined_count,\n  s.next_signer_name,\n  s.next_signer_email,\n  s.next_routing_order\nfrom public.crm_contract_requests r\nleft join public.crm_partner_profiles p on p.id = r.partner_profile_id\nleft join public.crm_contract_templates t on t.id = r.template_id\nleft join public.crm_contract_template_versions tv on tv.id = r.template_version_id\nleft join lateral (\n  select\n    count(*) as signer_count,\n    count(*) filter (where cs.status in ('sent', 'viewed', 'signed', 'declined', 'expired', 'bounced')) as sent_count,\n    count(*) filter (where cs.status in ('viewed', 'signed')) as viewed_count,\n    count(*) filter (where cs.status = 'signed') as signed_count,\n    count(*) filter (where cs.status = 'declined') as declined_count,\n    (\n      select signer_name from public.crm_contract_signers x\n      where x.request_id = r.id and x.status in ('queued', 'sent', 'viewed')\n      order by x.routing_order asc, x.created_at asc\n      limit 1\n    ) as next_signer_name,\n    (\n      select signer_email from public.crm_contract_signers x\n      where x.request_id = r.id and x.status in ('queued', 'sent', 'viewed')\n      order by x.routing_order asc, x.created_at asc\n      limit 1\n    ) as next_signer_email,\n    (\n      select routing_order from public.crm_contract_signers x\n      where x.request_id = r.id and x.status in ('queued', 'sent', 'viewed')\n      order by x.routing_order asc, x.created_at asc\n      limit 1\n    ) as next_routing_order\n  from public.crm_contract_signers cs\n  where cs.request_id = r.id\n) s on true;\n\nalter table public.crm_contract_templates enable row level security;\nalter table public.crm_contract_template_versions enable row level security;\nalter table public.crm_contract_requests enable row level security;\nalter table public.crm_contract_signers enable row level security;\nalter table public.crm_contract_events enable row level security;\nalter table public.crm_contract_files enable row level security;\n\ndrop policy if exists \"contract_templates_read\" on public.crm_contract_templates;\ncreate policy \"contract_templates_read\"\non public.crm_contract_templates\nfor select\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_templates_write\" on public.crm_contract_templates;\ncreate policy \"contract_templates_write\"\non public.crm_contract_templates\nfor all\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))\nwith check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_template_versions_read\" on public.crm_contract_template_versions;\ncreate policy \"contract_template_versions_read\"\non public.crm_contract_template_versions\nfor select\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_template_versions_write\" on public.crm_contract_template_versions;\ncreate policy \"contract_template_versions_write\"\non public.crm_contract_template_versions\nfor all\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))\nwith check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_requests_read\" on public.crm_contract_requests;\ncreate policy \"contract_requests_read\"\non public.crm_contract_requests\nfor select\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_requests_write\" on public.crm_contract_requests;\ncreate policy \"contract_requests_write\"\non public.crm_contract_requests\nfor all\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))\nwith check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_signers_read\" on public.crm_contract_signers;\ncreate policy \"contract_signers_read\"\non public.crm_contract_signers\nfor select\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_signers_write\" on public.crm_contract_signers;\ncreate policy \"contract_signers_write\"\non public.crm_contract_signers\nfor all\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))\nwith check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_events_read\" on public.crm_contract_events;\ncreate policy \"contract_events_read\"\non public.crm_contract_events\nfor select\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_events_write\" on public.crm_contract_events;\ncreate policy \"contract_events_write\"\non public.crm_contract_events\nfor all\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))\nwith check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_files_read\" on public.crm_contract_files;\ncreate policy \"contract_files_read\"\non public.crm_contract_files\nfor select\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n\ndrop policy if exists \"contract_files_write\" on public.crm_contract_files;\ncreate policy \"contract_files_write\"\non public.crm_contract_files\nfor all\nto authenticated\nusing (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id))\nwith check (public.crm_is_admin(auth.uid()) and public.crm_can_access_partner_scope(owner_admin_id));\n";
const PARTNER_CONTRACTS_SQL_V2_PHASE2D = "-- =====================================================\n-- TBD Marketing Solutions - Partner Contracts Phase 2D upgrade\n-- Run AFTER dashboard/partner_contracts_schema_v1.sql\n-- Adds:\n--   - Supabase Storage bucket for partner contract files (partner-contracts)\n--   - Storage policies scoped to authenticated admins / super-admins\n--   - Postmark webhook lifecycle events (delivered, opened, bounce, complaint)\n--   - Audit PDF / signed PDF columns are already present in V1; this script\n--     simply extends the allowed event_type list and adds helpful indexes.\n-- =====================================================\n\n-- 1. Storage bucket. The partner-contracts bucket stores:\n--    * Template source files (uploaded by admins)\n--    * Generated signed PDFs and audit PDFs (created by the Netlify function)\ninsert into storage.buckets (id, name, public)\nvalues ('partner-contracts', 'partner-contracts', false)\non conflict (id) do nothing;\n\n-- 2. Storage policies. Only admins/super-admins can read or write the bucket.\n--    The service-role key bypasses RLS so server-side uploads continue to work.\ndrop policy if exists \"partner_contracts_storage_read\" on storage.objects;\ncreate policy \"partner_contracts_storage_read\"\non storage.objects\nfor select\nto authenticated\nusing (\n  bucket_id = 'partner-contracts'\n  and public.crm_is_admin(auth.uid())\n);\n\ndrop policy if exists \"partner_contracts_storage_write\" on storage.objects;\ncreate policy \"partner_contracts_storage_write\"\non storage.objects\nfor insert\nto authenticated\nwith check (\n  bucket_id = 'partner-contracts'\n  and public.crm_is_admin(auth.uid())\n);\n\ndrop policy if exists \"partner_contracts_storage_update\" on storage.objects;\ncreate policy \"partner_contracts_storage_update\"\non storage.objects\nfor update\nto authenticated\nusing (\n  bucket_id = 'partner-contracts'\n  and public.crm_is_admin(auth.uid())\n)\nwith check (\n  bucket_id = 'partner-contracts'\n  and public.crm_is_admin(auth.uid())\n);\n\ndrop policy if exists \"partner_contracts_storage_delete\" on storage.objects;\ncreate policy \"partner_contracts_storage_delete\"\non storage.objects\nfor delete\nto authenticated\nusing (\n  bucket_id = 'partner-contracts'\n  and public.crm_is_admin(auth.uid())\n);\n\n-- 3. Allow Postmark webhook lifecycle events in crm_contract_events.\n-- v3.6.1: Idempotent rebuild. If the constraint already includes the broader\n-- event types added in later migrations (request_cancelled, template_fields_mapped,\n-- rendered_pdf_generated, request_prefilled), V3 or later has already widened it\n-- and we should NOT downgrade the constraint here. Otherwise, do the V2 rebuild.\ndo $v2_events_idempotent$\ndeclare\n  current_def text;\n  is_broader boolean := false;\nbegin\n  select pg_get_constraintdef(c.oid) into current_def\n  from pg_constraint c\n  join pg_class t on t.oid = c.conrelid\n  where t.relname = 'crm_contract_events'\n    and c.conname = 'crm_contract_events_event_type_check'\n    and c.contype = 'c'\n  limit 1;\n\n  -- If the constraint already has the V3+ values, skip — don't downgrade.\n  if current_def is not null\n     and (current_def like '%request_cancelled%'\n          or current_def like '%template_fields_mapped%'\n          or current_def like '%rendered_pdf_generated%'\n          or current_def like '%request_prefilled%') then\n    raise notice 'crm_contract_events_event_type_check already broader than V2; skipping rebuild';\n    return;\n  end if;\n\n  -- Otherwise, quarantine any rows whose event_type isn't in V2's list, then rebuild\n  alter table public.crm_contract_events\n    drop constraint if exists crm_contract_events_event_type_check;\n\n  update public.crm_contract_events\n  set event_data = coalesce(event_data, '{}'::jsonb)\n                || jsonb_build_object('_legacy_event_type', coalesce(event_type, '__NULL__')),\n      event_type = 'request_updated'\n  where event_type is null\n     or btrim(event_type) = ''\n     or event_type not in (\n       'template_created','template_updated','template_version_created',\n       'request_created','request_updated','request_sent','request_resent',\n       'request_voided','request_expired','request_completed','request_archived',\n       'email_queued','email_sent','email_failed','email_delivered','email_opened',\n       'email_bounced','email_spam_complaint','email_link_clicked',\n       'signer_viewed','signer_signed','signer_declined','signer_bounced',\n       'in_person_session_started','file_attached','signed_pdf_generated','audit_pdf_generated'\n     );\n\n  alter table public.crm_contract_events\n    add constraint crm_contract_events_event_type_check\n    check (event_type in (\n      'template_created','template_updated','template_version_created',\n      'request_created','request_updated','request_sent','request_resent',\n      'request_voided','request_expired','request_completed','request_archived',\n      'email_queued','email_sent','email_failed','email_delivered','email_opened',\n      'email_bounced','email_spam_complaint','email_link_clicked',\n      'signer_viewed','signer_signed','signer_declined','signer_bounced',\n      'in_person_session_started','file_attached','signed_pdf_generated','audit_pdf_generated'\n    ));\n\n  raise notice 'crm_contract_events_event_type_check rebuilt with V2 list';\nend $v2_events_idempotent$;\n\n-- 4. Helpful indexes for the new event categories\ncreate index if not exists idx_contract_events_signer\n  on public.crm_contract_events(signer_id, created_at desc);\ncreate index if not exists idx_contract_events_event_type\n  on public.crm_contract_events(event_type, created_at desc);\n\n-- 5. Add convenience columns for storage object metadata on the request itself.\nalter table public.crm_contract_requests\n  add column if not exists signed_pdf_storage_bucket text,\n  add column if not exists audit_pdf_storage_bucket text,\n  add column if not exists signed_pdf_generated_at timestamptz,\n  add column if not exists audit_pdf_generated_at timestamptz;\n";

const {
  loadSettings,
  clearSettingsCache,
  getPostmarkToken,
  getFromEmail,
  getFromName,
  getMessageStream,
  getWebhookSecret,
  sendPostmarkEmail,
  resolveBaseUrl,
  DEFAULT_FROM_EMAIL,
  DEFAULT_FROM_NAME,
  DEFAULT_MESSAGE_STREAM
} = require('./_partner-contracts-email');

const APP_SETTINGS_BOOTSTRAP_SQL = `
create table if not exists public.crm_app_settings (
  setting_key text primary key,
  setting_value text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.crm_app_settings enable row level security;

drop policy if exists "crm_app_settings_super_admin_select" on public.crm_app_settings;
create policy "crm_app_settings_super_admin_select"
on public.crm_app_settings
for select
to authenticated
using (public.crm_is_super_admin(auth.uid()));

drop policy if exists "crm_app_settings_super_admin_write" on public.crm_app_settings;
create policy "crm_app_settings_super_admin_write"
on public.crm_app_settings
for all
to authenticated
using (public.crm_is_super_admin(auth.uid()))
with check (public.crm_is_super_admin(auth.uid()));
`;

const PARTNER_CONTRACTS_SQL_V3_PHASE3 = "-- =====================================================\n-- TBD Marketing Solutions - Partner Contracts Phase 3 upgrade\n-- Run AFTER dashboard/partner_contracts_schema_v2_phase2d.sql\n-- Adds:\n--   - merge_fields jsonb on template versions (field definitions with coordinates)\n--   - prefill_values jsonb on contract requests (admin-entered values to merge)\n--   - signature_placements jsonb on contract signers (which fields each signer fills)\n--   - rendered_pdf_path on contract requests (final PDF with signatures embedded)\n--   - default LOR template merge field schema\n-- =====================================================\n\n-- 1. Template versions: add merge_fields for coordinate-aware field definitions.\n--    Each entry: { id, label, type, page, x, y, width, height, signer_role, required, prefill_source }\n--    type: 'text' | 'date' | 'signature' | 'initials' | 'checkbox'\n--    prefill_source: optional CRM field key ('client_name', 'client_email', 'client_phone',\n--                    'address_full', 'address_street', 'address_city', 'address_state',\n--                    'address_zip', 'insurance_carrier', 'policy_number', 'claim_number',\n--                    'date_of_loss', 'date_of_commencement', 'today', 'partner_name')\nalter table public.crm_contract_template_versions\n  add column if not exists merge_fields jsonb not null default '[]'::jsonb;\n\ncreate index if not exists idx_contract_template_versions_merge_fields\n  on public.crm_contract_template_versions using gin (merge_fields);\n\n-- 2. Contract requests: prefill values + rendered PDF\nalter table public.crm_contract_requests\n  add column if not exists prefill_values jsonb not null default '{}'::jsonb,\n  add column if not exists rendered_pdf_path text,\n  add column if not exists rendered_pdf_storage_bucket text,\n  add column if not exists rendered_pdf_generated_at timestamptz;\n\n-- 3. Contract signers: signature placements (which fields they own + signature image data)\nalter table public.crm_contract_signers\n  add column if not exists signature_placements jsonb not null default '[]'::jsonb,\n  add column if not exists signature_image_data text;  -- base64 PNG of drawn signature\n\n-- 4. Extend file_kind enum on crm_contract_files for the new rendered PDF type\n-- v3.5.10: Idempotent file_kind constraint rebuild (only runs if 'rendered_pdf' missing)\ndo $files_idempotent$\ndeclare\n  current_def text;\nbegin\n  select pg_get_constraintdef(c.oid) into current_def\n  from pg_constraint c\n  join pg_class t on t.oid = c.conrelid\n  where t.relname = 'crm_contract_files'\n    and c.conname = 'crm_contract_files_file_kind_check'\n    and c.contype = 'c'\n  limit 1;\n  if current_def is not null and current_def like '%rendered_pdf%' then\n    raise notice 'crm_contract_files_file_kind_check already canonical; skipping rebuild';\n    return;\n  end if;\n  alter table public.crm_contract_files\n    drop constraint if exists crm_contract_files_file_kind_check;\n  -- Quarantine any non-canonical file_kind values\n  update public.crm_contract_files\n  set file_kind = 'attachment'\n  where file_kind not in (\n    'template_source','template_preview','request_snapshot','rendered_pdf','signed_pdf','audit_pdf','attachment'\n  );\n  alter table public.crm_contract_files\n    add constraint crm_contract_files_file_kind_check\n    check (file_kind in (\n      'template_source','template_preview','request_snapshot','rendered_pdf','signed_pdf','audit_pdf','attachment'\n    ));\n  raise notice 'crm_contract_files_file_kind_check rebuilt successfully';\nend $files_idempotent$;\n\n-- 5. Extend event_type enum on crm_contract_events for new events\n-- v3.5.10: Idempotent - if the constraint already has 'request_cancelled' in its\n-- definition, the V3 cleanup has already been applied; skip the destructive work\n-- entirely. Otherwise, proceed with the full normalize + quarantine + re-add flow.\n\ndo $idempotent$\ndeclare\n  current_def text;\nbegin\n  select pg_get_constraintdef(c.oid) into current_def\n  from pg_constraint c\n  join pg_class t on t.oid = c.conrelid\n  where t.relname = 'crm_contract_events'\n    and c.conname = 'crm_contract_events_event_type_check'\n    and c.contype = 'c'\n  limit 1;\n  -- If the constraint exists AND already includes 'request_cancelled' AND\n  -- 'rendered_pdf_generated' AND 'audit_pdf_generated', it's the v3.5+ canonical\n  -- version and we don't need to touch it.\n  if current_def is not null\n     and current_def like '%request_cancelled%'\n     and current_def like '%rendered_pdf_generated%'\n     and current_def like '%audit_pdf_generated%' then\n    raise notice 'crm_contract_events_event_type_check already canonical; skipping rebuild';\n    return;\n  end if;\n\n  -- Otherwise, run the full cleanup + rebuild sequence inside this DO block\n  -- so it's all one atomic transaction.\n  alter table public.crm_contract_events\n    drop constraint if exists crm_contract_events_event_type_check;\n\n  update public.crm_contract_events\n  set event_type = lower(btrim(event_type))\n  where event_type is not null\n    and event_type <> lower(btrim(event_type));\n\n  update public.crm_contract_events\n  set event_data = coalesce(event_data, '{}'::jsonb) || jsonb_build_object('_legacy_event_type', coalesce(event_type, '__NULL__')),\n      event_type = 'request_updated'\n  where event_type is null or btrim(event_type) = '';\n\n  update public.crm_contract_events\n  set event_data = coalesce(event_data, '{}'::jsonb) || jsonb_build_object('_legacy_event_type', event_type),\n      event_type = 'request_updated'\n  where event_type not in (\n    'template_created','template_updated','template_version_created','template_fields_mapped',\n    'request_created','request_updated','request_prefilled','request_sent','request_resent',\n    'request_cancelled','request_voided','request_expired','request_completed','request_archived',\n    'email_queued','email_sent','email_failed','email_delivered','email_opened','email_bounced',\n    'email_spam_complaint','email_link_clicked','signer_viewed','signer_signed','signer_declined',\n    'signer_bounced','in_person_session_started','file_attached','rendered_pdf_generated',\n    'signed_pdf_generated','audit_pdf_generated'\n  );\n\n  alter table public.crm_contract_events\n    add constraint crm_contract_events_event_type_check\n    check (event_type in (\n      'template_created','template_updated','template_version_created','template_fields_mapped',\n      'request_created','request_updated','request_prefilled','request_sent','request_resent',\n      'request_cancelled','request_voided','request_expired','request_completed','request_archived',\n      'email_queued','email_sent','email_failed','email_delivered','email_opened','email_bounced',\n      'email_spam_complaint','email_link_clicked','signer_viewed','signer_signed','signer_declined',\n      'signer_bounced','in_person_session_started','file_attached','rendered_pdf_generated',\n      'signed_pdf_generated','audit_pdf_generated'\n    ));\n\n  raise notice 'crm_contract_events_event_type_check rebuilt successfully';\nend $idempotent$;\n\n-- The original (non-idempotent) DROP/UPDATE/ADD sequence is replaced by the DO block above.\n-- Keeping this empty stub for backwards safety:\nalter table public.crm_contract_events\n  drop constraint if exists crm_contract_events_event_type_check__OBSOLETE_NEVER_EXISTS;\n\n\n";
const PARTNER_CONTRACTS_SQL_V4_PHASE4 = "-- =====================================================\n-- TBD Marketing Solutions — DocuMike Phase 4 (v3.5.0)\n-- Run AFTER:\n--   dashboard/partner_contracts_schema_v1.sql\n--   dashboard/partner_contracts_schema_v2_phase2d.sql\n--   dashboard/partner_contracts_schema_v3_phase3.sql\n-- Adds:\n--   - contact_email / contact_phone on crm_partner_profiles (for partner-as-signer email)\n--   - cancelled_at / cancel_reason on crm_contract_requests (for Cancel Request feature)\n--   - allows status='cancelled' on requests (alongside existing draft/sent/viewed/etc)\n-- =====================================================\n\nalter table public.crm_partner_profiles\n  add column if not exists contact_email text,\n  add column if not exists contact_phone text;\n\ncomment on column public.crm_partner_profiles.contact_email is\n  'Partner contact email used by DocuMike to send their copy of the signed contract.';\ncomment on column public.crm_partner_profiles.contact_phone is\n  'Partner contact phone number (optional, used for signing notifications).';\n\n-- Cancel/Delete request support (v3.3.0 used best-effort fallback; this makes it first-class)\nalter table public.crm_contract_requests\n  add column if not exists cancelled_at timestamptz,\n  add column if not exists cancel_reason text;\n\n-- Widen status check to include 'cancelled'\ndo $$\nbegin\n  -- Drop existing check constraint if its name is predictable; otherwise let admins\n  -- re-apply this migration after manually dropping the old constraint name.\n  if exists (\n    select 1 from pg_constraint c\n    join pg_class t on t.oid = c.conrelid\n    where t.relname = 'crm_contract_requests'\n      and c.contype = 'c'\n      and pg_get_constraintdef(c.oid) like '%status%'\n      and pg_get_constraintdef(c.oid) not like '%cancelled%'\n  ) then\n    -- Try common constraint names from V1\n    begin\n      alter table public.crm_contract_requests\n        drop constraint if exists crm_contract_requests_status_check;\n    exception when others then\n      null;\n    end;\n    -- Add the broader constraint\n    begin\n      alter table public.crm_contract_requests\n        add constraint crm_contract_requests_status_check\n        check (status in ('draft', 'sent', 'viewed', 'partially_signed', 'signed', 'declined', 'voided', 'expired', 'cancelled'));\n    exception when duplicate_object then\n      null;\n    end;\n  end if;\nend $$;\n\n-- Helpful index for sequential-signer email lookups\ncreate index if not exists idx_contract_signers_request_status\n  on public.crm_contract_signers (request_id, status, routing_order);\n";
const TEAM_LABEL_UPGRADE_V2_SQL = "-- =====================================================\n-- v3.5.7: Team label upgrade for crm_user_roles\n-- Adds team_label column (if missing) and removes the\n-- restrictive Your Team / Chay Team check so any team\n-- name is allowed (matches v3.5.4 frontend behavior).\n-- Safe to run multiple times.\n-- =====================================================\n\nalter table if exists public.crm_user_roles\n  add column if not exists team_label text;\n\n-- Drop the old restrictive constraint (only allowed 'Your Team' / 'Chay Team')\nalter table if exists public.crm_user_roles\n  drop constraint if exists crm_user_roles_team_label_check;\n\n-- New constraint: 60-char limit (matches frontend), null allowed.\n-- v3.6.2: drop first so this migration is idempotent (handles the case where it was added manually).\nalter table if exists public.crm_user_roles\n  drop constraint if exists crm_user_roles_team_label_length;\n\nalter table if exists public.crm_user_roles\n  add constraint crm_user_roles_team_label_length\n  check (team_label is null or char_length(team_label) <= 60);\n\ncreate index if not exists idx_crm_user_roles_team_label\n  on public.crm_user_roles(team_label);\n\n-- Force PostgREST to reload its schema cache so the API sees the new column immediately\nnotify pgrst, 'reload schema';\n";

const INLINED_MIGRATIONS = {
  'partner_contracts_schema_v1.sql': PARTNER_CONTRACTS_SQL_V1,
  'partner_contracts_schema_v2_phase2d.sql': PARTNER_CONTRACTS_SQL_V2_PHASE2D,
  'partner_contracts_schema_v3_phase3.sql': PARTNER_CONTRACTS_SQL_V3_PHASE3,
  'partner_contracts_schema_v4_phase4.sql': PARTNER_CONTRACTS_SQL_V4_PHASE4,
  'team_label_upgrade_v2.sql': TEAM_LABEL_UPGRADE_V2_SQL
};

function readMigrationFile(filename) {
  const sql = INLINED_MIGRATIONS[filename];
  if (!sql) throw new Error(`Migration file not registered: ${filename}`);
  return sql;
}

// v3.6.0: Enhanced runSqlBlock with statement-by-statement diagnostics.
// When a multi-statement migration fails inside crm_app_run_sql, we get a
// generic error message ("check constraint violated") with no hint which
// statement broke. So if the bulk run fails, we re-try each statement
// individually to pinpoint the failing one and surface its actual error.
async function runSqlBlock(sb, sql, options = {}) {
  if (!sql || !sql.trim()) return { skipped: true };
  const debug = options.debug !== false;
  const startedAt = Date.now();
  const { error } = await sb.rpc('crm_app_run_sql', { sql_text: sql });
  if (!error) {
    return { ok: true, duration_ms: Date.now() - startedAt };
  }
  // Bulk run failed. Try to identify which statement caused it.
  const rawError = error.message || String(error);
  const result = { ok: false, error: rawError, duration_ms: Date.now() - startedAt };
  if (debug) {
    try {
      // Split SQL into individual statements respecting dollar-quoted blocks.
      const statements = splitSqlStatements(sql);
      result.total_statements = statements.length;
      // Try each one in isolation; whichever fails is the culprit.
      // We don't actually run the whole sequence (that would mutate the DB twice);
      // we just retry until we hit the first failure and report it.
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        if (!stmt || !stmt.trim()) continue;
        const tryRes = await sb.rpc('crm_app_run_sql', { sql_text: stmt });
        if (tryRes.error) {
          result.failing_statement_index = i;
          result.failing_statement_preview = stmt.length > 240 ? stmt.slice(0, 240) + '...' : stmt;
          result.failing_statement_error = tryRes.error.message || String(tryRes.error);
          break;
        }
      }
    } catch (diagErr) {
      result.diagnostic_error = String(diagErr.message || diagErr);
    }
  }
  return result;
}

// Splits SQL on semicolons that are not inside dollar-quoted blocks ($$...$$ or $tag$...$tag$).
function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let inDollarTag = null;  // e.g. '$$' or '$idempotent$'
  while (i < sql.length) {
    const ch = sql[i];
    // Check for start/end of dollar-quoted block
    if (ch === '$') {
      // Read the tag: $ ... $
      const end = sql.indexOf('$', i + 1);
      if (end >= 0 && end - i < 50) {
        const tag = sql.slice(i, end + 1);
        // Only treat as a tag if it matches the dollar-quote pattern: $[a-zA-Z_]*$
        if (/^\$[a-zA-Z_]*\$$/.test(tag)) {
          if (inDollarTag === null) {
            inDollarTag = tag;
          } else if (inDollarTag === tag) {
            inDollarTag = null;
          }
          buf += tag;
          i = end + 1;
          continue;
        }
      }
    }
    // Line comments (-- to EOL)
    if (!inDollarTag && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl < 0) { buf += sql.slice(i); break; }
      buf += sql.slice(i, nl);
      i = nl;
      continue;
    }
    // Statement terminator (only outside dollar quotes)
    if (!inDollarTag && ch === ';') {
      buf += ';';
      const stmt = buf.trim();
      if (stmt && stmt !== ';') out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  // Trailing partial statement
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

const RUN_SQL_HELPER = `
create or replace function public.crm_app_run_sql(sql_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  execute sql_text;
end;
$$;

revoke all on function public.crm_app_run_sql(text) from public;
revoke all on function public.crm_app_run_sql(text) from anon;
revoke all on function public.crm_app_run_sql(text) from authenticated;
-- Only the service role / postgres can invoke this helper.
`;

async function ensureRunSqlHelper(sb) {
  try {
    const { error } = await sb.rpc('crm_app_run_sql', { sql_text: 'select 1;' });
    if (!error) return { ok: true };
    return { ok: false, missing_helper: true, error: 'The one-click setup helper has not been installed yet. Copy the SQL on this page, paste it into Supabase SQL Editor, then click "I\'ve run it—check again".' };
  } catch (err) {
    return { ok: false, missing_helper: true, error: 'Could not reach the setup helper (' + (err.message || 'unknown error') + '). Copy the SQL on this page and run it once in Supabase SQL Editor.' };
  }
}

async function tableExists(sb, tableName) {
  // PostgREST doesn't expose information_schema by default, so we probe the
  // table directly with a LIMIT 0 select. If the table exists we get no error
  // (or only a column-not-found error, which still proves the table exists).
  // Common Supabase error codes:
  //   42P01 = undefined_table  -> the table does NOT exist
  //   PGRST205 = PostgREST schema cache miss -> also means table does not exist
  //   42703 = undefined_column -> the table DOES exist, just no 'id' col probably
  try {
    const { error } = await sb.from(tableName).select('*', { count: 'exact', head: true }).limit(0);
    if (!error) return true;
    const code = String(error.code || '');
    const msg = String(error.message || '').toLowerCase();
    if (code === '42P01') return false;
    if (code === 'PGRST205') return false;
    if (msg.includes('does not exist')) return false;
    if (msg.includes('could not find the table')) return false;
    // Any other error (RLS denied, etc.) means the table is there.
    return true;
  } catch {
    return false;
  }
}

async function bucketExists(sb) {
  try {
    const { data } = await sb.storage.getBucket('partner-contracts');
    return Boolean(data?.id);
  } catch {
    return false;
  }
}

async function ensureBucket(sb) {
  const exists = await bucketExists(sb);
  if (exists) return { existed: true };
  const { error } = await sb.storage.createBucket('partner-contracts', { public: false });
  if (error && !String(error.message || '').toLowerCase().includes('already exists')) {
    return { ok: false, error: error.message };
  }
  return { existed: false, created: true };
}

async function ensureDefaultSettings(sb, session) {
  const rows = [
    { key: 'contract_from_email', value: DEFAULT_FROM_EMAIL },
    { key: 'contract_from_name', value: DEFAULT_FROM_NAME },
    { key: 'postmark_message_stream', value: DEFAULT_MESSAGE_STREAM }
  ];
  for (const row of rows) {
    const { data: existing } = await sb.from('crm_app_settings').select('setting_value').eq('setting_key', row.key).maybeSingle();
    if (!existing) {
      await sb.from('crm_app_settings').insert({ setting_key: row.key, setting_value: row.value, updated_by: session?.requester?.id || null });
    }
  }
  // Auto-generate a webhook secret if not set
  const { data: existingSecret } = await sb.from('crm_app_settings').select('setting_value').eq('setting_key', 'postmark_webhook_secret').maybeSingle();
  if (!existingSecret) {
    const secret = crypto.randomBytes(24).toString('hex');
    await sb.from('crm_app_settings').insert({ setting_key: 'postmark_webhook_secret', setting_value: secret, updated_by: session?.requester?.id || null });
  }
  clearSettingsCache();
}

async function handleStatus(sb, event) {
  const checks = {};
  for (const table of [
    'crm_contract_templates',
    'crm_contract_template_versions',
    'crm_contract_requests',
    'crm_contract_signers',
    'crm_contract_events',
    'crm_contract_files',
    'crm_app_settings'
  ]) {
    checks[table] = await tableExists(sb, table);
  }
  const bucket = await bucketExists(sb);
  const settings = await loadSettings(sb);
  const fromEmail = await getFromEmail(sb);
  const fromName = await getFromName(sb);
  const messageStream = await getMessageStream(sb);
  const baseUrl = await resolveBaseUrl(event, sb);
  const webhookSecret = await getWebhookSecret(sb);
  const hasToken = Boolean(await getPostmarkToken(sb));

  let helperInstalled = false;
  try {
    helperInstalled = !(await ensureRunSqlHelper(sb)).missing_helper;
  } catch {
    helperInstalled = false;
  }
  return {
    helper_installed: helperInstalled,
    helper_sql: RUN_SQL_HELPER.trim(),
    tables: checks,
    storage_bucket_ready: bucket,
    settings_ready: checks.crm_app_settings,
    config: {
      contract_from_email: fromEmail,
      contract_from_name: fromName,
      postmark_message_stream: messageStream,
      postmark_token_present: hasToken,
      contract_public_base_url: settings.contract_public_base_url || baseUrl || '',
      webhook_url: baseUrl ? `${baseUrl}/.netlify/functions/partner-contracts-postmark${webhookSecret ? `?secret=${encodeURIComponent(webhookSecret)}` : ''}` : '',
      webhook_secret_present: Boolean(webhookSecret)
    }
  };
}

async function handleRunMigrations(sb, session) {
  const helperState = await ensureRunSqlHelper(sb);
  if (helperState.missing_helper) {
    return { ok: false, missing_helper: true, helper_sql: RUN_SQL_HELPER.trim(), error: helperState.error };
  }
  const steps = [];
  steps.push({ name: 'app_settings_bootstrap', result: await runSqlBlock(sb, APP_SETTINGS_BOOTSTRAP_SQL) });
  try {
    steps.push({ name: 'partner_contracts_v1', result: await runSqlBlock(sb, readMigrationFile('partner_contracts_schema_v1.sql')) });
    steps.push({ name: 'partner_contracts_v2_phase2d', result: await runSqlBlock(sb, readMigrationFile('partner_contracts_schema_v2_phase2d.sql')) });
    steps.push({ name: 'partner_contracts_v3_phase3', result: await runSqlBlock(sb, readMigrationFile('partner_contracts_schema_v3_phase3.sql')) });
    steps.push({ name: 'partner_contracts_v4_phase4', result: await runSqlBlock(sb, readMigrationFile('partner_contracts_schema_v4_phase4.sql')) });
    // v3.6.0: team_label upgrade is now part of the standard migration pipeline
    steps.push({ name: 'team_label_upgrade_v2', result: await runSqlBlock(sb, readMigrationFile('team_label_upgrade_v2.sql')) });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  // v3.6.0: Surface individual step errors with full diagnostic detail so the
  // UI can show exactly which SQL statement broke (statement index, preview, error).
  for (const step of steps) {
    if (step.result && step.result.ok === false) {
      return {
        ok: false,
        steps,
        failed_step: step.name,
        error: step.result.error,
        failing_statement_index: step.result.failing_statement_index,
        failing_statement_preview: step.result.failing_statement_preview,
        failing_statement_error: step.result.failing_statement_error,
        total_statements: step.result.total_statements
      };
    }
  }
  const bucket = await ensureBucket(sb);
  steps.push({ name: 'storage_bucket', result: bucket });
  await ensureDefaultSettings(sb, session);
  return { ok: true, steps, message: 'Partner Contracts is set up. Add your Postmark Server Token below to enable automatic email delivery.' };
}

async function handleSaveSettings(sb, session, body) {
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(body, 'postmark_server_token')) {
    updates.postmark_server_token = cleanText(body.postmark_server_token || '');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'contract_from_email')) {
    const value = cleanEmail(body.contract_from_email || '');
    updates.contract_from_email = value || DEFAULT_FROM_EMAIL;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'contract_from_name')) {
    updates.contract_from_name = cleanText(body.contract_from_name || '');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'contract_public_base_url')) {
    updates.contract_public_base_url = cleanText(body.contract_public_base_url || '');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'postmark_message_stream')) {
    updates.postmark_message_stream = cleanText(body.postmark_message_stream || '') || DEFAULT_MESSAGE_STREAM;
  }
  for (const [key, value] of Object.entries(updates)) {
    await sb.from('crm_app_settings').upsert({ setting_key: key, setting_value: value, updated_by: session?.requester?.id || null, updated_at: new Date().toISOString() }, { onConflict: 'setting_key' });
  }
  clearSettingsCache();
  return { ok: true, saved_keys: Object.keys(updates) };
}

async function handleGenerateWebhookSecret(sb, session) {
  const secret = crypto.randomBytes(24).toString('hex');
  await sb.from('crm_app_settings').upsert({ setting_key: 'postmark_webhook_secret', setting_value: secret, updated_by: session?.requester?.id || null, updated_at: new Date().toISOString() }, { onConflict: 'setting_key' });
  clearSettingsCache();
  return { ok: true, secret };
}

async function handleSendTestEmail(sb, session, body) {
  const fromEmail = await getFromEmail(sb);
  // In Postmark "pending approval" mode, you can only send to addresses on the
  // same domain as the From address. To make the test button always succeed,
  // we default the recipient to the From address itself when no explicit
  // recipient was provided. Admins can still override by passing a recipient.
  let recipient = cleanEmail(body.recipient || '');
  if (!recipient) recipient = fromEmail;
  if (!recipient) return { ok: false, error: 'Recipient email is required.' };
  const result = await sendPostmarkEmail({
    sb,
    to: recipient,
    subject: 'Partner Contracts setup test',
    textBody: `This is a test email from your Partner Contracts setup page. If you can read this, Postmark is working with the sender ${fromEmail}.`,
    htmlBody: `<p>This is a test email from your Partner Contracts setup page.</p><p>If you can read this, Postmark is working with the sender <strong>${fromEmail}</strong>.</p>`
  });
  // If pending-approval restriction triggered, return a friendly hint.
  if (!result.sent && /pending approval/i.test(String(result.error || ''))) {
    return {
      ok: false,
      result,
      pending_approval: true,
      hint: 'Your Postmark account is still pending approval. While pending, you can only send to addresses on the same domain as your From address (' + fromEmail + '). Request approval in Postmark to unlock sending to any address.'
    };
  }
  return { ok: result.sent, result, recipient };
}

async function handleAction(sb, session, body) {
  const action = cleanText(body.action || '');
  if (action === 'run_migrations') return handleRunMigrations(sb, session);
  if (action === 'save_settings') return handleSaveSettings(sb, session, body);
  if (action === 'send_test_email') return handleSendTestEmail(sb, session, body);
  if (action === 'generate_webhook_secret') return handleGenerateWebhookSecret(sb, session);
  return { ok: false, error: `Unsupported action: ${action}` };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, '', corsHeaders());
  try {
    const session = await requireAdminSession(event);
    if (session.roleRow.role !== 'super_admin') {
      return response(403, { error: 'Only super admins can access setup.' }, corsHeaders());
    }
    const sb = getRequiredSupabase();
    if (event.httpMethod === 'GET') {
      const status = await handleStatus(sb, event);
      return response(200, status, corsHeaders());
    }
    if (event.httpMethod === 'POST') {
      const body = await readJsonBody(event);
      const result = await handleAction(sb, session, body);
      return response(200, result, corsHeaders());
    }
    return response(405, { error: 'Method not allowed' }, corsHeaders());
  } catch (error) {
    console.error('[partner-contracts-setup] error:', error);
    return response(error.statusCode || 500, { error: error.message || 'Unexpected setup error.' }, corsHeaders());
  }
};
