# Cancelled v2 — protected unpaid shipment

Backend only. Requires migration **0032_order_cancellation_v2.sql** after financial
fence migration 0031. No frontend cancellation, posting-function replacement,
payment allocation or historical backfill is included. The separate read-only
reversal proof reader is documented in stock-reconcile.md.
This contract supersedes earlier descriptions of legacy protected cancellation.

## Request and permanent identity

`POST /v1/orders/:orderId/status`, authenticated company context, non-courier.
`Idempotency-Key: cancelled:<shipmentId>`.

```json
{
  "contractVersion": 2,
  "status": "cancelled",
  "shipmentId": "00000000-0000-4000-8000-000000000001",
  "shipmentFingerprint": "<64 lowercase hex characters of the original shipment>"
}
```

Strict fields, lowercase shipment UUID. There is no new warehouse, quantity,
amount, payment account or cancellation UUID supplied by the client. Canonical
identity is `{companyId,orderId,...body}`, hashed by the existing recursively
sorted-object SHA-256 canonicalizer. The company comes only from authorization.

Permanent receipt lookup precedes current order/status checks. A valid identical
receipt returns its original HTTP 200/body with `Idempotency-Replayed:true`, even
after temporary-key deletion or a later textual status change. It never unposts,
updates the order, or writes a financial fence again. This historical response is
not today's order state: clients must refetch current state. Changed content or
order under the same identity returns 409 `CANCELLATION_IDENTITY_CONFLICT`.
Corrupt canonical payload, response or evidence returns `CANCELLATION_PROOF_INVALID`.
Temporary idempotency records are not used by this contract.

## Supported financial subset

A new cancellation requires a non-deleted protected commercial order **shipped**,
stock_consumed=true, its exact shipment_doc_id, exactly one source shipment and
a fully verified posted shipment-v2 proof. Source company, order, shipment ID,
fingerprint, warehouse, commercial snapshot, document, stable source-line mapping,
quantities, units, prices, amount, stock output and costs must agree.

Only unpaid credit to a real customer is supported: onCredit=true, payment.method
credit, zero cash/card/change, zero discount, creditTerms=null and vatSummary=null.
The original single settlement must equal the source amount and declared debt.
The original document must have no money movements. No new money movement or
payment-out document is created. The existing unpost algorithm restores the actual
source output cost and removes exactly the original debt, not all customer debt.

After acquiring the financial barrier and write fence, reject:

- linked payment/prepayment documents, including the historical pay-<orderId>;
- posted or still effective customer payment-in/payment-out/opening-settlement
  documents, even when there is no order allocation or the document is soft-deleted;
- money evidence attached to linked/customer documents;
- negative other-customer-settlement evidence for this customer, or other settlement
  rows whose source/type/posted customer linkage cannot be established.

This is deliberately conservative: an unrelated customer payment/adjustment can
require reconciliation because no allocation is invented. Valid positive debt from
another shipment remains in place. Existing customer mirror/ledger or affected
stock quantity/cost drift also prevents cancellation; it is not repaired silently.

Posted v1/v2 returns or remaining return movements have priority and preserve
`P0010` / `SALE_HAS_POSTED_RETURNS`. Delivery status **or a permanent delivered
receipt** forbids cancellation, including after a later textual status change.
A draft/void source without a cancellation receipt requires reconciliation; no
receipt is manufactured retroactively. A plain cancelled status is never evidence.

## Atomic cancellation and evidence

Within one transaction:

1. Verify the posted source and capture a canonical version-1 manifest containing
   company/order/shipment identities, the original document and unchanged raw
   source_payload, native lines, stock movements and the original settlement.
   Decimal quantities, amounts and cost values are strings; row identity is never
   inferred from array position. Manifest arrays are sorted by native ID.
2. Check source proof/manifest consistency and current balances versus registry
   quantities and costs across **all warehouses** of the affected products.
3. Under the financial barrier, reject unsupported payment/adjustment evidence and
   record current customer debt from the verified settlement ledger/mirror.
4. Call existing `unpost_doc(companyId,documentId)` once for the new attempt.
5. Require draft/null posted_at, no source stock/money/settlement movements, exact
   unchanged source_payload/lines, stock balance/ledger agreement and removal of
   exactly the original debt. Then update **only that document** to void and verify
   the returned status. Unrelated draft documents are not voided.
6. Set order cancelled/stock_consumed=false, append track, retain commercial data,
   source lines and shipment_doc_id, and save the receipt and audit atomically.

HTTP 200 contains command/fingerprint, shipment/fingerprint, documentId/warehouseId,
documentStatus=void, actual source amount, restoredItems (source/document line IDs,
product, warehouse, qtyBase, costAmount), debtRemovedMinor, cashRefundedMinor="0",
cancelledAt and order `{id,status:"cancelled",rowVersion}`.

