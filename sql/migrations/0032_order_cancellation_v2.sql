-- Add cancellation receipts only. No backfill or posting-function changes.
alter table order_lifecycle_commands drop constraint order_lifecycle_commands_operation_check;
alter table order_lifecycle_commands add constraint order_lifecycle_commands_operation_check
  check (operation in ('delivered','cancelled'));
