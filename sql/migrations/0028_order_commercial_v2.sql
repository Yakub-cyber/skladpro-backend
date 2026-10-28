-- No backfill, posting changes or ledger writes.
alter table orders add column commercial_snapshot jsonb;
alter table orders add constraint orders_commercial_snapshot_object
  check (commercial_snapshot is null or jsonb_typeof(commercial_snapshot) = 'object');

create table order_commercial_commands (
  company_id uuid not null references companies(id) on delete cascade,
  command_id text not null,
  order_id text not null,
  operation text not null check (operation in ('create','replace')),
  canonical_payload jsonb not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  response_status integer not null check (response_status in (200,201)),
  response_body jsonb not null,
  resulting_row_version bigint not null,
  created_at timestamptz not null default now(),
  primary key (company_id, command_id),
  foreign key (company_id, order_id) references orders(company_id,id)
);
create index order_commercial_commands_order on order_commercial_commands(company_id,order_id);
