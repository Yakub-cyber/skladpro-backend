import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors } from '../lib/errors.js'
import { publishEvent } from '../services/events.js'
import { consumeFifo, round4 } from '../lib/fifo.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey } from '../schemas/sale.js'

const id = z.string().min(1).max(64)

const DocItem = z.object({
	productId: id,
	name: z.string().max(300).optional(),
	qty: z.number().finite().min(0).max(1_000_000),
	cost: z.number().finite().min(0).optional(),
})

const DocumentBody = z.object({
	document: z.object({
		id: id,
		no: z.string().max(64).optional(),
		// receive — приход (+stock, пересчёт себестоимости, новая FIFO-партия)
		// writeoff — списание (−stock c проверкой остатка)
		// adjust — инвентаризация (stock := qty)
		type: z.enum(['receive', 'writeoff', 'adjust']),
		items: z.array(DocItem).min(1).max(500),
		reason: z.string().max(500).optional(),
		note: z.string().max(2000).optional(),
	}),
})

const MOVEMENT_TYPE: Record<string, string> = {
	receive: 'receive',
	writeoff: 'writeoff',
	adjust: 'inventory',
}

/**
 * POST /v1/documents/post — проводка складского документа.
 * Атомарно: блокировка товаров, изменение остатков, партии FIFO (для прихода),
 * запись документа + движений + аудита. Idempotency-Key обязателен.
 */
export function registerDocumentRoutes(app: FastifyInstance, pool: DbPool) {
	app.post('/v1/documents/post', { preHandler: app.authenticate }, async (request, reply) => {
		const auth = request.auth
		if (auth.role === 'courier') throw Errors.forbidden('Курьеру проводка недоступна')

		const keyParsed = IdempotencyKey.safeParse(request.headers['idempotency-key'])
		if (!keyParsed.success) throw Errors.validation(keyParsed.error.issues)
		const idemKey = keyParsed.data

		const bodyParsed = DocumentBody.safeParse(request.body)
		if (!bodyParsed.success) throw Errors.validation(bodyParsed.error.issues)
		const doc = bodyParsed.data.document

		const result = await withTransaction(pool, async client => {
			const claim = await claimIdempotencyKey(client, {
				key: idemKey,
				companyId: auth.companyId,
				endpoint: 'POST /v1/documents/post',
			})
			if (claim.replay) return { status: claim.status, body: claim.response, replayed: true }

			const items = [...doc.items].sort((a, b) => a.productId.localeCompare(b.productId))
			const actor = auth.memberName ?? auth.email ?? auth.userId
			const movements: Array<{ productId: string; name: string; qty: number; delta: number; cost: number | null }> = []
			let totalQty = 0

			for (const item of items) {
				const { rows } = await client.query(
					`select id, name, stock, cost, batches from products
					 where company_id = $1 and id = $2 and deleted_at is null
					 for update`,
					[auth.companyId, item.productId],
				)
				const p = rows[0]
				if (!p) throw Errors.notFound(`Товар ${item.productId}`)
				const stock = Number(p.stock ?? 0)
				const cost = Number(p.cost ?? 0)
				const batches: Array<{ id: string; qty: number; cost: number; at: string }> = Array.isArray(p.batches)
					? p.batches
					: []

				if (doc.type === 'receive') {
					if (item.qty <= 0) throw Errors.validation([{ message: `Приход ${item.productId}: qty должен быть > 0` }])
					const newCost = item.cost ?? cost
					// Средневзвешенная себестоимость + новая FIFO-партия.
					const nextCost = stock + item.qty > 0 ? round4((stock * cost + item.qty * newCost) / (stock + item.qty)) : newCost
					batches.push({ id: randomUUID(), qty: item.qty, cost: newCost, at: new Date().toISOString() })
					await client.query(
						`update products set stock = stock + $3, cost = $4, batches = $5
						 where company_id = $1 and id = $2`,
						[auth.companyId, item.productId, item.qty, nextCost, JSON.stringify(batches)],
					)
					movements.push({ productId: item.productId, name: item.name ?? p.name, qty: item.qty, delta: item.qty, cost: newCost })
					totalQty += item.qty
				} else if (doc.type === 'writeoff') {
					if (item.qty <= 0) throw Errors.validation([{ message: `Списание ${item.productId}: qty должен быть > 0` }])
					if (stock + 1e-6 < item.qty) throw Errors.insufficientStock(item.productId, stock, item.qty)
					const consumed = consumeFifo(batches, item.qty, cost)
					await client.query(
						`update products set stock = stock - $3, batches = $4
						 where company_id = $1 and id = $2`,
						[auth.companyId, item.productId, item.qty, JSON.stringify(consumed.batches)],
					)
					movements.push({ productId: item.productId, name: item.name ?? p.name, qty: item.qty, delta: -item.qty, cost: consumed.cogs })
					totalQty += item.qty
				} else {
					// adjust: item.qty — НОВЫЙ фактический остаток.
					const delta = round4(item.qty - stock)
					if (Math.abs(delta) < 1e-9) continue
					const nextBatches =
						delta > 0
							? [...batches, { id: randomUUID(), qty: delta, cost, at: new Date().toISOString() }]
							: consumeFifo(batches, -delta, cost).batches
					await client.query(
						`update products set stock = $3, batches = $4 where company_id = $1 and id = $2`,
						[auth.companyId, item.productId, item.qty, JSON.stringify(nextBatches)],
					)
					movements.push({ productId: item.productId, name: item.name ?? p.name, qty: Math.abs(delta), delta, cost: null })
					totalQty += Math.abs(delta)
				}
			}

			const insertedDoc = await client.query(
				`insert into documents (company_id, id, no, type, status, items, reason, note, total_qty, "by", posted_at)
				 values ($1,$2,$3,$4,'posted',$5,$6,$7,$8,$9, now())
				 on conflict (company_id, id) do nothing
				 returning id`,
				[
					auth.companyId,
					doc.id,
					doc.no ?? null,
					doc.type,
					JSON.stringify(doc.items),
					doc.reason ?? null,
					doc.note ?? null,
					totalQty,
					actor,
				],
			)
			if (insertedDoc.rows.length === 0) throw Errors.duplicate(`Документ ${doc.id}`)

			for (const m of movements) {
				await client.query(
					`insert into movements (company_id, id, type, product_id, name, qty, delta, cost, reason, "by")
					 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
					[
						auth.companyId,
						randomUUID(),
						MOVEMENT_TYPE[doc.type],
						m.productId,
						m.name,
						m.qty,
						m.delta,
						m.cost,
						doc.reason ?? `Документ №${doc.no ?? doc.id}`,
						actor,
					],
				)
			}

			await client.query(
				`insert into audit (company_id, id, "by", title, section, type)
				 values ($1, $2, $3, $4, 'documents', $5)`,
				[auth.companyId, randomUUID(), actor, `Документ ${doc.type} №${doc.no ?? doc.id}`, doc.type],
			)

			const body = { ok: true, document: { id: doc.id, type: doc.type, totalQty, movements: movements.length } }
			await storeIdempotentResponse(client, auth.companyId, idemKey, 201, body)
			return { status: 201, body, replayed: false }
		})

		if (result.replayed) reply.header('idempotency-replayed', 'true')
		reply.code(result.status)
		if (!result.replayed) {
			publishEvent(pool, { companyId: auth.companyId, type: 'document', id: bodyParsed.data.document.id, senderUserId: auth.userId })
		}
		return result.body
	})
}

