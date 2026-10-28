import { requirePermission } from '../lib/permissions.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { ApiError, Errors } from '../lib/errors.js'
import { IdempotencyKey } from '../schemas/sale.js'

const LegacyFinanceBody = z.object({
 amount: z.number().positive().finite().max(1_000_000_000),
 kind: z.enum(['payment', 'adjustment']),
 direction: z.enum(['decrease', 'increase']).optional(),
 note: z.string().max(500).optional(),
}).strict()
const CustomerIdParam = z.object({ id: z.string().min(1).max(64) })

/** Legacy finance has no permanent identity proof. Never execute or replay it. */
export function registerCustomerRoutes(app: FastifyInstance, pool: DbPool) {
 app.post('/v1/customers/:id/payments', { preHandler: app.authenticate }, async request => {
  const auth = request.auth
  requirePermission(auth.role, 'customerFinance')
  const key = IdempotencyKey.safeParse(request.headers['idempotency-key'])
  if (!key.success) throw Errors.validation(key.error.issues)
  const params = CustomerIdParam.safeParse(request.params)
  if (!params.success) throw Errors.validation(params.error.issues)
  const body = LegacyFinanceBody.safeParse(request.body)
  if (!body.success) throw Errors.validation(body.error.issues)
  // Retain company-scoped existence checks without entering a financial transaction.
  const customer = await pool.query('select id from customers where company_id=$1 and id=$2 and deleted_at is null', [auth.companyId,params.data.id])
  if (!customer.rowCount) throw Errors.notFound(`Клиент ${params.data.id}`)
  // Do not inspect/claim temporary keys, choose accounts, fence or mutate ledgers.
  const adjustment = body.data.kind === 'adjustment'
  throw new ApiError(422, adjustment ? 'LEGACY_CUSTOMER_ADJUSTMENT_REQUIRES_RECONCILIATION' : 'LEGACY_CUSTOMER_PAYMENT_REQUIRES_RECONCILIATION',
   adjustment ? 'Legacy-корректировка долга требует сверки; автоматическое проведение и повтор запрещены' : 'Legacy-платёж клиента требует сверки; автоматическое проведение и повтор запрещены')
 })
}
