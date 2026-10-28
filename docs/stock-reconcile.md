# Atomic stock reconciliation

`POST /v1/stock/reconcile` is authenticated, read-only, and sends `Cache-Control: no-store`.
Company comes exclusively from the existing authenticated membership context. Couriers are denied.
No business endpoint, sync/pull behavior, SQL function, or schema is changed.

## Request

```json
{
  "contractVersion": 1,
  "requestId": "f9676bab-b143-473b-9953-aa14a94a1641",
  "productIds": ["p1"],
  "commands": [{
    "commandId": "document-id",
    "kind": "doc_post",
    "idempotencyKey": "doc-document-id",
    "payload": {"id": "document-id", "type": "adjust", "warehouseId": "w1", "items": [{"productId": "p1", "qty": 30}]}
  }]
}
```

Kinds: `sale`, `doc_post`, `order_status`, `return_v2`, `order_cancel`. Payload is the existing transport payload:
the legacy order object or full v2 HTTP envelope for sale, document object for doc_post,
`{orderId,status}` for legacy order_status, the unchanged HTTP body for shipment v2 order_status,
and the pure v2 request (not the local projection wrapper) for return_v2.
Keys and payloads are not changed or submitted for execution. Unknown top-level fields, including
companyId, and duplicate product/command identifiers are rejected.

## Consistency and coverage

