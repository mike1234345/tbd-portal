# Archived SQL Migrations

These SQL files were applied to the live Supabase database at some point in the
past and are kept here as historical reference only. They are **not** referenced
by any active code and do NOT need to be run again.

If you ever rebuild the database from scratch, run them in this order:

1. `supabase_schema_v2.sql` (parent: dashboard/) — base schema
2. `admin_role_setup.sql` (parent: dashboard/) — `crm_user_roles` table
3. `signed_clients_schema_v15.sql` (parent: dashboard/) — partner profiles + signed clients
4. `messages_schema.sql` + `messages_v3_upgrade.sql` (here) — team messaging
5. `dialer_schema_v18_combined.sql` (here) — Quo dialer tables (v16 + v17 superseded)
6. `quo_schema_full.sql` (here) — Quo provider integration
7. `agent_number_assignments_schema.sql` (here) — phone number assignments
8. `training_progress_schema.sql` (here) — agent training tracker
9. `signed_clients_add_advance_transaction_type.sql` (here) — column upgrade
10. DocuMike migrations (parent: dashboard/) — partner_contracts_schema_v1 through v4
11. `team_label_upgrade_v2.sql` (parent: dashboard/) — `team_label` column for Manage Agents

## Why archived?

- `v16/v17` dialer files were earlier iterations; v18 combined them.
- Messages, Quo, training, and assignments were one-off setup scripts.
- All migrations here are idempotent (`if not exists`) — safe to re-run if needed,
  but normally already done in production.

The DocuMike `_v3` and `_v4` files in the parent directory are the ones still
inlined into `netlify/functions/partner-contracts-setup.js` and run by
DocuMike Settings → Run Setup Now.
