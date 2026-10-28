-- Permanent lifecycle receipts. No backfill or posting-function changes.
create table order_lifecycle_commands (
  company_id uuid not null references companies(id) on delete cascade,
  command_id text not null check (length(command_id) between 1 and 200),
  order_id text not null,
  operation text not null check (operation in ('delivered')),
  canonical_payload jsonb not null check (jsonb_typeof(canonical_payload) = 'object'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  response_status integer not null check (response_status = 200),
  response_body jsonb not null check (jsonb_typeof(response_body) = 'object'),
  created_at timestamptz not null default now(),
  primary key (company_id, command_id),
  foreign key (company_id, order_id) references orders(company_id, id),
  unique (company_id, order_id, operation)
);