One connection runs `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.
Products, balances, warehouses, documents, lines and totals are read before commit on that connection.
Ordinary MVCC reads do not block posting. A concurrent transaction is either visible in all these
reads or in none of them. `snapshotId` is a random response identifier, not a sortable commit version.

Success includes `coverage: {productIds, warehouseScope:"all-company-warehouses", complete:true,
missingBalanceMeansZero:true}`, `warehouses:[{id,active}]`,
`balances:[{warehouseId,productId,qtyBase}]`, `totals:[{productId,qtyBase}]`, and `commands`.
Quantities are decimal strings in base units. Archived warehouses are included, as are orphaned
warehouse identifiers still present in balances (inactive). Missing balance rows mean zero only
within this successful complete coverage. Unknown product identifiers return 404; no partial snapshot
is returned. Products discovered in command payloads or related server document lines outside the
requested set return 422 `STOCK_SCOPE_INCOMPLETE`. Add these products and repeat the whole request.

## Command resolutions

Every command returns `{commandId,resolution,effectIncluded,documentId,reason}`.

* `applied` for returns: permanent v2 return fingerprint, stored canonical request and result agree with the
  supplied request and linked return document is posted. `effectIncluded:true`.
* `reversed` for returns: the same permanent proof exists but document is now draft (unposted).
  `effectIncluded:false`; this does not authorize reposting.
* `conflict`: v2 identity/key or stored fingerprint differs. `effectIncluded:null`.
* `not_observed`: the identified document is not visible in this MVCC snapshot.
  `effectIncluded:false` means absent from this snapshot, NOT absent forever. A request may still
  be in flight; never create a new command/key based on this resolution.
* `unverifiable`: insufficient permanent payload proof, invalid identity, missing/corrupt/oversized
  saved proof or a legacy status transition. `effectIncluded:null`: do not automatically overlay
  the command as though its effect were absent.

Legacy sale/document matches are deliberately unverifiable; matching IDs alone are insufficient.
Legacy status transitions remain unverifiable even if current order status matches, because that is not a
permanent receipt for the particular transition. For an absent sale document with other linked order
documents, the result is also unverifiable. Temporary idempotency rows are not used as permanent proof.
No new permanent receipts are written. A saved v2 proof larger than 256 KiB is unverifiable.

## Permanent sale v2 stock proof

For `kind:"sale"`, a new v2 command supplies the **unchanged sales HTTP envelope**
as payload, rather than the legacy flat order:

```json
{
  "commandId": "sale-identity",
  "kind": "sale",
  "idempotencyKey": "sale-sale-identity",
  "payload": {
    "contractVersion": 2,
    "order": {
      "id": "sale-identity",
      "warehouseId": "w2",
      "items": [{ "productId": "p1", "qty": 2, "price": 50 }]
    }
  }
}
```

The outer reconciliation contract remains version 1. Product scope also covers
the nested order items. Legacy flat sale payloads retain their old behavior.
The transport key must satisfy the sales key schema; it need not equal
`sale-${id}` because sales v2 allows different keys for the same permanent sale.
No temporary key is read or written by reconciliation.

The service reuses `SaleV2Body` parsing/defaults and `saleFingerprint()` from
sales v2. The SHA-256 input is canonical JSON `{contractVersion:2,companyId,order}`:
all accepted fields participate, object keys are sorted recursively, array order
is significant. Company comes only from authentication. The stored original
request must have exactly this canonical shape and its hash must match the
stored fingerprint before a differing client payload is classified as conflict.

An `applied` sale requires all of the following in the **same read-only MVCC snapshot**:

* Command identity matches order ID, saved request, fingerprint and saved result.
* `sale-${order.id}` is a non-deleted posted sale document of the expected type,
  linked to that order and the exact saved/requested warehouse.
* The order still links to that shipment, has stock consumed and is not cancelled/deleted.
* All document lines and saved result line identities match the original sale,
  including rounded input/base quantities, unit, factor, product and price.
* There is exactly one matching negative stock movement per sale line, with the
  expected movement ID, type, product, warehouse and base quantity.
* For each affected pair, the balance agrees exactly with the sum of its stock
  ledger, using PostgreSQL numeric arithmetic (missing rows mean zero only in
  this complete scope). Other receipts, sales and returns can legitimately change
  the net balance; the sale quantity is not compared directly to today's balance.

Only then: `applied`, `effectIncluded:true`, reason `PERSISTENT_SALE_V2_STOCK_PROOF`.
Fingerprint-compatible proof never overrides a mismatching ledger or balance.

Sale outcomes:

* `conflict`: valid proof establishes a different canonical payload/company, or
  command/document identity/warehouse/type disagrees. Invalid command ID/key is
  also a conflict. `effectIncluded:null`.
* `unverifiable`: malformed/missing/oversized/internally inconsistent proof,
  invalid v2 request, bad result, broken order link, missing/extra/mismatching
  lines or movements, or ledger/balance discrepancy. `effectIncluded:null`.
* `not_observed`: a valid identified sale document and other linked documents
  are absent in this snapshot. `effectIncluded:false` is snapshot-local only;
  a parallel commit may occur later.
* `reversed`: **not emitted for sales in this stage**. `unpost_doc()` deletes
  movements and changes status to draft; HTTP cancellation may then set void.
  Neither state is a separate permanent reversal receipt. Saved initial success
  plus absent movements is insufficient to assert reversal. Draft, void and
  deleted sale documents therefore give `unverifiable` with reason
  `SALE_REVERSAL_NOT_PROVEN`. Existing return-v2 reversal rules are unchanged.

Sale orders, movements and balance/ledger comparison use the original connection
and transaction. New evidence row sets retain the 20,000-row limit; overflow is
an explicit 413, not truncation. Ledger aggregation is bounded by the existing
statement deadline and may time out on a large history. There is no pagination,
new snapshot version, data repair, posting or persistent receipt creation.

## Permanent shipment v2 stock proof

Shipment uses the existing `kind:"order_status"`; contractVersion 2 in its payload distinguishes it
from legacy commands. The reconciliation contract itself remains version 1. Example command:

```
{commandId: <orderId from the shipment URL>, kind:"order_status",
 idempotencyKey:"shipment:<shipmentId>",
 payload:{contractVersion:2,status:"shipped",shipmentId,warehouseId,
          orderSnapshot:<the complete original commercial snapshot>}}
