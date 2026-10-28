# Sale cancellation after returns

Migration `0027_guard_sale_returns.sql` replaces only `post_doc(uuid,text)` and
`unpost_doc(uuid,text)`. No table/column changes, historical rewrites or automatic repairs.
The original amount, discount, costing and ledger algorithms are retained verbatim.

## Locking and invariant

For linked sale/return documents (`docs.order_id` within the same company):

1. Read the target identity without taking a document lock.
2. Acquire/write the original order tuple using `UPDATE orders SET id=id RETURNING *`.
3. For a return, lock the original posted sale `FOR SHARE`, then the return document
   `FOR UPDATE`. For cancellation, lock the original sale `FOR UPDATE`.
4. Revalidate the target order/type identity, then apply the existing balance/ledger algorithm.

The order tuple write is intentional: it fences stale REPEATABLE READ/SERIALIZABLE
snapshots that a plain row lock would not invalidate. Business fields are unchanged;
the normal order row-version/updated-at trigger runs on a successful operation.
All such writes roll back on a rejected operation. Direct SQL callers must roll back
and retry the same intention after SQLSTATE `40001` under those isolation levels.
The existing v2 transaction retry handles serialization errors without changing returnId.

Native v1, v2 and cancellation HTTP routes already acquire the order row before document
locks. Callers of the SQL routines must follow that order rather than pre-locking documents
and subsequently attempting to lock orders in reverse order.

`unpost_doc` refuses a linked sale with a related `retail_return`/`sales_return` that is
posted, including soft-deleted documents. Residual stock/money/settlement movements on
a return also block cancellation conservatively. JSON refund history and frontend flags
are not proof of posting. A draft return without movements does not block cancellation.

`post_doc` refuses a linked return if the order is deleted/cancelled or the original sale
is missing, not posted or ambiguous. The shipment marker identifies the source where present;
older orders without a marker need exactly one live posted sale document with that order_id.
An original sale can still be created before its order header within the native sale transaction.

## Errors and compatibility

- SQLSTATE `P0010` -> HTTP 409 `SALE_HAS_POSTED_RETURNS`.
- SQLSTATE `P0011` -> HTTP 409 `SALE_NOT_POSTED`.
- A native v1/v2 return against a cancelled sale also returns `SALE_NOT_POSTED` before posting.
- Previously successful cancellation with the same idempotency key still replays its original
  response before any posting checks. No new movements, audit/history or row-version writes.
- V2 request/success response, return identity and monetary rules are unchanged.
- Standalone documents without an order link retain their previous behavior. No source identity
  is inferred from product, quantity or time. Ambiguous/missing links on linked returns require review.
- The migration protects these routines, not arbitrary privileged direct table writes.

Run the migration in a test environment first. Existing inconsistent historical cancellations
remain unchanged and require a separate approved reconciliation process. Production deployment
of the migration is a separate action; deploying the HTTP guard alone does not close the SQL bypass.
