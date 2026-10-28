# Delivered v2 — protected commercial orders

Backend only. Requires migration 0029 after 0028. No historical backfill, frontend integration,
posting-function change, cancellation-v2 contract or new financial semantics.

## Contract and permanent identity

`POST /v1/orders/:orderId/status`, authenticated company context.
`Idempotency-Key: delivered:<shipmentId>`.

```json
{
  "contractVersion": 2,
  "status": "delivered",
  "shipmentId": "00000000-0000-4000-8000-000000000001",
  "shipmentFingerprint": "<64 lowercase hexadecimal characters from the original shipment>"
}
```

Strict fields; lowercase UUID. Company and actor come exclusively from authorization. A courier
can deliver/replay only an order currently assigned to their user ID or membership name, preserving
the existing assignment policy. Other authenticated company roles retain existing status permissions.
Historical orders cannot be adopted; protected legacy `{status:"delivered"}` returns 409 even if
an old temporary response exists. Historical legacy deliveries retain their old path.

Permanent command ID is `delivered:<shipmentId>`. Canonical JSON is
`{companyId,orderId,contractVersion,status,shipmentId,shipmentFingerprint}`; SHA-256 reuses the
existing recursive canonicalizer. Temporary idempotency records are neither read nor written.

`order_lifecycle_commands` stores company, command ID, order, operation, canonical payload,
fingerprint, original HTTP status/body and created_at. Its primary key is (company_id,command_id);
one delivered operation per company/order is additionally enforced. Composite order FK preserves
tenant linkage; company FK follows existing explicit tenant-purge cascade behavior. Receipts have
no TTL. The unique order/operation index also supports the order lookup/FK access path.

HTTP 200 result contains `ok`, `contractVersion`, `commandId`, `shipmentId`, `documentId`, delivery
`fingerprint`, `deliveredAt`, and `order:{id,status:"delivered",rowVersion}`. It is saved in the same
transaction as the workflow update/audit. Identical replay returns its initial status/body and
`Idempotency-Replayed:true` before examining current status or revalidating current posting/catalog.
An old response is historical, not authority to restore an old status; clients must refetch current
order state. Same command with changed content/order returns 409 DELIVERY_IDENTITY_CONFLICT.

## Validation and allowed writes

A new operation requires non-deleted protected order in shipped, stock_consumed=true and exact
shipment_doc_id. Existing shipment proof parsing validates the original canonical request, company,
order, shipment ID, fingerprint, commercial snapshot, warehouse/customer/document, source line
mapping, quantities/units/amounts and each negative stock movement. Extra source sale documents,
missing/modified lines or movements and a damaged proof fail closed. The original proof is not
rewritten. It retains the existing 256 KiB proof limit.

Balances for every warehouse of the affected products are compared with the stock ledger in one
SQL statement snapshot. Ordinary concurrent receipts/inventories are allowed; today's balance is
not compared with just the original shipment quantity. Reconciliation of the original shipment
continues to return applied when its proof and ledger remain consistent, including after a return.

Allowed writes are orders.status/track, trigger-maintained row_version/updated_at, one permanent
lifecycle receipt and audit. No post_doc/unpost_doc, source_payload mutation, item replacement,
shipment marker/stock flag change, stock/money/settlement movement or local payment fact is made.

## Locks and cancellation

One connection, READ COMMITTED transaction:

1. Transaction advisory lock ['order-lifecycle-command',companyId,commandId].
2. Shared commercial-order advisory namespace ['order-commercial',companyId,orderId].
3. Permanent receipt lookup; order FOR UPDATE and authorization before replay.
4. For a new delivery only, linked source documents FOR SHARE, then native line/movement reads.
5. Workflow update, receipt and audit, commit.

There is no temporary-key wait under an order lock. Legacy cancellation and returns take their
temporary key before the order tuple; delivery never waits for that key. SQL 0027 posting/unposting
also uses the order tuple fence before document locks. Current committed order state is rechecked
after waiting. No new product/customer/account write locks are acquired by delivery.

Cancel-first makes delivery fail with status conflict. Delivery-first makes HTTP cancellation fail
with DELIVERED_ORDER_CANCELLATION_FORBIDDEN. The permanent delivered receipt prevents bypass by
changing the textual status later. Existing SALE_HAS_POSTED_RETURNS has priority and remains intact.
Cancellation while still shipped is unchanged and is not cancellation v2. After delivered use returns.

The cancellation ban is enforced in the backend HTTP path. Direct administrative SQL unpost_doc
without returns is still permitted by existing SQL definitions; database-level delivery cancellation
prohibition would require separately approved SQL protection. SQL 0027 still forbids cancellation
after posted v1/v2 returns. No direct SQL protection is claimed beyond those existing guarantees.

## Errors / deployment

- 422 DELIVERY_INVALID: malformed/extra fields, invalid UUID/fingerprint syntax.
- 409 DELIVERY_IDENTITY_CONFLICT: wrong key or changed command/shipment fingerprint.
- 409 DELIVERY_REQUIRES_COMMERCIAL_V2: historical unprotected order.
- 409 DELIVERY_STATUS_CONFLICT: new command outside shipped/deleted order.
- 409 DELIVERY_SHIPMENT_UNVERIFIED: marker, proof, posting, ledger or balances not proven.
- 409 DELIVERY_PROOF_INVALID: inconsistent permanent lifecycle response.
- 409 COMMERCIAL_ORDER_REQUIRES_DELIVERY_V2: protected legacy delivery.
- 409 DELIVERED_ORDER_CANCELLATION_FORBIDDEN: delivered protected HTTP cancellation without a
  higher-priority posted-return conflict.
- 403 unauthorized company/courier; 404 missing accessible order.

Apply 0029 before deploying this backend. Migration runner reruns are no-ops; no raw repeat CREATE
or historical repair is performed. Downgrading to an older backend removes the new HTTP lifecycle
guards and is unsafe without retaining them. Existing protected orders already delivered by legacy
clients receive no manufactured receipt; returns remain available under existing returns-v2 rules.

## Tests

Real isolated PostgreSQL covers original/replayed delivery, temporary cleanup, later status changes,
identity/scope/authorization failures, damaged native proof, line/movement/balance mismatch, lost
HTTP response after commit, rollback at receipt/audit writes, legacy gate, both delivery/cancel orders,
both delivery/return orders and concurrent identical commands. Commit/read gates verify actual lock
waits; completed races check no idle-in-transaction sessions remain. Regression tests now use delivery
v2 for protected shipments and assert the approved prohibition on cancellation after delivery.

Final validation: typecheck passed; full backend suite 477/477 (33 files), including 21 new
delivered-v2 cases, passed on isolated PostgreSQL. The fresh test database contains 29 applied
migrations. Separate 0028 -> 0029 upgrade and repeated runner execution passed, preserving the
historical fixture and exact post_doc/unpost_doc definitions. PostgreSQL reported zero deadlocks
and zero idle-in-transaction sessions after the suite. git diff --check and new-file whitespace
checks passed. No production database, frontend, Git staging, commit or push was involved.
