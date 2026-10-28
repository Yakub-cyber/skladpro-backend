-- Serialization fence only. No accounting data, backfill or posting changes.
create table customer_financial_fences (
  company_id uuid not null references companies(id) on delete cascade,
  customer_id text not null check (length(customer_id) between 1 and 64),
  revision bigint not null check (revision > 0),
  primary key (company_id, customer_id)
);
-- No customer FK: historical party identities can outlive catalogue rows.
-- This table is not a balance, payment allocation or command receipt.
