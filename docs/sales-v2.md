# Sales v2: explicit warehouse and permanent identity

`POST /v1/sales`, authenticated company context, existing `Idempotency-Key` header.
Opt in with numeric `contractVersion: 2` at the top level:

```json
{
  "contractVersion": 2,
  "order": {
    "id": "sale-identity",
    "warehouseId": "w2",
    "items": [{ "productId": "p1", "qty": 2, "price": 50 }],
    "discount": 0,
    "onCredit": false
  }
}
```

`order.id` is the sale identity (no separate `saleId` field). Existing optional
order fields remain available: no, customerId, customerName, priceTypeId,
shiftId, track. Line fields: productId, name, qty, price, unitId, unitFactor,
markCodes. V2 rejects unknown fields in the envelope, order and lines.
All lines use one explicit, non-archived warehouse belonging to the company.
Missing warehouse is validation error 400; unavailable warehouse is
422 `SALE_WAREHOUSE_UNAVAILABLE`, without movements. Quantities must remain
positive and finite after existing posting conversion to base units.

Response status 201 retains `ok` and `order` (id, no, subtotal, discount, total),
and adds contractVersion, documentId, warehouseId, fingerprint, and items
containing saleLineId, productId, qtyBase (four-decimal string).

## Identity and replay

Fingerprint: SHA-256 of canonical JSON `{contractVersion:2,companyId,order}`
after schema parsing/defaults. Object keys sort recursively; array order is
significant. All accepted fields, including warehouse, monetary inputs and
track metadata, participate. Transport keys are not part of the payload hash.
Omitted discount/onCredit equal explicit defaults; other optional fields are
not silently synthesized. Existing quantity, price, discount and payment
calculations are unchanged.

The transaction obtains a tenant/sale advisory lock (64-bit PostgreSQL hash of
the JSON tuple `['sale-v2',companyId,order.id]`), claims the temporary transport
key, then validates permanent proof **before returning any temporary replay**.
Different keys for an identical sale are allowed and return the same result.
A temporary key belonging to a different command cannot bypass this check.

The existing `docs.source_payload` stores
`{kind:'sale-v2',request,fingerprint,result}` in the same transaction as all
posting, order updates, audit and temporary response. No migration or SQL
function change is needed. Existing legacy payloads are never adopted or rewritten.
An existing shipment/order with stock already consumed is also a conflict.

Identical retries replay the original result, including after temporary-key
cleanup or warehouse archival. Replay is historical success, not a statement
that a subsequently cancelled sale is currently posted. It never reposts.
Changed payload for the same sale, invalid permanent proof, or inconsistent
temporary replay returns 409 `SALE_IDENTITY_CONFLICT` with transaction rollback.
The header `idempotency-replayed: true` identifies replay.

This guarantee assumes committed sale documents/proofs are retained and are
not modified through privileged SQL. Fingerprints are integrity identities,
not signatures against database administrators.

## Compatibility and scope

Requests without contractVersion 2 retain legacy parsing, default-warehouse
selection, calculations, responses and temporary idempotency semantics.
No frontend, shipment, return, reconciliation or SQL-function behavior changes.
Stock reconciliation recognizes this proof using the unchanged sales envelope
as its command payload; see stock-reconcile.md for the exact stock checks and
conservative handling of cancelled/unposted sales. API clients must keep the
same full v2 payload on retries.

Tests: `test/integration/sales-v2.test.ts` against isolated PostgreSQL, plus the
complete existing backend suite including legacy sales and returns v2.