```

This is descriptive notation. `payload` must be the **exact saved shipment HTTP body** accepted by
`POST /v1/orders/:orderId/status`. Do not add orderId/companyId to that body, wrap it, strip fields,
change numeric strings or reconstruct it from the current order. The existing commandId supplies
the URL orderId. shipmentId stays in the body; the transport key must be shipment:<shipmentId>.
One full shipment per order means a commandId identifies that order in this reconciliation batch.

The service reuses `ShipmentBody` and the existing canonicalSale/saleFingerprint algorithm.
Canonical request is `{companyId,orderId,contractVersion,status,shipmentId,warehouseId,orderSnapshot}`,
exactly as stored by shipment v2. Company comes only from authentication. The saved canonical shape
and SHA-256 must be internally valid before comparing them to the requested command. A damaged
saved fingerprint/request is unverifiable; a valid proof of another payload is conflict.

For applied, all checks use the **same existing REPEATABLE READ READ ONLY connection and snapshot**:

* `shipment-<shipmentId>` contains a valid shipment-v2 proof and initial result matching the full command.
* The native document is a non-deleted posted sales_shipment for this order, warehouse and customer.
* The order links through shipment_doc_id, has stock consumed, is not deleted, and its protected
  commercial snapshot matches. A second linked sale source makes the linkage unverifiable.
* Every source line maps through documentId + ":" + sourceLineId, never a sorted array position.
  Duplicate products remain distinct. Native product, unit, factor, input/base quantities, price,
  amount and saved result mapping must match. No current catalog/default warehouse is substituted.
* Exactly one negative stock movement per source line matches document, movement ID, type,
  warehouse, product and base quantity.
* For each affected product, balances at **all warehouses** agree with the complete stock ledger
  aggregate in this snapshot. Drift at another warehouse of that product also prevents applied.
  Net balances can include subsequent receipts, sales or returns; they are not compared to just
  the original shipment quantity.

Only then: applied, effectIncluded:true, reason PERSISTENT_SHIPMENT_V2_STOCK_PROOF.
Delivered retains proof. Cancelled text alone is not reversal evidence: the document and actual
movements are checked. An inconsistent order marker/stock flag still fails closed.

Shipment resolutions:

* conflict / effectIncluded:null: wrong key; internally valid permanent proof of different company,
  order, shipment, warehouse or full payload; native document identity/content disagrees. A valid
  linked shipment proof for a different shipmentId is conflict even when the requested document
  does not exist. Missing or corrupt alternative proof is insufficient to assert that conflict.
* unverifiable / effectIncluded:null: corrupt, absent, oversized or inconsistent proof/result;
  broken/ambiguous order link; missing/extra/deleted source lines or movements; ledger/balance drift.
  Orphaned rows and existing markers prevent misreporting a missing document as not_observed.
* not_observed / effectIncluded:false: identified shipment is not visible and no related source,
  marker, orphaned lines/movements or shipped/delivered state contradicts that absence. This says
  nothing about an in-flight transaction or a future commit; keep the original command and key.
* reversed / effectIncluded:false: emitted only with the complete permanent cancelled-v2
  receipt and current-state checks described below. Draft/void or missing movements without
  that receipt remain unverifiable; no historical reversal receipt is inferred.

Expected proofs and the order's marked source proof are loaded with the existing 256 KiB per-proof
cap; unrelated historical source_payload text is not fetched wholesale. Products in nested
orderSnapshot and related native lines/movements must fit the requested full scope, or 422 is returned.
Orders, native lines, movements and discrepancy rows retain the 20,000-row limit; request, response
and time budgets below remain unchanged. Large shipment bodies accepted by the posting endpoint
may exceed reconciliation's smaller body/proof limits: there is no hidden truncation or pagination.
No idempotency record is read/updated, no receipt is created and no stock/money/debt entry is posted.
Sale v2, return v2 and legacy resolution rules are unchanged. Frontend integration is a later stage.

## Permanent cancelled-shipment proof

No new endpoint, request kind, version, shipment/cancellation HTTP body, migration or SQL
function is introduced. Submit the exact **original shipment HTTP body** as the existing
order_status command, with commandId=URL orderId and shipment:<shipmentId>. The source
shipment is reported reversed, not a separate cancellation command reported applied.

One REPEATABLE READ READ ONLY connection loads lifecycle receipts, source documents/lines,
remaining stock/money/settlement rows and ledger comparisons with the other snapshot data.
There are no advisory/row locks, posting calls, financial fences, receipt writes or data repairs.
The pure cancellation replay verifier is reused to avoid a second weaker receipt format.
The posted-shipment proof resolver itself remains unchanged.

Reversed requires **all** of the following:

1. The original shipment identity, canonical full request and fingerprint are internally
   valid and match the caller's company/order/shipment/warehouse and transport key.
2. Exactly one applicable cancelled lifecycle receipt is internally valid: native identity,
   strict canonical cancellation body, recomputed SHA-256, original HTTP 200/result and all
   captured evidence agree. Damaged proof is unverifiable before any different identity can
   be called a conflict. A fully valid proof of another identity/payload is conflict.
3. The complete version-1 cancellation manifest validates the originally posted document,
   raw shipment-proof, exact source-ID line mappings, quantities/units/prices/amounts/costs,
   original negative stock movements and the single original positive debt settlement.
   Manifest/hash, source/hash, lines/hash, removed IDs, restored items, debt and zero cash
   refund are checked by the same pure verifier as historical cancellation replay.
4. Current source document is non-deleted **void**, posted_at=null. Its captured immutable
   header fields and raw source_payload exactly match the manifest. Current native line
   fields/costs match the captured canonical lines/hash. The original deterministic line_no
   and null note required by shipment v2 are checked by stable source ID, not used as identity.
   Technical row-version/timestamp metadata is not manufactured as historical row evidence.
5. Current order is non-deleted cancelled, retains the original shipment_doc_id and protected
   commercial_snapshot, has stock_consumed=false and is not older than its own saved result
   rowVersion. No delivered receipt or additional ambiguous source shipment contradicts it.
   A rowVersion comparison is not a global commit version; snapshot consistency comes from MVCC.
6. No original/source stock, money or settlement movements remain. Deleted stock/settlement
   IDs are also looked up directly, so moving an original ID under another document cannot
   masquerade as deletion. Quantity **and cost** balances match the surviving stock registry
   for all affected products at every warehouse, including archived/orphaned warehouse IDs.

Result: reversed, effectIncluded:false, reason=PERSISTENT_SHIPMENT_V2_CANCELLATION_PROOF.
This says the original shipment output is absent from this snapshot; it does not authorize
reposting or applying an additional local correction.

Later legitimate receipts, inventories, transfers, sales and payments do not require today's
balance/debt to equal a historical pre-shipment value. The original source effect and current
net registry are checked separately. No new financial allocation policy is introduced.

Conservative ambiguity rules:

- A cancelled status without a cancellation receipt is unverifiable, including a still-posted
  document: textual workflow state alone cannot select the accounting interpretation.
- A cancellation receipt alongside a posted source is unverifiable, never applied or reversed.
- Missing/corrupt receipt/hash/manifest/source proof or lines, draft/missing source, broken
  order link, residual movements, delivered evidence or balance drift are unverifiable.
- Proven original request/key/warehouse/composition identity conflicts remain conflict.
- Ordinary valid posted shipment and delivered-shipment checks retain applied. An actually
  unobserved shipment remains not_observed; this is never a guarantee against a future commit.
- Sale v2, return v2, inventory/document and legacy command handling are unchanged.

Native row sets keep the 20,000-row cap. Loaded lifecycle canonical/result evidence has a
combined 4 MiB budget, enforced in SQL before returning large JSON bodies. Overflow gives
413 STOCK_SNAPSHOT_TOO_LARGE, not a silently truncated successful proof. The existing whole
request deadline and statement timeouts cover every added read. Proof results expose no raw
receipt/manifest data in the snapshot response. No historical data is rewritten or adopted.

### Separate order_cancel command

The strict new envelope is:

```json
{
  "kind": "order_cancel",
  "commandId": "cancelled:00000000-0000-4000-8000-000000000001",
  "orderId": "order-id",
  "idempotencyKey": "cancelled:00000000-0000-4000-8000-000000000001",
  "payload": {
    "contractVersion": 2,
    "status": "cancelled",
    "shipmentId": "00000000-0000-4000-8000-000000000001",
    "shipmentFingerprint": "<64 lowercase hex characters>"
  }
}
```

`orderId` is URL metadata, not an addition to the unchanged cancellation HTTP body.
It is required only for this kind (1–64 characters: letters, digits, underscore, colon,
period or hyphen). The lowercase UUID and fingerprint use CancellationBody's exact
validation. Both commandId and idempotencyKey must equal cancelled:<shipmentId>.
Unknown fields are rejected. Existing command schemas are unchanged.

Command IDs remain globally unique across kinds, including arbitrary legacy strings:
a string collision is rejected with 400 even if kind differs. An original shipment
uses commandId=orderId; cancellation uses cancelled:<shipmentId>. Both may be read
in one common snapshot with the unchanged result format.

The cancellation receipt is validated internally using the cancellation replay verifier
before comparing its company/order/canonical request to this command. Valid but different
identity is conflict. Invalid receipt/fingerprint/original HTTP result is unverifiable.
A missing receipt is not_observed unless current void/cancelled evidence makes the state
ambiguous (unverifiable). Neither result authorizes automatic cancellation retries.

After exact receipt matching, the reader reconstructs the original shipment proof request
from its verified captured manifest and calls the existing shipment reversal resolver with
all native document/line/registry/balance evidence from this same transaction. Only its
reversed result becomes order_cancel applied (effectIncluded:true,
reason=PERSISTENT_CANCELLATION_V2_PROOF). The original shipment still returns reversed
(effectIncluded:false). Posted source, residual movements, balance/cost drift or damaged
links remain unverifiable. Status alone or absence of movements is never sufficient.
This mapping proves this cancellation is included, not permission to add stock locally.
No writer, replay execution, post_doc or unpost_doc is called by reconciliation.

## Limits and errors

* Request body: 256 KiB, maximum 500 distinct products and 500 distinct commands.
* Maximum 20,000 rows each for balances, warehouses, related documents and lines; one extra row
  detects overflow. Overflow gives 413 `STOCK_SNAPSHOT_TOO_LARGE`, never silent truncation.
* Serialized successful response: maximum 4 MiB, otherwise the same 413 error.
* Five-second processing budget including connection acquisition; SQL statement timeouts use the
  remaining budget, with a five-second idle-in-transaction timeout. Timeout gives 503
  `STOCK_RECONCILE_TIMEOUT`. Rollback and connection release happen on failures. This is an
  application/SQL execution budget, not a guarantee about network delivery time.

The response is a scoped atomic snapshot, not a paginated global company revision. Clients must
not mix balances from one response with command coverage from another. Dependent operations require
one sufficient common scope; a new request obtains a new snapshot. Offline ordering, cache migration,
frontend adoption and warehouse selection changes are outside this backend-only stage.


## Sale v3: current stock proof

Public kind remains sale; commandId is order.id; idempotencyKey must exactly
match sale-v3:<order.id>. payload is the full immutable sale v3 HTTP body.
Company comes only from authenticated membership. Existing commandId uniqueness,
request/response formats, v2 fingerprints/proofs and all limits are unchanged.

saleV3StockProof shares pure canonical identity, SHA-256, stable line-ID,
integer amount and original-response builders with salesV3. It calls no writer,
HTTP replay, post_doc or unpost_doc. source_payload must contain a matching full
canonical request, fingerprint, responseStatus=201 and complete original result.
Self-consistent different identity is conflict; damaged/incomplete proof is
unverifiable. A valid permanent v2 identity cannot confirm v3 with the same ID.

Applied additionally requires the posted, undeleted source with posted_at and
correct company/order/document/warehouse/type/party/account/price type/amount/
discount, plus the delivered undeleted order's stock_consumed and shipment link.
Stable line ID = sale-<order.id>:line:<lineId>, never just array position.
Native line company/document/product/line_no/qty/qty_input/factor=1/unit_id=null/
base-unit price/rounded amount must match. Each movement must have the same
stable ID, company/document/type/product/warehouse and negative quantity.
Native line cost must equal negative movement cost. All DB numerics are read
as text and compared with integer scaling, never rounded to fit the proof.

For the affected products, all company warehouses (including archived ones)
are compared with ledger quantity AND cost sums. Drift at another warehouse
also blocks v3 applied. Existing v2 quantity-only applied semantics and public
quantity-only response remain unchanged. This does not audit money/debt ledgers.

All facts belong to the existing single-connection REPEATABLE READ READ ONLY
transaction. No pre/post-commit mixing. snapshotId identifies only this response.
Existing request, row, source-proof, SQL/application time and response budgets
are unchanged; oversized/incomplete source evidence cannot establish applied.

Resolutions keep the same effectIncluded mapping:
- applied: complete matching permanent proof AND current native stock effect.
- conflict: commandId/key mismatch, proven different canonical identity/version,
  or contradictory company/order/document/warehouse identity.
- unverifiable: bad/missing proof or response, changed document/lines/movements,
  order-link defects, ledger drift, or insufficient reversal evidence. A marker
  or orphaned line/movement with no document is not not_observed.
- not_observed: no document or related effect evidence in this snapshot. This
  never authorizes automatic creation/retry or excludes a future commit.
- reversed: not emitted for v3 without a separate sufficient permanent reversal
  proof. Draft/unposted/deleted state or absent movements alone is insufficient.

Historical sale HTTP replay can still return 201 after SQL unposting, while
reconcile returns unverifiable. Existing shipment cancellation/reversed behavior
is retained. Frontend/outbox adoption and v3 reversal proof are separate stages.

Verification for the sale v3 proof stage (isolated PostgreSQL 17.10):
- Clean targeted run: 49/49 PASS.
- Clean complete backend run: 790/790 PASS, 43 test files.
- Existing v2/return/shipment/cancellation and migration regressions included.
- No schema/function/migration/frontend/outbox changes.
