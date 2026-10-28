import { requireKnownRole, requirePermission, requireAssignedDelivery } from '../lib/permissions.js'
import { cancellationV2 } from '../services/cancellationsV2.js'
import { lockCustomerFinances } from '../services/customerFinance.js'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { ApiError, Errors, mapPgError } from '../lib/errors.js'
import { publishEvent } from '../services/events.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey } from '../schemas/sale.js'
import { CommercialBody, commercialError, saveCommercial } from '../services/orderCommercial.js'
import { shipmentV2 } from '../services/shipmentsV2.js'
import { deliveryV2 } from '../services/deliveriesV2.js'

const StatusBody = z.object({
	status: z.enum(['new', 'confirmed', 'picking', 'packed', 'shipped', 'delivered', 'cancelled']),
})

const TRANSITIONS: Record<string, string[]> = {
	new: ['confirmed', 'picking', 'cancelled'],
	confirmed: ['picking', 'packed', 'cancelled'],
	picking: ['packed', 'shipped', 'cancelled'],
	packed: ['shipped', 'cancelled'],
	shipped: ['delivered', 'cancelled'],
	delivered: ['cancelled'],
	cancelled: [],
}


export function registerOrderRoutes(app: FastifyInstance, pool: DbPool) {
 for (const operation of ['create','replace'] as const) {
  app.route({ method: operation === 'create' ? 'POST' : 'PUT',
   url: operation === 'create' ? '/v1/orders' : '/v1/orders/:id/commercial',
   preHandler: app.authenticate, bodyLimit: 512 * 1024,
   handler: async (request, reply) => {
    requirePermission(request.auth.role, 'commercial')
    const parsed = CommercialBody.safeParse(request.body)
    if (!parsed.success) return commercialError('COMMERCIAL_INVALID','Некорректный коммерческий снимок',422)
    const body = parsed.data
    if ((operation === 'create' && body.expectedRowVersion !== undefined) ||
      (operation === 'replace' && (!body.expectedRowVersion || (request.params as {id:string}).id !== body.orderId)))
      commercialError('COMMERCIAL_INVALID','Некорректная версия или идентификатор заказа',422)
    const result = await withTransaction(pool, client => saveCommercial(client,request.auth.companyId,operation,body))
    if (result.replayed) reply.header('idempotency-replayed','true')
    return reply.code(result.status).send(result.body)
   },
  })
 }
	app.post('/v1/orders/:id/status', { preHandler: app.authenticate, bodyLimit: 512 * 1024 }, async (request, reply) => {
		const auth = request.auth
		const orderId = (request.params as { id: string }).id
        requireKnownRole(auth.role)
        const target = (request.body as {status?:unknown}|null)?.status
        if (target === 'cancelled') requirePermission(auth.role,'cancel')
        else if (target === 'delivered') requirePermission(auth.role,'delivery')
        else if (target === 'shipped' || target === 'picking' || target === 'packed') requirePermission(auth.role,'warehouse')
        else requirePermission(auth.role,'commercial')

		const keyParsed = IdempotencyKey.safeParse(request.headers['idempotency-key'])
		if (!keyParsed.success) throw Errors.validation(keyParsed.error.issues)
		const idemKey = keyParsed.data

  const version = (request.body as {contractVersion?:unknown}|null)?.contractVersion
  if (version !== undefined && version !== 1 && version !== 2)
   throw new ApiError(422,'ORDER_STATUS_VERSION_UNSUPPORTED','Неизвестная версия изменения статуса')
  if (version === 2) {
   let result
   try { result = (request.body as {status?:unknown}).status === 'cancelled'
     ? await cancellationV2(pool,auth,orderId,request.body,idemKey)
     : (request.body as {status?:unknown}).status === 'delivered'
     ? await deliveryV2(pool,auth,orderId,request.body,idemKey)
     : await shipmentV2(pool,auth,orderId,request.body,idemKey) }
   catch (error) { throw error instanceof Error && 'statusCode' in error ? error : mapPgError(error,request.log) }
   if (result.replayed) reply.header('idempotency-replayed','true')
   if (!result.replayed) publishEvent(pool,{companyId:auth.companyId,type:'order_status',id:orderId,senderUserId:auth.userId})
   return reply.code(result.status).send(result.body)
  }

		const parsed = StatusBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		const nextStatus = parsed.data.status
        // Legacy shipment has no sufficient permanent command proof. Keep its
        // former commercial-role requirement and deny before any transaction.
        if (nextStatus === 'shipped') {
          requirePermission(auth.role,'commercial')
          const marker = (await pool.query('select commercial_snapshot from orders where company_id=$1 and id=$2 and deleted_at is null',[auth.companyId,orderId])).rows[0]
          if (!marker) throw Errors.notFound(`Заказ ${orderId}`)
          if (marker.commercial_snapshot)
            commercialError('COMMERCIAL_ORDER_REQUIRES_SHIPMENT_V2','Защищённый заказ требует shipment v2')
          // No temporary-key claim, workflow change, write fence or posting on this path.
          throw new ApiError(422,'LEGACY_SHIPMENT_REQUIRES_RECONCILIATION','Legacy-отгрузка требует сверки; новое проведение запрещено')
        }

    // Gate protected legacy delivery/cancellation before temporary replay.
    // This non-locking type check does not invert temp-key -> order locking.
    if (nextStatus === 'cancelled') {
      const marker = (await pool.query(`select commercial_snapshot,
        exists(select 1 from order_commercial_commands c where c.company_id=$1 and c.order_id=orders.id) commercial_v2
        from orders where company_id=$1 and id=$2`, [auth.companyId,orderId])).rows[0]
      if (marker?.commercial_snapshot || marker?.commercial_v2)
        commercialError('COMMERCIAL_ORDER_REQUIRES_CANCELLATION_V2', 'Защищённый заказ требует cancelled v2')
    }
    if (nextStatus === 'delivered' && (await pool.query('select commercial_snapshot from orders where company_id=$1 and id=$2', [auth.companyId, orderId])).rows[0]?.commercial_snapshot)
      commercialError('COMMERCIAL_ORDER_REQUIRES_DELIVERY_V2', 'Защищённый заказ требует delivered v2')

		const result = await withTransaction(pool, async client => {
            if (auth.role === 'courier') {
              const assigned=(await client.query('select assigned_to from orders where company_id=$1 and id=$2 and deleted_at is null',[auth.companyId,orderId])).rows[0]
              await requireAssignedDelivery(client,auth,assigned?.assigned_to)
            }
			const claim = await claimIdempotencyKey(client, {
				key: idemKey,
				companyId: auth.companyId,
				endpoint: `POST /v1/orders/status`,
			})
			if (claim.replay) {
    // A reused shipment key must not masquerade as a workflow-only replay.
    if ((claim.response as {order?:{status?:unknown}}|null)?.order?.status === 'shipped')
      throw new ApiError(422,'LEGACY_SHIPMENT_REQUIRES_RECONCILIATION','Историческая legacy-отгрузка требует сверки')
    return { status: claim.status, body: claim.response, replayed: true }
   }

			const { rows } = await client.query(
				`select id, no, status, stock_consumed, items, returns, assigned_to,
				        on_credit, customer_id, commercial_snapshot
				 from orders
				 where company_id = $1 and id = $2 and deleted_at is null
				 for update`,
				[auth.companyId, orderId],
			)
			const order = rows[0]
			if (!order) throw Errors.notFound(`Заказ ${orderId}`)
   if (nextStatus === 'cancelled' && (order.commercial_snapshot || (await client.query('select 1 from order_commercial_commands where company_id=$1 and order_id=$2 limit 1',[auth.companyId,orderId])).rowCount))
    commercialError('COMMERCIAL_ORDER_REQUIRES_CANCELLATION_V2','Защищённый заказ требует cancelled v2')
   if (nextStatus === 'delivered' && order.commercial_snapshot)
    commercialError('COMMERCIAL_ORDER_REQUIRES_DELIVERY_V2','Защищённый заказ требует delivered v2')


            if (auth.role === 'courier') {
              await requireAssignedDelivery(client,auth,order.assigned_to)
              if (!(order.status === 'shipped' && nextStatus === 'delivered')) throw Errors.forbidden('Курьер может только отметить доставку своего заказа')
            }

			const allowed = TRANSITIONS[order.status] ?? []
			if (nextStatus === 'cancelled') {
				const refunds = await client.query(
					`select exists (select 1 from docs r where r.company_id=$1 and r.order_id=$2
					 and r.doc_type in ('sales_return','retail_return') and (r.status='posted'
					 or exists (select 1 from stock_movements m where m.company_id=$1 and m.doc_id=r.id)
					 or exists (select 1 from money_movements m where m.company_id=$1 and m.doc_id=r.id)
					 or exists (select 1 from settlement_movements m where m.company_id=$1 and m.doc_id=r.id))) as has_returns`,
					[auth.companyId, orderId],
				)
				if (refunds.rows[0]?.has_returns) throw Errors.saleHasPostedReturns()
   if (nextStatus === 'cancelled' && order.commercial_snapshot && (order.status === 'delivered' ||
     (await client.query("select 1 from order_lifecycle_commands where company_id=$1 and order_id=$2 and operation='delivered' limit 1",[auth.companyId,orderId])).rowCount))
    commercialError('DELIVERED_ORDER_CANCELLATION_FORBIDDEN','Доставленный защищённый заказ отменять нельзя; оформите возврат')
			}
			if (!allowed.includes(nextStatus))
				throw Errors.validation([{ message: `Переход ${order.status} → ${nextStatus} запрещён` }])

      if (nextStatus === 'cancelled' && order.stock_consumed) {
        // Historical order/customer markers need not match document parties.
        // Discover the complete set without document locks while holding the order.
        const parties = nextStatus === 'cancelled' ? (await client.query(`select distinct party_id from docs
          where company_id=$1 and order_id=$2 and status='posted'
          and doc_type in ('sales_shipment','retail_receipt') and party_kind='customer'`, [auth.companyId,orderId])).rows : []
        await lockCustomerFinances(client, auth.companyId, [order.customer_id === 'retail' ? null : order.customer_id, ...parties.map(p => p.party_id)])
      }

			const actor = auth.memberName ?? auth.email ?? auth.userId

			// cancelled после отгрузки: распроводим все документы по этому заказу
			if (nextStatus === 'cancelled' && order.stock_consumed) {
				const { rows: docRows } = await client.query(
					`select id from docs
					 where company_id = $1 and order_id = $2 and status = 'posted'
					   and doc_type in ('sales_shipment','retail_receipt')
					 for update`,
					[auth.companyId, orderId],
				)

				for (const d of docRows) {
					try {
						await client.query('select unpost_doc($1,$2)', [auth.companyId, d.id])
					} catch (err) {
						throw mapPgError(err, request.log)
					}
				}

				// unpost_doc ставит status='draft', но для отмены нужен 'void':
				// draft = «можно провести», void = «аннулирован, повторное проведение запрещено».
				if (docRows.length > 0) {
					await client.query(
						`update docs set status = 'void'
						 where company_id = $1 and order_id = $2 and status = 'draft'`,
						[auth.companyId, orderId],
					)
				}

				await client.query(`update orders set stock_consumed = false where company_id = $1 and id = $2`, [
					auth.companyId,
					orderId,
				])
			}

			await client.query(
				`update orders set status = $3,
				   track = coalesce(track, '[]'::jsonb) || $4::jsonb
				 where company_id = $1 and id = $2`,
				[
					auth.companyId,
					orderId,
					nextStatus,
					JSON.stringify([{ type: 'status', to: nextStatus, at: new Date().toISOString(), by: actor }]),
				],
			)

			await client.query(
				`insert into audit (company_id, id, "by", title, section, type)
				 values ($1, $2, $3, $4, 'orders', 'status')`,
				[auth.companyId, randomUUID(), actor, `Заказ №${order.no ?? orderId}: ${order.status} → ${nextStatus}`],
			)

			const body = { ok: true, order: { id: orderId, status: nextStatus } }
			await storeIdempotentResponse(client, auth.companyId, idemKey, 200, body)
			return { status: 200, body, replayed: false }
		})

		if (result.replayed) reply.header('idempotency-replayed', 'true')
		reply.code(result.status)
		if (!result.replayed) {
			publishEvent(pool, { companyId: auth.companyId, type: 'order_status', id: orderId, senderUserId: auth.userId })
		}
		return result.body
	})
}
