-- Add 'advance' as an allowed transaction type for partner transactions
alter table if exists public.crm_partner_transactions
  drop constraint if exists crm_partner_transactions_transaction_type_check;

alter table if exists public.crm_partner_transactions
  add constraint crm_partner_transactions_transaction_type_check
  check (transaction_type in (
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
  ));
