# Commercial orders v2 (pre-shipment)

This contract only records an order. It never accepts money, creates debt or posts documents.
Historical orders remain `commercial_snapshot = NULL`; they cannot be silently adopted.
No frontend integration or shipment-v2 implementation is included.

## Transport and permanent identity

`POST /v1/orders` creates; `PUT /v1/orders/:id/commercial` replaces a full snapshot.
Both require authenticated membership; company comes exclusively from auth. Couriers cannot write.
Body limit 512 KiB; maximum 500 lines; unknown fields fail with 422.

```json
{
  "contractVersion": 2,
  "commandId": "commercial-command-uuid",
  "orderId": "order-uuid",
  "commercial": {
    "items": [{"lineId":"line-uuid","productId":"p1","unitId":"u-sht","unitFactor":"1","qtyInput":"2","qtyBase":"2","price":"50.00"}],
    "customerId":"c1", "customerName":"Customer", "no":null,
    "priceTypeId":null, "shiftId":null,
    "subtotal":"100.00", "discount":{"kind":"percent","value":"0"},
    "total":"100.00", "rounding":"kopeck", "onCredit":false,
    "creditTerms":null,
    "payment":{"method":"unpaid","cashPaid":"0","cardPaid":"0","change":"0"},
    "vatSummary":null, "address":null, "geo":null,
    "courier":null, "assignedTo":null, "priority":false
  }
}
```

Replace also requires `expectedRowVersion` (decimal integer string) and matching URL/body order IDs.
Create forbids expectedRowVersion. Idempotency identity is commandId, not a temporary HTTP key.
Response 201 create / 200 replace: `{ok,contractVersion,commandId,order:{id,rowVersion,commercial},fingerprint}`.
Canonical SHA-256 covers company, operation and the whole accepted body, including expected version.
Object keys are sorted recursively; array order and decimal string representations are significant.
The same command replays its original status/body, even after later edits or temporary-key cleanup.
Reusing commandId with another order, operation or payload returns 409 COMMERCIAL_IDENTITY_CONFLICT.
Every standalone edit needs a new commandId. Rejected commands do not consume it.

## Field map and arithmetic

| Frontend concept | v2 representation and semantics |
|---|---|
| items/productId | Ordered items; stable unique lineId; company-owned active product required |
| qty/inputQty/unit/unitFactor | Explicit unitId + qtyInput + unitFactor + qtyBase; catalog factor checked, no inferred unit or double conversion |
| price | Decimal money **per base unit**; clients must explicitly convert any packaging-price convention |
| name/basePrice | Optional descriptive name/reference basePrice retained; basePrice does not alter payable price |
| markCodes | Empty array/omitted allowed; nonempty rejected, no reservation semantics introduced |
| subtotal | Exact sum(qtyBase * price), rounded half-up to kopecks after summation |
| discount | Explicit percent (0..100) or absolute amount; applied to the unrounded sum of base quantities times prices |
| total | Payable amount rounded once to explicit kopeck or ruble (half-up); no intermediate discount rounding; server verifies |
| customerId/customerName | Company customer or explicit retail/null; snapshot name preserved |
| priceTypeId/shiftId | Nullable company-owned existing records |
| onCredit | Credit intent only; requires real customer and payment.method=credit; no debt movement |
| creditTerms | Only null supported; durations, installments and interest require a separate contract |
| payment | unpaid/cash/credit intent only, all paid/change amounts zero; no money received |
| card/mixed/prepayment | Explicit 422, never guessed cash or silently dropped |
| vatSummary | Only null (unknown, not tax-exempt) supported; existing frontend breakdown precedes discount and uses fallback rates; no unverified tax calculation accepted |
| address/geo | Nullable address and validated numeric latitude/longitude, preserved in snapshot |
| no/courier/assignedTo/priority | Preserved commercial/delivery metadata |
| status/track/createdAt/kind/stockConsumed/shipmentDocId | Server/workflow fields, not accepted commercial inputs |

Quantities/factors accept at most four decimal places; money at most two. Values are decimal strings,
not JS floating-point inputs. qtyInput * factor must exactly equal qtyBase at supported precision.
No rounding of an unrepresentable base quantity. BigInt arithmetic avoids numeric parser precision loss.
Full commercial truth is commercial_snapshot, not the legacy scalar discount column (percentage only).
Legacy mirror items use base qty and price, with explicit unit/input metadata retained.

Existing NewOrderPage rounds total to whole rubles; updateOrder rounds to kopecks. v2 makes that
choice explicit instead of silently changing either UI. No frontend caller is migrated here.
VAT, actually paid funds, mixed/card provenance, package-price ambiguity, marked-code reservation and
additional credit terms are deliberately unsupported. Unknown fields are rejected, never discarded.

## Concurrency and legacy protection

One transaction: command advisory lock -> tenant/order advisory lock -> order FOR UPDATE ->
ownership/reference checks -> order replacement -> permanent receipt -> commit.
Advisory lock keys are namespaced JSON arrays hashed with hashtextextended; transaction scoped.
Order advisory locks serialize creation of an absent row. Command locks serialize cross-order reuse.
Permanent receipt lookup precedes expectedRowVersion validation and all current catalog checks.
Existing row_version is opaque and changes for workflow updates too; clients must refetch on 409.
No wall-clock last-write-wins for v2.

Order edit rejects deleted/cancelled orders, stockConsumed/shipmentDocId, posted source sale documents,
or actual stock/money/settlement movements for a linked sale document even if its status is inconsistent.
SQL posting uses the existing order tuple fence; edits lock that same tuple before examining evidence.
Commercial edit after cancelled/previously shipped order is not an automatic reopening operation.

Legacy sync orders use the same order advisory lock and FOR UPDATE for check and write. Protected
orders reject all legacy order writes/deletes, including metadata writes; legacy clients must not retry
these errors indefinitely. Historical shipped markers are also protected. Other legacy tables unchanged.
Sales (legacy/v2) use the same order lock and reject upserting a protected order before any new posting.
Existing successful sale replay still returns its stored result without new writes.
Protected orders reject legacy `shipped` with 409 COMMERCIAL_ORDER_REQUIRES_SHIPMENT_V2: that path
does not honor all commercial discount/payment semantics. The separate shipment-v2 contract supports
the explicit subset documented in shipments-v2.md.
Other historical order/status, public-create, sale, return and reconciliation contracts remain unchanged.

## Storage / migration

0028_order_commercial_v2.sql adds nullable orders.commercial_snapshot and order_commercial_commands.
No backfill, historical UPDATE, posting-function changes, triggers or ledger writes.
Receipts have company+command primary key, company+order FK and lookup index; no TTL cleanup.
Order FK prevents accidental hard deletion of orders with receipts. Company deletion remains the explicit
tenant purge path. Temporary idempotency cleanup does not touch receipts.

Deploy migration before API code. Downgrading to an old backend would remove application guards and
is unsafe for protected orders; rollbacks require preserving these guards. Direct arbitrary SQL UPDATE
of orders is outside API protections; no new DB trigger or posting-function modification is introduced.
