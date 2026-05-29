-- =====================================================
-- TBD Marketing Solutions — DocuMike Phase 4 (v3.5.0)
-- Run AFTER:
--   dashboard/partner_contracts_schema_v1.sql
--   dashboard/partner_contracts_schema_v2_phase2d.sql
--   dashboard/partner_contracts_schema_v3_phase3.sql
-- Adds:
--   - contact_email / contact_phone on crm_partner_profiles (for partner-as-signer email)
--   - cancelled_at / cancel_reason on crm_contract_requests (for Cancel Request feature)
--   - allows status='cancelled' on requests (alongside existing draft/sent/viewed/etc)
-- =====================================================

alter table public.crm_partner_profiles
  add column if not exists contact_email text,
  add column if not exists contact_phone text;

comment on column public.crm_partner_profiles.contact_email is
  'Partner contact email used by DocuMike to send their copy of the signed contract.';
comment on column public.crm_partner_profiles.contact_phone is
  'Partner contact phone number (optional, used for signing notifications).';

-- Cancel/Delete request support (v3.3.0 used best-effort fallback; this makes it first-class)
alter table public.crm_contract_requests
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text;

-- Widen status check to include 'cancelled'
do $$
begin
  -- Drop existing check constraint if its name is predictable; otherwise let admins
  -- re-apply this migration after manually dropping the old constraint name.
  if exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'crm_contract_requests'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%status%'
      and pg_get_constraintdef(c.oid) not like '%cancelled%'
  ) then
    -- Try common constraint names from V1
    begin
      alter table public.crm_contract_requests
        drop constraint if exists crm_contract_requests_status_check;
    exception when others then
      null;
    end;
    -- Add the broader constraint
    begin
      alter table public.crm_contract_requests
        add constraint crm_contract_requests_status_check
        check (status in ('draft', 'sent', 'viewed', 'partially_signed', 'signed', 'declined', 'voided', 'expired', 'cancelled'));
    exception when duplicate_object then
      null;
    end;
  end if;
end $$;

-- Helpful index for sequential-signer email lookups
create index if not exists idx_contract_signers_request_status
  on public.crm_contract_signers (request_id, status, routing_order);
