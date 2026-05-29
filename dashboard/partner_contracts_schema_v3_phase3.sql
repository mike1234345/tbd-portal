-- =====================================================
-- TBD Marketing Solutions - Partner Contracts Phase 3 upgrade
-- Run AFTER dashboard/partner_contracts_schema_v2_phase2d.sql
-- Adds:
--   - merge_fields jsonb on template versions (field definitions with coordinates)
--   - prefill_values jsonb on contract requests (admin-entered values to merge)
--   - signature_placements jsonb on contract signers (which fields each signer fills)
--   - rendered_pdf_path on contract requests (final PDF with signatures embedded)
--   - default LOR template merge field schema
-- =====================================================

-- 1. Template versions: add merge_fields for coordinate-aware field definitions.
--    Each entry: { id, label, type, page, x, y, width, height, signer_role, required, prefill_source }
--    type: 'text' | 'date' | 'signature' | 'initials' | 'checkbox'
--    prefill_source: optional CRM field key ('client_name', 'client_email', 'client_phone',
--                    'address_full', 'address_street', 'address_city', 'address_state',
--                    'address_zip', 'insurance_carrier', 'policy_number', 'claim_number',
--                    'date_of_loss', 'date_of_commencement', 'today', 'partner_name')
alter table public.crm_contract_template_versions
  add column if not exists merge_fields jsonb not null default '[]'::jsonb;

create index if not exists idx_contract_template_versions_merge_fields
  on public.crm_contract_template_versions using gin (merge_fields);

-- 2. Contract requests: prefill values + rendered PDF
alter table public.crm_contract_requests
  add column if not exists prefill_values jsonb not null default '{}'::jsonb,
  add column if not exists rendered_pdf_path text,
  add column if not exists rendered_pdf_storage_bucket text,
  add column if not exists rendered_pdf_generated_at timestamptz;

-- 3. Contract signers: signature placements (which fields they own + signature image data)
alter table public.crm_contract_signers
  add column if not exists signature_placements jsonb not null default '[]'::jsonb,
  add column if not exists signature_image_data text;  -- base64 PNG of drawn signature

-- 4. Extend file_kind enum on crm_contract_files for the new rendered PDF type
-- v3.5.10: Idempotent file_kind constraint rebuild (only runs if 'rendered_pdf' missing)
do $files_idempotent$
declare
  current_def text;
begin
  select pg_get_constraintdef(c.oid) into current_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'crm_contract_files'
    and c.conname = 'crm_contract_files_file_kind_check'
    and c.contype = 'c'
  limit 1;
  if current_def is not null and current_def like '%rendered_pdf%' then
    raise notice 'crm_contract_files_file_kind_check already canonical; skipping rebuild';
    return;
  end if;
  alter table public.crm_contract_files
    drop constraint if exists crm_contract_files_file_kind_check;
  -- Quarantine any non-canonical file_kind values
  update public.crm_contract_files
  set file_kind = 'attachment'
  where file_kind not in (
    'template_source','template_preview','request_snapshot','rendered_pdf','signed_pdf','audit_pdf','attachment'
  );
  alter table public.crm_contract_files
    add constraint crm_contract_files_file_kind_check
    check (file_kind in (
      'template_source','template_preview','request_snapshot','rendered_pdf','signed_pdf','audit_pdf','attachment'
    ));
  raise notice 'crm_contract_files_file_kind_check rebuilt successfully';
end $files_idempotent$;

-- 5. Extend event_type enum on crm_contract_events for new events
-- v3.5.10: Idempotent - if the constraint already has 'request_cancelled' in its
-- definition, the V3 cleanup has already been applied; skip the destructive work
-- entirely. Otherwise, proceed with the full normalize + quarantine + re-add flow.

do $idempotent$
declare
  current_def text;
begin
  select pg_get_constraintdef(c.oid) into current_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'crm_contract_events'
    and c.conname = 'crm_contract_events_event_type_check'
    and c.contype = 'c'
  limit 1;
  -- If the constraint exists AND already includes 'request_cancelled' AND
  -- 'rendered_pdf_generated' AND 'audit_pdf_generated', it's the v3.5+ canonical
  -- version and we don't need to touch it.
  if current_def is not null
     and current_def like '%request_cancelled%'
     and current_def like '%rendered_pdf_generated%'
     and current_def like '%audit_pdf_generated%' then
    raise notice 'crm_contract_events_event_type_check already canonical; skipping rebuild';
    return;
  end if;

  -- Otherwise, run the full cleanup + rebuild sequence inside this DO block
  -- so it's all one atomic transaction.
  alter table public.crm_contract_events
    drop constraint if exists crm_contract_events_event_type_check;

  update public.crm_contract_events
  set event_type = lower(btrim(event_type))
  where event_type is not null
    and event_type <> lower(btrim(event_type));

  update public.crm_contract_events
  set event_data = coalesce(event_data, '{}'::jsonb) || jsonb_build_object('_legacy_event_type', coalesce(event_type, '__NULL__')),
      event_type = 'request_updated'
  where event_type is null or btrim(event_type) = '';

  update public.crm_contract_events
  set event_data = coalesce(event_data, '{}'::jsonb) || jsonb_build_object('_legacy_event_type', event_type),
      event_type = 'request_updated'
  where event_type not in (
    'template_created','template_updated','template_version_created','template_fields_mapped',
    'request_created','request_updated','request_prefilled','request_sent','request_resent',
    'request_cancelled','request_voided','request_expired','request_completed','request_archived',
    'email_queued','email_sent','email_failed','email_delivered','email_opened','email_bounced',
    'email_spam_complaint','email_link_clicked','signer_viewed','signer_signed','signer_declined',
    'signer_bounced','in_person_session_started','file_attached','rendered_pdf_generated',
    'signed_pdf_generated','audit_pdf_generated'
  );

  alter table public.crm_contract_events
    add constraint crm_contract_events_event_type_check
    check (event_type in (
      'template_created','template_updated','template_version_created','template_fields_mapped',
      'request_created','request_updated','request_prefilled','request_sent','request_resent',
      'request_cancelled','request_voided','request_expired','request_completed','request_archived',
      'email_queued','email_sent','email_failed','email_delivered','email_opened','email_bounced',
      'email_spam_complaint','email_link_clicked','signer_viewed','signer_signed','signer_declined',
      'signer_bounced','in_person_session_started','file_attached','rendered_pdf_generated',
      'signed_pdf_generated','audit_pdf_generated'
    ));

  raise notice 'crm_contract_events_event_type_check rebuilt successfully';
end $idempotent$;

-- The original (non-idempotent) DROP/UPDATE/ADD sequence is replaced by the DO block above.
-- Keeping this empty stub for backwards safety:
alter table public.crm_contract_events
  drop constraint if exists crm_contract_events_event_type_check__OBSOLETE_NEVER_EXISTS;


