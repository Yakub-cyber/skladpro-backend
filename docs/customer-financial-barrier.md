# Customer financial concurrency barrier

This stage prepares financial serialization only. It does not implement cancellation
v2, reversal receipts, payment allocation, or new stock-reconcile resolutions.

## Writer inventory and coverage

| Supported backend path | Financial effect | Barrier location |
| --- | --- | --- |
| `POST /v1/customers/:id/payments`, payment | `payment_in`, cash receipt and customer debt reduction | After temporary replay, before reading balance or creating a document |
| Same endpoint, adjustment/increase/decrease | Signed `opening_settlement` | Same barrier |
| `POST /v1/sales`, legacy and v2 | Customer shipment debt; paired payment for paid named-customer sales | After existing order locks/replay, before product/document accounting |
| Legacy `POST /v1/orders/:id/status`, shipped | Shipment debt and optional paired payment | After order lock, before accounting |
| Same endpoint, cancelled | `unpost_doc` removes source stock/debt and applicable money movements | Order lock, discover actual source-document customer parties without document locks, then acquire the complete customer set |
| Shipment v2 | Unpaid customer credit shipment debt | Order lock and commercial verification, then barrier before warehouse/document accounting locks |
| `POST /v1/returns`, v1 | Customer debt reduction (walk-in cash return has no customer party) | Order lock, then barrier before product-code writes/document accounting |
| Return v2 | Customer debt reduction or return plus linked customer payout | Order lock, then barrier before source-document locks and financial decisions |

`salesV2.ts` contains identity/proof helpers; actual posting is in `routes/sales.ts`
and is covered there. One barrier covers all postings of a transaction, including
paired payment documents. No supported standalone HTTP endpoint for editing,
unposting or deleting an individual customer payment was found.

Excluded paths:

- Commercial create/edit and delivered v2 do not write financial facts.
- `sync/push` excludes customer balance and ledger tables. Ordinary metadata
  operations commit separately; protected order operations have their existing
  order transaction. Sync is not assigned a financial barrier.
- Generic document posting accepts receive/writeoff/adjust/transfer only. Its
  purchase receipt party is a supplier, not a customer.
- Walk-in retail money without a customer party is not a customer-debt writer.
  The walk-in `retail` sentinel is filtered by relevant sale/return callers, not
  by the shared helper: an actual customer payment ID `retail` remains protected.
- Read-only stock reconcile/proof/health paths do not post anything.
- Tenant deletion, manual maintenance and direct administrative SQL are outside
  this supported financial-writer protocol. SQL functions themselves do not take
  the new advisory barrier. External writers need a separately agreed protocol;
  no database-wide guarantee against arbitrary SQL is claimed.

## Locks and snapshots

`lockCustomerFinances(client, companyId, completeCustomerIds)` must run inside the
existing transaction, once with the complete party set, before accounting locks,
financial decisions and mutations. Do not discover and add more parties after
starting accounting. Existing order locks precede this helper.

The helper hashes the JSON company/customer pair with SHA-256 to a signed 32-bit
key. The first two-int advisory component is fixed `0x53465031` (`SFP1`). This
two-int PostgreSQL lock space is distinct from existing one-bigint advisory locks.
Deduplicated numeric keys are acquired in ascending order; all advisory keys are
acquired before fence rows, whose customer IDs are also sorted. Hash collisions
can add serialization for unrelated identities, but cannot bypass protection;
sorting the actual keys avoids collision-induced lock-order inversions.

Order-related paths retain their original command/commercial advisory and temporary
idempotency locks, followed by the existing order tuple lock. Then comes this
financial barrier and fence, followed by document/product/stock/customer accounting
locks. Customer payments have no order lock and never wait for one while holding
the financial barrier. Existing replay shortcuts do not write a new fence.

Advisory locking alone does not refresh an already established SERIALIZABLE/RR
snapshot. Migration **0031_customer_financial_fences.sql** adds an internal table
with company/customer primary key and an incremented bigint revision. The helper
upserts its row after acquiring all advisory keys. An obsolete snapshot therefore
fails with `40001`, including when the conflicting fence row was first created
after that snapshot. Existing shipment/return v2 whole-transaction retries obtain
a fresh snapshot before making financial decisions.

The internal fence avoids early locks or metadata changes to the public customer
row and supports historical party IDs whose catalogue row is missing. Its only FK
is company/cascade. It has no balance, payment or command-receipt semantics, is not
in sync/pull, has no backfill or automatic cleanup, and rolls back with the entire
financial transaction. Do not reset/delete live fence rows independently of the
protocol. No `post_doc`/`unpost_doc` definitions or existing table definitions change.

## Compatibility and next stage

All existing amounts, payment rules, rounding, legacy cancellation behavior,
idempotency keys and HTTP contracts remain unchanged. In particular, the financial
barrier does **not** itself prohibit legacy cancellation after a payment. Future
cancelled v2 must hold it across its absence-of-payments check, unpost and receipt
commit, and must explicitly reject unsupported/unallocated payment evidence.

Document-number counters and other existing shared accounting resources can still
serialize different customers. Independence tests pause before acquiring those
resources to check the financial barrier itself rather than promise full endpoint
parallelism. Existing arbitrary metadata/order lock cycles and administrative lock
orders are not repaired by this stage.

Since 0031 is now the financial-fence migration, a later lifecycle CHECK extension
for cancelled v2 needs the next available migration number, not a rewrite of 0031.

## PostgreSQL verification

`test/integration/customer-finance.test.ts` tests actual HTTP/SQL transactions:
payment/payment; payment versus shipment, credit return and legacy cancellation
in both orders; adjustments; independent customers and companies; multi-party key
ordering; namespace separation; stale RR/SERIALIZABLE failures and fresh retry;
rollback after real posting; a dropped HTTP response and unchanged replay; writer
lock order; metadata independence; and unchanged SQL function bodies.

Contended scenarios wait for real PostgreSQL advisory lock waits. Each test checks
the isolated database deadlock counter and remaining blocked/idle transactions.
The earlier 0030 migration test now checks that migration's schema invariance before
running subsequent migrations, and derives the final runner count from the files.
