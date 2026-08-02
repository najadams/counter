-- 0050_management_seed_outbox_hygiene.sql
-- Migration 0048 adds two fixed system accounts after the ledger-account
-- outbox trigger already exists. Those bootstrap rows are part of the stable
-- chart of accounts, not shop-authored activity, so they must not leave a
-- fresh or upgraded install reporting a phantom sync backlog.

DELETE FROM sync_outbox
 WHERE acked_at IS NULL
   AND table_name = 'ledger_accounts'
   AND op = 'INSERT'
   AND row_pk IN (
     SELECT id
       FROM ledger_accounts
      WHERE created_by = 'sys-system'
        AND device_id = 'migration-0048'
        AND code IN ('GAIN_ASSET_DISPOSAL', 'LOSS_ASSET_DISPOSAL')
   );
