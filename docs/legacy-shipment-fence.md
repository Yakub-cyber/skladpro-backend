# Legacy shipment fence (backend-only P1)

POST /v1/orders/:id/status no longer executes new legacy shipment posting.
Requests without contractVersion, or contractVersion:1, with status:shipped are
rejected BEFORE transaction, temporary key claim, financial fence, status/audit
update, document creation or post_doc. Old shipment posting/default warehouse/
default account selection code was removed, not retained as a fallback.

## HTTP behavior

- Authenticated own-company historical order, authorized admin/manager:
  422 LEGACY_SHIPMENT_REQUIRES_RECONCILIATION, with a clear error message.
  This also applies when a temporary successful shipment reply already exists,
  or status/stock_consumed says shipped. No historical facts are rewritten.
- Protected commercial order requested through legacy shipped: existing
  409 COMMERCIAL_ORDER_REQUIRES_SHIPMENT_V2. No automatic conversion.
- Missing/deleted own-company order: 404; foreign company membership: 403.
- Existing legacy RBAC remains: stock/courier/cashier cannot use legacy shipped.
- Unknown contractVersion (including string "2", null, 3) is
  422 ORDER_STATUS_VERSION_UNSUPPORTED, never legacy fallback.
- Numeric version 2 continues strict shipment/delivery/cancellation routing.
  Fake/incomplete v2 envelopes are rejected by existing v2 services.

The ApiError handler preserves HTTP 422/409 and error.code. Frontend can retain
and quarantine the refused command. This stage does not edit/rewrite/delete
frontend outbox commands or choose a new company, account, warehouse or identity.

## Status branch trace

| Branch | Effect after this change |
| --- | --- |
| Legacy new/confirmed/picking/packed | Workflow status, track, audit and temporary response only; no post/unpost or stock_consumed update |
| Legacy shipped | Denied before writes; neither retail_receipt, sales_shipment nor payment_in can be created here |
| Legacy shipped -> delivered | Workflow only; preserves stock_consumed and native ledgers, with existing transition/assignment checks |
| Legacy cancelled before stock consumption | Existing workflow cancellation only |
| Legacy cancelled after stock consumption | Existing guarded unpost_doc path; may remove movements and set stock_consumed=false; deliberately unchanged |
| Protected shipment v2 | Existing unpaid-credit document posting and permanent fingerprint/replay |
| Protected delivered v2 | Existing lifecycle receipt; no stock/cash/debt posting |
| Protected cancelled v2 | Existing cancellation receipt and guarded reversal |

Historical v2 replay remains in the v2 services. A legacy temporary response
whose recorded target was shipped is NOT accepted even if its key is reused for
another legacy workflow target; it raises the same 422 and rolls back. No proof
is synthesized from current order flags or a temporary response.

## Locks and races

Successful v2 services and remaining legacy workflow/cancellation lock order
are unchanged. The legacy shipped deny path needs only a company-scoped marker
read and takes no transactional locks because it cannot execute any writer.
A concurrent commercial edit or shipment cannot turn this unconditional deny
into posting. The original code that could create a shipment has been removed.
Existing v2 fingerprint, source_payload and receipts are untouched.

## Other entry points and release limits

Known POST /v1/sales v1/v2 new posting remains a separate next fence stage.
It is not claimed fixed here. Sale v3 remains supported. Customer payments are
explicitly outside scope. Public order creation and sync can save order data,
but do not post shipment; they cannot re-enable the removed status branch.
Public documents/post restricts types to receive/writeoff/adjust/transfer.
No additional unaccounted sale-posting route was found in this trace.

All backend instances must be upgraded and old writers drained before relying
on this fence. Old service workers/clients can keep sending old requests; they
receive the server error. Do not rebuild/reassign their saved commands.
An old backend instance does not obey the new fence merely because another
instance holds it; existing advisory locks serialize but do not disable old code.

## Tests

New PostgreSQL tests use synthetic own-company fixtures, including an explicit
pre-fence committed retail receipt reconstructed in test-only SQL. There is no
production test bypass or feature flag. They compare full accounting/state
facts before/after refusals, exercise credit/paid and retail/real-customer
combinations, old temporary success, repeated/concurrent calls, version/status
variants, pure workflow, tenant/RBAC, and v2/v3 success and permanent replay.
The financial-barrier regression now proves legacy shipment does not reach a
write fence or accounting; all still-supported writers retain their old checks.

No schema, migration, SQL-function, frontend, stock/reconcile or payment changes.

## Verification

- Fresh isolated PostgreSQL 17.10 cluster, migrations through 0033.
- New fence PostgreSQL suite: 22/22 PASS.
- Final targeted fence + historical sale v2 regression: 41/41 PASS.
- Complete backend regression: 812/812 PASS, 44 files.
- Backend typecheck/build and git diff --check: PASS.
- Historical status-shipment fixture in sales-v2.test.ts is reconstructed with
  test-only SQL using unchanged post_doc; production is never reopened for setup.
