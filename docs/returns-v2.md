# Returns v2: limited backend contract

`POST /v1/returns` with the existing authentication and company headers.
The caller creates a UUID once per independent intention and persists it before sending.
Header: `Idempotency-Key: return:<returnId>`.

```json
{
  "contractVersion": 2,
  "returnId": "b95798e7-b181-4c6d-ae6c-5ee54fc4dc21",
  "orderId": "original-sale-id",
  "items": [{ "saleLineId": "sale-original-sale-id-0", "qtyBase": "1.0000" }],
  "reason": "Customer return"
}
```

`saleLineId` references the original posted `doc_lines.id`, not a product ID.
`qtyBase` is a positive decimal string with at most four fractional digits and a maximum of 1,000,000.
Duplicate line IDs and unknown request fields are rejected. The server normalizes quantity strings,
sorts lines by ID, includes company/version/return/order/reason in a SHA-256 fingerprint,
and saves the canonical command. The caller must not change an enqueued command.

## Response and identity

201 includes `contractVersion`, `returnId`, `orderId`, `documentId`, `paymentDocumentId` (nullable),
`fingerprint`, `items`, `amountMinor`, `cashRefundMinor`, `debtReductionMinor`, `accountId` and `fullyReturned`.
All monetary minor-unit fields are decimal **strings** in kopecks under the existing rouble accounting model.
Each item contains `saleLineId`, `productId`, `qtyBase`, `amountMinor`, `costAmount`.
`costAmount` is a decimal string in the existing ledger cost units, with four fractional digits.
The response is the actual posted result; clients must not replace it with their own amount estimate.

The document primary key `(company_id, ret-<returnId>)` and `docs.source_payload` hold permanent
identity, canonical request, fingerprint and result. `orders.returns` additionally retains identity,
result and originating user. This history is not subject to temporary idempotency-key cleanup.
Do not delete these records as part of ordinary housekeeping. Replays return the saved result
with `idempotency-replayed: true`; changing the command returns 409 `RETURN_ID_CONFLICT`, including
after temporary-key cleanup. Reusing a key to change returnId also returns 409.

## Accounting and supported cases

- Source: the original posted shipment, its fixed lines, warehouse, stock movements and payment ledger.
  Mutable product prices, current default accounts and client-proposed refund amounts are not used.
- Document discount is allocated proportionally to original line amounts using integer cents.
  Remaining cents go by largest remainder, tied by original line ID. Within each line the cumulative
  returned quantity determines the rounded cumulative refund; the previous actual refund is subtracted.
  The final return therefore consumes the exact remaining amount, without exceeding the original payment.
- Return lines carry the calculated **net** price (already including the allocated original discount);
  the return document has no additional discount. This avoids a second discount and preserves cent rounding.
- Original cost is restored proportionally, with cumulative rounding to four places, independently of price.
- A retail receipt with exactly one confirmed cash-account receipt movement: `retail_return` restores stock
  to the original warehouse and refunds that same account through unchanged `post_doc()`.
- A fully paid named-customer sale with a verified native `pay-<orderId>` document, cash movement and
  matching settlement: `sales_return` plus linked `payment_out`, in one transaction. Net customer debt
  does not change. The linked payout ID is `retpay-<returnId>`.
- An unpaid credit sale is supported only when the ledger proves its debt and the customer has no
  unallocated negative settlements/payments apart from this sale's verified previous v2 returns.
  The return reduces debt; it creates no money movement. This conservative check can reject otherwise
  valid credit sales when historical customer payments cannot be allocated unambiguously.

All validation, stock, payment, history, audit and temporary response writes share a SERIALIZABLE
transaction. Serialization/deadlock failures retry the **same** command up to three attempts;
exhaustion returns 409 `RETURN_RETRY_REQUIRED`. Retrying must retain both returnId and payload.

## Explicit exclusions and compatibility

422 `FINANCIAL_RECONCILIATION_REQUIRED` contains a diagnostic `reason` and commits no return writes.
The limited stage rejects partial/unallocated payments, multiple payment sources, card/bank accounts,
unknown payment origin, zero-total or inconsistent source documents, legacy refund history, missing
cost/ledger evidence, marked goods and non-final/void/deleted source sales. No mixed-payment policy
or external acquiring refund is implemented. A cash ledger proves the accounting receipt, not an
external audit of how an old cashier actually took payment.

Existing v1 requests without contractVersion (or with 1) retain their legacy implementation and results.
V2 does not reinterpret or delete old returns. New v2 returns on a sale with legacy refund history
require reconciliation. V1 requests on a sale already returned through v2 get 409 `RETURN_V2_REQUIRED`;
they cannot safely interpret base-line identities. A permanent v2 key cannot be reused by v1 after TTL cleanup.
Unknown contract versions return 400. The existing v1 idempotency limitations are not repaired here.

No schema changes, SQL-function changes, frontend/offline command migration, or production migrations.
This stage does not change the existing sale-cancellation policy; cancellation after a return and
other unrelated accounting flows require separate review before production rollout.
