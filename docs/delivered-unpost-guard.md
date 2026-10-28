# Delivered shipment v2: direct SQL unpost protection

Migration `0030_guard_delivered_unpost.sql` replaces **only** `unpost_doc(uuid,text)`.
It does not replace `post_doc`, alter tables, backfill documents, change accounting,
or repair already inconsistent historical data. Apply through the ordinary migration
runner after 0029. Re-running the runner skips the already applied migration.

## Locking and atomicity

The original algorithm remains: read document identity without a document lock;
write-fence the linked order using `UPDATE orders SET id=id`; lock the document
`FOR UPDATE`; revalidate its order/type; check prohibitions; then reverse movements.
The fence must not be reduced to a plain `FOR UPDATE`: an older REPEATABLE READ or
SERIALIZABLE snapshot must fail with `40001` after a concurrent delivery commit.
Retry the entire transaction, not the failed statement within its old snapshot.

No new advisory lock is taken after the order lock. Delivery uses its existing
command/commercial advisory locks, then the order tuple, then document locks.
Returns also lock the order before the source document. Receipt reads do not add
row locks. Administrative callers must use the same order-before-document order;
arbitrarily prelocking documents can still introduce deadlocks outside this path.

On failure, PostgreSQL rolls back the write fence and all row changes made by the
statement. Sequence gaps from row-version allocation remain normal; they are not
accounting facts. All denial checks precede the original movement reversal loop.

## Denials, in priority order

1. Existing missing/changed document and non-posted checks remain unchanged.
2. `P0010` / HTTP 409 `SALE_HAS_POSTED_RETURNS`: an associated v1/v2 return is
   posted or still has stock, money or settlement movements. Soft deletion does
   not disable this protection.
3. A sale/shipment document is protected after delivery when the order is
   `delivered` **or** a permanent delivery receipt exists, and there is a protected
   commercial snapshot, a receipt, or a shipment-v2 source marker.
4. `P0013` / HTTP 409 `DELIVERED_SHIPMENT_RECONCILIATION_REQUIRED`: that delivered
   protected document has missing, malformed or inconsistent linkage/evidence.
5. `P0012` / HTTP 409 `DELIVERED_ORDER_CANCELLATION_FORBIDDEN`: the delivered
   protected shipment's links are consistent. Use the return process instead.

Receipt lookup is company-scoped and uses both order identity and the permanent
`delivered:<shipmentId>` command identity derived from the shipment document ID.
This also denies unpost if the document's order link is damaged or removed.
Multiple matching receipts are ambiguous and cause reconciliation failure.

Link checks include commercial_snapshot, shipment_doc_id, document type/company/
order/warehouse, source request and result identifiers, source fingerprint
consistency, and delivery receipt canonical payload/result. This is a prohibition
check, not a new stock-proof or cryptographic acceptance mechanism. Corrupt data
never grants permission to unpost a delivery that retains protection evidence.

`source_payload` is historical text: JSON conversion catches data exceptions,
including invalid Unicode/numeric representations. Payloads over 256 KiB are
treated as missing evidence. Neither missing JSON nor a changed shipment marker
disables protection when the commercial snapshot or permanent receipt remains.

## Compatibility and limits

- Before delivery, shipment v2 unposting retains existing behavior when there is
  no other prohibition. A later delivery must fail if its document is unposted.
- Historical unprotected documents and return documents retain existing behavior.
- A later textual order-status change does not remove a permanent delivery ban.
- A denied unpost leaves the original shipment proof intact; stock/reconcile can
  still return `applied`. No new `reversed` evidence is manufactured.
- This is not protection against a privileged administrator deleting receipts,
  rewriting all identity evidence, disabling triggers, or modifying registries
  directly. Restricting arbitrary table writes requires a separate permissions
  design. No such privilege changes are included here.
- Existing damaged data is not automatically repaired.

## Verification

`test/integration/delivered-unpost-guard.test.ts` runs against real PostgreSQL via
`TEST_DATABASE_URL`. It verifies ordinary/pre-delivery and denied unposts, status
changes, corrupted payloads/markers/receipts, return priority and return unpost,
tenant isolation, error mapping, unchanged accounting and lifecycle facts, and
shipment `applied` after denial.

Concurrent cases wait for actual PostgreSQL lock contention in both orderings:
delivery/unpost, SQL return/unpost, delivered return v2/unpost, and HTTP
cancellation/delivery. RC/RR/SERIALIZABLE stale-snapshot cases verify `P0012` or
`40001`, rollback, and re-observation in a fresh transaction. Tests check zero
deadlocks and no remaining blocked/idle transactions in the isolated test DB.

Migration tests compare `pg_get_functiondef`/`prosrc` with 0027 before upgrade and
0030 afterward, preserve the exact `post_doc` definition, compare columns,
constraints, triggers and historical rows across upgrade, deploy 0001–0030 on an
empty database, and rerun the unmodified runner. Tests create additional databases
only on the explicitly configured test server, which needs CREATEDB permission.
