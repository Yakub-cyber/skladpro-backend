# Sales v3 — exact cash and unpaid credit (backend-only stage)

POST /v1/sales, existing authentication/company context and sale RBAC.
Header: `Idempotency-Key: sale-v3:<order.id>`.
Unknown contractVersion values return 422 and cannot enter legacy parsing.
Version 1 (or omitted version) and version 2 remain available in this stage.

## Strict request

```json
{
  "contractVersion": 3,
  "order": {
    "id": "8e5f7617-16b6-4637-b0f4-26fce2ca577e",
    "warehouseId": "w1",
    "customerId": null,
    "items": [{
      "lineId": "378dcbda-e115-43da-ab09-cdb59ab73603",
      "productId": "p1",
      "qtyBase": "2.0000",
      "unitPriceMinor": 10000
    }],
    "discountMinor": 0,
    "saleTotalMinor": 20000,
    "payment": {
      "paymentMode": "cash",
      "moneyAccountId": "cash",
      "cashTendered": 50000,
      "change": 30000
    }
  }
}
```

All displayed request fields are required. Optional order fields: no,
customerName, priceTypeId, shiftId. No defaults or client track. Unknown fields
at every level are rejected. order.id is 1–64 ASCII `[A-Za-z0-9_:.-]` characters;
lineId is a UUID, unique within the request; other IDs retain existing 1–64 limits.
Items: 1–500. qtyBase is a positive canonical decimal string with exactly four
fractional digits, <= 1000000.0000. Prices are per BASE unit, never per package.
Packaging/unitFactor/unitId fields are not supported and return 422; the service
never approximates a package price. Marked products are explicitly rejected
in this limited stage (no implicit marking-code consumption).

Currency is RUB. Every monetary request/response field is a nonnegative safe
JSON integer in kopecks, <= 100000000000. The pre-discount subtotal is also
bounded by this ceiling. Per-line amount is
`floor((qtyTenThousandths * unitPriceMinor + 5000) / 10000)`;
then sum the line amounts and subtract absolute discountMinor. This matches
PostgreSQL numeric round for nonnegative amounts. BigInt performs calculations;
SQL parameters are exact decimal strings. No monetary calculation passes
through floating-point rubles. Zero totals/prices remain supported.

Cash requires an explicit, undeleted own-company money account with kind=cash.
There is no default account selection, even with one available cash account.
Tendered >= total and change = tendered - total. Actual money received = total.
For a real customer, shipment and payment_in offset debt in the same transaction.
Retail cash uses retail_receipt.

Credit requires a non-retail existing own-company customer, moneyAccountId=null,
cashTendered=0, change=0. It posts sales_shipment, increases debt by total, and
creates no money movement. Card, mixed, prepayment, retail credit, unsupported
units, client track and contradictory data are 422. No partial writes survive.
The caller must supply the server-recomputed total; discrepancies are 422.

## Persistent identity and replay

The existing recursive canonicalizer sorts object keys and preserves array
order. Fingerprint = SHA-256(canonical JSON of
`{kind:'sale-v3',companyId,body:fullValidatedHttpBody}`). No financial fields are
silently removed or synthesized. docs.source_payload stores
`{kind:'sale-v3',request,fingerprint,responseStatus:201,result}` atomically.
The source sale document remains `sale-<order.id>`; real-customer cash payment
is `pay-<order.id>`. Stable line IDs are
`sale-<order.id>:line:<client lineId>`, independent of sorting position.

201 response contains ok, contractVersion, orderId, documentId, warehouseId,
fingerprint, subtotalMinor, discountMinor, saleTotalMinor, paymentMode,
moneyAccountId, cashTendered, change, cashReceivedMinor, paymentDocumentId,
and items with lineId/saleLineId/productId/qtyBase/amountMinor.
All response monetary values are integer kopecks.

