import { createHash } from 'node:crypto'
import type pg from 'pg'

// Two-int advisory space is distinct from all existing one-bigint locks.
export const CUSTOMER_FINANCE_NAMESPACE = 0x53465031 // SFP1
export function customerFinanceKey(companyId: string, customerId: string) {
  return createHash('sha256').update(JSON.stringify([companyId, customerId])).digest().readInt32BE(0)
}

/** Call once with the complete party set, after order locks, before accounting locks.
 * All lock keys are sorted, including possible hash collisions. Dedicated fence
 * rows make stale RR/SERIALIZABLE snapshots fail with 40001 after a waiter wakes.
 * Do not fence customers themselves: leave catalogue versions and locks unchanged.
 */
export async function lockCustomerFinances(client: pg.PoolClient, companyId: string, customerIds: (string | null | undefined)[]) {
  const ids = [...new Set(customerIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].sort()
  const keys = [...new Set(ids.map(id => customerFinanceKey(companyId, id)))].sort((a,b) => a-b)
  for (const key of keys) await client.query('select pg_advisory_xact_lock($1::integer,$2::integer)', [CUSTOMER_FINANCE_NAMESPACE, key])
  for (const id of ids) await client.query(`insert into customer_financial_fences(company_id,customer_id,revision) values($1,$2,1)
    on conflict(company_id,customer_id) do update set revision=customer_financial_fences.revision+1`, [companyId,id])
}
