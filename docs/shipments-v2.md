# Shipment v2 — full protected-order shipment

No schema migration, frontend change, reconciliation change or posting-function replacement.
Requires commercial orders v2 (migration 0028). Historical orders keep their legacy status endpoint.

## Request

`POST /v1/orders/:orderId/status`, authenticated company context, non-courier.
`Idempotency-Key: shipment:<shipmentId>`; shipmentId is a lowercase UUID generated once per intention.
Body limit 512 KiB, at most 500 source lines, strict objects (unknown fields rejected).

```json
{
  "contractVersion": 2,
  "status": "shipped",
  "shipmentId": "00000000-0000-4000-8000-000000000001",
  "warehouseId": "warehouse-A",
  "orderSnapshot": { "...": "the entire exact commercial_snapshot, not a patch or legacy order.items" }
}
```

`orderSnapshot` has exactly the commercial schema described in commercial-orders-v2.md, including
items, stable line IDs, quantities/input units/factors, base-unit prices, customer, discounts, payment
and credit intent, totals/rounding, price type, shift and delivery metadata. No fields are reconstructed.
The example snapshot placeholder above is descriptive, not a valid abbreviated request.
Orders must be in picking or packed, with no previous sale document or shipment marker/effect.
Full snapshot equality is checked under the order lock. Client totals never override server data.

## Supported financial subset

Only an **unpaid credit order for an existing real customer**, with payment.method=credit,
onCredit=true, zero cashPaid/cardPaid/change, creditTerms=null and vatSummary=null.
Only zero discount (either explicitly percent zero or absolute zero). No marked products.
Total must be positive. Each source qtyBase * price must be exactly representable in kopecks,
and the sum of those exact amounts must equal the protected total. Whole-ruble rounding is allowed
only if it makes no change to that sum. Other cases return 422, not approximate amounts.

Commercial price is explicitly **per base unit**. Unit/input quantity/factor/base quantity are all
copied into doc_lines and validated against the server snapshot and current company catalog.
Packaging is supported when these quantities agree exactly; no unit/factor is guessed.

Existing post_doc(sales_shipment) performs stock output, original cost calculation and customer
settlement/debt. This endpoint creates **no payment document and no money movement**. It never
turns cash intent into evidence that cash was received. Client credit intent becomes debt only here.
Linked posted payment/prepayment documents (including pay-<orderId>) or actual payment ledger
evidence cause 422. Unallocated customer payments are not allocated to this order automatically.
They can make a later returns-v2 request require reconciliation under its existing rules.

No support is claimed for cash/card/mixed payment, non-credit unpaid orders, positive discounts,
VAT calculation, paid deposits, marked-code reservation or rounding differences. Extending those
cases requires a separately reviewed financial policy; changing total to match SQL is forbidden.

## Identity, persistence and replay

Canonical request: `{companyId,orderId,contractVersion,status,shipmentId,warehouseId,orderSnapshot}`.
SHA-256 uses the existing recursively sorted-object canonicalizer. Arrays and decimal strings retain
their exact identity. Company, warehouse and all accepted commercial fields are fingerprinted.

Permanent document PK: `(companyId, "shipment-" + shipmentId)`. In the same posting transaction:
`docs.source_payload = {kind:"shipment-v2",request,fingerprint,result}`.
The order's shipment_doc_id points to this document. Another shipmentId for that order is rejected.
One shipment ID cannot be adopted by another order in the same company.

Permanent proof is looked up and validated **before consulting temporary idempotency_keys**.
Temporary endpoint namespace is `POST /v1/orders/status:shipment-v2`, distinct from legacy statuses.
A temporary response alone never proves posting and cannot bypass a fingerprint conflict.
Successful replay returns HTTP 200 and the initial exact response, with Idempotency-Replayed=true,
even after TTL cleanup, delivery, warehouse archival or later cancellation. It never calls post_doc.
The historical receipt does not assert that the effect is still applied in a current stock snapshot.
Missing/corrupt/mismatched proof fails closed with 409. No historical document is rewritten on replay.

Response HTTP 200 includes:

```
{ok:true,contractVersion:2,order:{id,status:"shipped"},shipmentId,documentId,warehouseId,fingerprint,
 amount:<actual decimal string>,cashReceivedMinor:"0",debtCreatedMinor:<integer string>,
 items:[{sourceLineId,documentLineId,saleLineId,productId,qtyBase,amount}]}
```

`documentLineId = documentId + ":" + sourceLineId`; saleLineId is the same persisted line ID for returns.
Duplicate product lines remain distinct. SQL execution order is sorted by productId then sourceLineId
to follow existing stock lock ordering, but mappings are never inferred from sorted array positions.
Actual document total is read back and checked before commit; any mismatch rolls back everything.

## Locks and races

One SERIALIZABLE transaction, one connection: shipment identity advisory lock -> company/order
advisory lock (same key as commercial edits and sale upsert) -> permanent proof lookup -> temporary
key claim -> order FOR UPDATE -> warehouse SHARE lock -> reference validation -> document/stock/
customer locks taken by the existing post_doc. The temporary key is claimed before the order tuple,
matching legacy cancellation/returns; no order tuple is held while waiting on that temporary key.

Commercial validation for posting uses ordinary catalog reads rather than pre-held product/customer
SHARE locks: post_doc updates their mirrors, so lock upgrades would invert existing SQL stock lock
ordering. Existing commercial create/edit validation retains its previous SHARE-lock behavior.
Serializable isolation protects the read/write decision; 40001/40P01 rolls back and retries the same
immutable command at most three attempts. Exhaustion gives 409 SHIPMENT_RETRY_REQUIRED.

Edits serialize on the same order advisory/tuple locks. If edit commits first, old shipment snapshot
conflicts; if shipment commits first, edit is rejected. Cancellation uses the same order tuple fence:
cancel first rejects shipment; shipment first allows the existing cancellation to reverse its document.
Existing SQL return/cancellation guards remain authoritative, including direct SQL unpost_doc calls.
No pre-existing record is repaired or reassigned.

## Errors and boundaries

- 409 SHIPMENT_SNAPSHOT_CONFLICT: server commercial composition changed.
- 409 SHIPMENT_IDENTITY_CONFLICT: shipment/key/payload/document identity mismatch.
- 409 SHIPMENT_PROOF_INVALID: insufficient or corrupt permanent/temporary receipt.
- 409 SHIPMENT_REQUIRES_COMMERCIAL_V2: historical order, no trusted commercial snapshot.
- 409 SHIPMENT_ALREADY_EXISTS / SHIPMENT_ORDER_CANCELLED / SHIPMENT_STATUS_CONFLICT: invalid new shipment.
- 409 SHIPMENT_ORDER_UNVERIFIABLE: malformed/inconsistent protected server state.
- 409 SHIPMENT_RETRY_REQUIRED: bounded serialization retry exhausted; resend unchanged command.
- 422 SHIPMENT_INVALID: invalid/missing/extra v2 request fields.
- 422 SHIPMENT_WAREHOUSE_UNAVAILABLE: missing, foreign or archived warehouse.
- 422 SHIPMENT_UNSUPPORTED: unsupported financial, catalog, unit, marking or rounding case; details.reason explains.
- 403: courier or unauthorized company. 404: no accessible order. Existing SQL conflict codes retained.

Legacy `{status:...}` requests and historical documents keep the existing path. Protected orders
still reject legacy shipped with COMMERCIAL_ORDER_REQUIRES_SHIPMENT_V2. Returns v2 can use source
line IDs after delivered, for the existing supported unpaid-credit case. Cancellation after a posted
return remains forbidden by both HTTP and PostgreSQL. The separate stock/reconcile proof now accepts
shipment v2 inside order_status; see stock-reconcile.md for exact envelope and resolution rules.
Frontend offline shipment integration remains a later stage.

Delivered v2 is now a separate backend operation on the same status endpoint; see deliveries-v2.md.
Protected legacy delivered is rejected. After delivery, protected HTTP cancellation is forbidden;
the existing cancellation-before-delivery path and PostgreSQL posted-return guards remain in place.