Persistent proof and deterministic original response are checked BEFORE returning
a temporary replay. Identical historical replay returns the original 201/body,
even after temporary-key expiry, account archival or SQL unposting. It is not a
statement about current posting status. Corrupt/missing/conflicting evidence
never authorizes reposting. A temporary replay without permanent evidence is
409. Changes to payload or version for the same identity are 409. V2 and V3 use
the same order lock, sale lock and document identity, preventing a second sale.
Legacy cannot replay a v3 receipt or adopt its document. Old fingerprints and
source_payload values are not rewritten.

Proof retention is required: privileged deletion/modification of both source
documents and identities is outside this guarantee. SHA-256 is not a signature
against a database administrator.

## Transactions and locking

1. Existing order-commercial advisory lock (company + order identity).
2. Existing sale-v2 advisory namespace (same company + sale identity for both versions).
3. Read permanent evidence; claim/validate temporary idempotency.
4. Existing order row FOR UPDATE; any existing non-v3 order is a conflict.
5. Existing customer financial advisory barrier and revision write fence.
6. Real customer FOR SHARE; cash account FOR SHARE; warehouse FOR SHARE.
   SHARE blocks account archive/kind updates through commit, not just deletion.
7. Read products without a pre-held SHARE lock (post_doc updates mirrors;
   pre-held product SHARE locks would risk upgrade deadlocks with legacy posting).
8. Insert order/document/lines; lines are ordered by product as in v2.
9. Existing post_doc, optional payment_in/post_doc; compare exact posted amount,
   actual cash and debt with the expected integer amounts.
10. Store delivered order marker, audit, source proof, temporary response; commit.

All errors roll back documents, stock, money, debt, financial fences and proof.
No SQL function, schema or migration changes. Current catalogue/RBAC validation
applies on new execution; valid historical replay does not require the original
cash account/warehouse to remain active.

## Errors

422 SALE_V3_INVALID — strict schema, unsupported payment/packaging/track.
422 SALE_IDEMPOTENCY_KEY_INVALID — key not exactly sale-v3:<order.id>.
422 PAYMENT_DETAILS_INVALID — money account/tender/change combination invalid.
422 CREDIT_CUSTOMER_REQUIRED — retail/absent credit customer.
422 SALE_TOTAL_MISMATCH — subtotal/discount/total/cap mismatch.
422 CASH_ACCOUNT_UNAVAILABLE, SALE_CUSTOMER_UNAVAILABLE,
SALE_WAREHOUSE_UNAVAILABLE, SALE_PRODUCT_UNAVAILABLE — unavailable references.
422 SALE_MARKING_UNSUPPORTED — marked goods require a supported marking contract.
422 SALE_POSTING_TOTAL_MISMATCH — SQL result/ledger mismatch; full rollback.
409 SALE_IDENTITY_CONFLICT — conflicting identity, damaged permanent proof or
inconsistent historical/temporary response. Existing idempotency mismatch and
in-progress semantics remain. Existing authentication/authorization remains.
Unexpected SQL/internal errors remain private 500 errors with rollback.

## Scope and tests

Frontend/outbox are NOT integrated with sale v3. Stock reconciliation now uses
a separate v3 proof reader; see stock-reconcile.md. Do not enable v3 in clients
until frontend integration is complete. Historical HTTP replay is not a current
stock applied proof.
New v1/v2 remain available by explicit stage requirement; their previously
identified payment-classification risks are not fixed by this backend stage.
Customer payments, legacy shipments and other financial contracts are unchanged.

`test/integration/sales-v3.test.ts` exercises exact cash/credit, account types,
strict failures with complete state equality, rounding, permanent/historical
replay, socket loss after commit, concurrency across versions, rollback after
stock posting, RBAC/tenant isolation and both account-update lock orderings.
No new migration: existing test runner checks the existing migration chain.

## Verification for this stage

- Isolated PostgreSQL 17.10; no production database used.
- Complete backend suite: 741/741, 42 files, including existing fresh/upgrade
  migration tests through 0033 and the new PostgreSQL sale v3 suite.
- Final targeted PostgreSQL rerun after final proof-priority hardening: 47/47.
- Backend typecheck/build and git diff --check: PASS.
- No new migration, SQL function change or frontend/outbox integration.