The response also carries `evidence` with version, complete captured manifest,
manifestHash, raw sourcePayloadHash, sourceLinesHash, exact removed movement IDs,
remainingSourceMovements=0 and documentStatus=void. It is saved in
order_lifecycle_commands with operation=cancelled, canonical request, command
fingerprint and original status/body. Existing company/command uniqueness and
company/order/operation uniqueness remain. No receipt TTL or cleanup is added.

All SQL writes roll back on any failure. Unpost does not add compensating stock
rows: it removes the source rows using the existing SQL semantics. Historical
unpost counters/row-version sequence gaps are not accounting facts.

Current stock need not equal a historical pre-shipment snapshot: intervening valid
sales/inventories/receipts remain applied. The manifest records only this shipment's
restored effect; one-statement registry/balance checks include other warehouses.

## Locks, concurrency and retries

New requests use one connection, READ COMMITTED:

1. Lifecycle-command advisory lock, then existing commercial-order advisory lock.
2. Permanent receipt lookup and integrity/replay decision.
3. Order FOR UPDATE; return/delivery/status/link checks and unlocked discovery of
   the complete possible customer-party set.
4. Existing customer-finance advisory keys and financial write fence (0031).
5. Source documents FOR UPDATE, accounting verification, then unpost and writes.

There is no temporary-key wait under these locks. Customer payments do not take
order locks. Return and direct SQL posting/unposting acquire the source order
before document/accounting locks. Existing SQL write fences are untouched.

Payment/adjustment first: cancellation waits, then rejects the now-visible evidence.
Cancellation first: its receipt commits first; a later generic customer payment or
adjustment remains a separate supported operation, potentially an advance. No claim
is made that generic payments are allocated to the now-cancelled order.

Cancellation/delivery share the order advisory and tuple serialization. Return v2
before delivery is unsupported; return v1 can post first and block cancellation via
P0010. A return after cancellation fails without a new effect. Direct SQL unpost
first leaves no new cancellation receipt and causes reconciliation failure; cancel
first leaves void and the subsequent direct unpost fails with P0008.

40001/40P01 before unpost starts can retry the whole transaction at most three
attempts. **After unpost has begun there is no automatic second unpost in that HTTP
request**: rollback and 409 CANCELLATION_RETRY_REQUIRED instruct an unchanged client
retry. Tests force higher isolation and actual PostgreSQL serialization failures;
the HTTP contract exposes no isolation switch.

## Migration and legacy boundary

0032 changes only the lifecycle operation CHECK to allow delivered/cancelled. It
does not add columns, change 0031, replace SQL functions, modify receipts, or backfill.

Protected legacy cancellation is rejected before temporary replay and again under
the order lock with COMMERCIAL_ORDER_REQUIRES_CANCELLATION_V2. Commercial command
history preserves this gate even if commercial_snapshot is damaged to NULL.
Historical legacy orders retain their old cancellation path. Protected cancellation
before the first shipment is outside this contract and remains unavailable.
Old commands/documents are not rewritten or adopted.

## Errors and boundaries

- 422 CANCELLATION_INVALID: malformed request.
- 409 CANCELLATION_IDENTITY_CONFLICT: key/order/payload identity mismatch.
- 409 CANCELLATION_PROOF_INVALID: damaged permanent cancellation receipt.
- 409 CANCELLATION_REQUIRES_COMMERCIAL_V2 / CANCELLATION_STATUS_CONFLICT.
- 409 CANCELLATION_RECONCILIATION_REQUIRED: ambiguous/missing source, inconsistent
  manifest, prior unpost without receipt, drift or failed restoration checks.
- 422 CANCELLATION_FINANCIAL_RECONCILIATION_REQUIRED: unsupported or ambiguous money.
- 409 DELIVERED_ORDER_CANCELLATION_FORBIDDEN and existing SALE_HAS_POSTED_RETURNS.
- 409 CANCELLATION_RETRY_REQUIRED: retry unchanged after rollback.

Stock/reconcile now returns **reversed** only after verifying the permanent
cancellation receipt and current native state; missing/corrupt evidence remains
**unverifiable**. See stock-reconcile.md for the separate read-only proof rules. No
frontend durable cancellation or optimistic financial/stock adjustment is included.
The existing 256 KiB shipment-proof limit remains. Arbitrary privileged SQL, old
backend writers without the financial barrier, and manually forged/deleted evidence
are outside the supported writer protocol. No automatic historical repair is made.

PostgreSQL tests cover ledger results, immutable source data, historical replay,
real lost HTTP response, identity/corruption conflicts, rollback at real SQL stages,
both race orderings, stale RC/RR/SERIALIZABLE decisions, 40001, unchanged functions,
legacy compatibility, fresh migration chain and 0031-to-0032 upgrade/re-run.
