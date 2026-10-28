# Legacy customer payments and adjustments: unified fail-closed fence

POST /v1/customers/:id/payments accepts no executable financial command.
The existing JWT authentication, customerFinance permission (admin/manager),
Idempotency-Key syntax and own-company undeleted-customer checks remain.

## Responses

For an authenticated authorized request with valid fields and an existing
own-company customer:

- kind=payment: HTTP 422 LEGACY_CUSTOMER_PAYMENT_REQUIRES_RECONCILIATION.
- kind=adjustment: HTTP 422 LEGACY_CUSTOMER_ADJUSTMENT_REQUIRES_RECONCILIATION.
- Missing/unknown kind: HTTP 400 VALIDATION_ERROR. There is no default kind.
- The old fields amount, optional direction and note are strictly validated;
  unknown fields/contracts are rejected, not interpreted as a new payment API.
- Missing own-company customer: 404; unauthorized/forbidden requests retain
  authentication/RBAC errors. No foreign-company customer is looked up.

Both refusal responses use the existing ApiError envelope `{error:{code,message}}`.
No idempotency-replayed success header is returned. The messages explicitly
require reconciliation and prohibit automatic execution/replay.

## What cannot execute

The route contains no transaction, temporary-key query/claim, financial advisory
barrier, account selection, document insert, audit insert, post_doc, ledger write
or customer balance update. The only post-validation DB call is a scoped customer
existence SELECT. This applies to new calls, old successful temporary receipts,
cross-kind key reuse and retries after key expiry. No permanent evidence is
invented from mutable documents or current balance. Old documents, payloads,
fingerprints, keys and responses are not rewritten or deleted by the fence.

There is no separate public /v1/customers/:id/adjustments route: it remains 404.
The former adjustment branch lived under payments and is now equally fenced.

## Dependencies and other public routes

Sale v3 cash uses its explicitly validated cash account and creates its linked
payment_in internally in the sale transaction. Credit creates no payment.
Shipment v2 remains unpaid credit. Delivered/cancelled v2 use their own protected
lifecycle transactions. Returns v2 derives its payout account from actual source
facts and posts payment_out internally. None call this fenced HTTP endpoint.
Their shared customer financial lock helper, revision write fence and SQL
functions are unchanged.

Public documents/post only accepts warehouse document types, not payment_in or
opening_settlement. Sync does not allow docs/money_movements/settlement_movements
writes or customer balance changes. Public order creation does not post customer
finance. Subscription payments and fiscalization do not implement this customer
ledger endpoint. No other standalone customer payment/adjustment route was found.
Known legacy sales v1/v2 still bundle implicit-account payments and are expressly
outside this stage; this fence does NOT establish global legacy finance safety.

Frontend apiCustomerPayment is defined but has no callers in the current source.
CustomersPage uses local addPayment -> addMoneyTx, which is unchanged. A backend
fence cannot prevent those local UI balance changes; frontend integration and
operator reconciliation remain separate work. No outbox command is rewritten,
deleted, reidentified or converted to a new financial contract.

## Historical test fixtures and lock regression

Test-only legacy-customer-fixture.ts recreates former native PostgreSQL payment/
opening_settlement facts and old temporary receipts on synthetic data. It is
not imported by src or exposed as a route, flag or production bypass. Old return
and cancellation safety scenarios keep their historical payment data without
reopening public intake. The financial-barrier suite distinguishes historical
native fixtures from current supported production writers; it still exercises
the unchanged production lock helper, SQL write fence, races, rollback and ledger
semantics. Lost HTTP refusal now stays refused on repeat.

New fence tests compare complete company-scoped documents, ledgers, balances,
orders, audit, temporary receipts and financial fences before/after requests.
They cover key reuse in both directions, key expiry, strict validation, tenant
isolation/RBAC, concurrent intake, public aliases/sync/document attempts and
actual sale v3 cash/credit with returns v2.

No migration or financial SQL-function change. All backend instances and active
old requests must be drained/upgraded before depending on the fence globally.
Old clients can still send calls, but cannot make an upgraded backend execute
these operations. A future payment/adjustment contract needs separate approval.

## Verification

Isolated PostgreSQL 17.10, existing migrations through 0033:
- New fence PostgreSQL tests: 18/18 PASS.
- Clean targeted fence and financial-barrier tests: 44/44 PASS.
- Complete backend regression: 830/830 PASS, 45 test files.
- Typecheck, backend build and git diff --check: PASS.
- Sale v3 cash/credit, returns v2, shipment/delivered/cancelled v2 and existing
  stock/reconcile/tenant/RBAC/migration regression tests included.
