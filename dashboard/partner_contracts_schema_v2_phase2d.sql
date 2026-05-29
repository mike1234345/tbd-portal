-- =====================================================
-- TBD Marketing Solutions - Partner Contracts Phase 2D upgrade
-- Run AFTER dashboard/partner_contracts_schema_v1.sql
-- Adds:
--   - Supabase Storage bucket for partner contract files (partner-contracts)
--   - Storage policies scoped to authenticated admins / super-admins
--   - Postmark webhook lifecycle events (delivered, opened, bounce, complaint)
--   - Audit PDF / signed PDF columns are already present in V1; this script
--     simply extends the allowed event_type list and adds helpful indexes.
-- =====================================================

-- 1. Storage bucket. The partner-contracts bucket stores:
--    * Template source files (uploaded by admins)
--    * Generated signed PDFs and audit PDFs (created by the Netlify function)
insert into storage.buckets (id, name, public)
values ('partner-contracts', 'partner-contracts', false)
on conflict (id) do nothing;

-- 2. Storage policies. Only admins/super-admins can read or write the bucket.
--    The service-role key bypasses RLS so server-side uploads continue to work.
drop policy if exists "partner_contracts_storage_read" on storage.objects;
create policy "partner_contracts_storage_read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'partner-contracts'
  and public.crm_is_admin(auth.uid())
);

drop policy if exists "partner_contracts_storage_write" on storage.objects;
create policy "partner_contracts_storage_write"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'partner-contracts'
  and public.crm_is_admin(auth.uid())
);

drop policy if exists "partner_contracts_storage_update" on storage.objects;
create policy "partner_contracts_storage_update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'partner-contracts'
  and public.crm_is_admin(auth.uid())
)
with check (
  bucket_id = 'partner-contracts'
  and public.crm_is_admin(auth.uid())
);

drop policy if exists "partner_contracts_storage_delete" on storage.objects;
create policy "partner_contracts_storage_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'partner-contracts'
  and public.crm_is_admin(auth.uid())
);

-- 3. Allow Postmark webhook lifecycle events in crm_contract_events.
-- v3.6.1: Idempotent rebuild. If the constraint already includes the broader
-- event types added in later migrations (request_cancelled, template_fields_mapped,
-- rendered_pdf_generated, request_prefilled), V3 or later has already widened it
-- and we should NOT downgrade the constraint here. Otherwise, do the V2 rebuild.
do $v2_events_idempotent$
declare
  current_def text;
  is_broader boolean := false;
begin
  select pg_get_constraintdef(c.oid) into current_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'crm_contract_events'
    and c.conname = 'crm_contract_events_event_type_check'
    and c.contype = 'c'
  limit 1;

  -- If the constraint already has the V3+ values, skip — don't downgrade.
  if current_def is not null
     and (current_def like '%request_cancelled%'
          or current_def like '%template_fields_mapped%'
          or current_def like '%rendered_pdf_generated%'
          or current_def like '%request_prefilled%') then
    raise notice 'crm_contract_events_event_type_check already broader than V2; skipping rebuild';
    return;
  end if;

  -- Otherwise, quarantine any rows whose event_type isn't in V2's list, then rebuild
  alter table public.crm_contract_events
    drop constraint if exists crm_contract_events_event_type_check;

  update public.crm_contract_events
  set event_data = coalesce(event_data, '{}'::jsonb)
                || jsonb_build_object('_legacy_event_type', coalesce(event_type, '__NULL__')),
      event_type = 'request_updated'
  where event_type is null
     or btrim(event_type) = ''
     or event_type not in (
       'template_created','template_updated','template_version_created',
       'request_created','request_updated','request_sent','request_resent',
       'request_voided','request_expired','request_completed','request_archived',
       'email_queued','email_sent','email_failed','email_delivered','email_opened',
       'email_bounced','email_spam_complaint','email_link_clicked',
       'signer_viewed','signer_signed','signer_declined','signer_bounced',
       'in_person_session_started','file_attached','signed_pdf_generated','audit_pdf_generated'
     );

  alter table public.crm_contract_events
    add constraint crm_contract_events_event_type_check
    check (event_type in (
      'template_created','template_updated','template_version_created',
      'request_created','request_updated','request_sent','request_resent',
      'request_voided','request_expired','request_completed','request_archived',
      'email_queued','email_sent','email_failed','email_delivered','email_opened',
      'email_bounced','email_spam_complaint','email_link_clicked',
      'signer_viewed','signer_signed','signer_declined','signer_bounced',
      'in_person_session_started','file_attached','signed_pdf_generated','audit_pdf_generated'
    ));

  raise notice 'crm_contract_events_event_type_check rebuilt with V2 list';
end $v2_events_idempotent$;

-- 4. Helpful indexes for the new event categories
create index if not exists idx_contract_events_signer
  on public.crm_contract_events(signer_id, created_at desc);
create index if not exists idx_contract_events_event_type
  on public.crm_contract_events(event_type, created_at desc);

-- 5. Add convenience columns for storage object metadata on the request itself.
alter table public.crm_contract_requests
  add column if not exists signed_pdf_storage_bucket text,
  add column if not exists audit_pdf_storage_bucket text,
  add column if not exists signed_pdf_generated_at timestamptz,
  add column if not exists audit_pdf_generated_at timestamptz;
