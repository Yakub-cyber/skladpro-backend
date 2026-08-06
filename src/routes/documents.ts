import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { withTransaction } from '../db.js'
import { Errors } from '../lib/errors.js'
import { publishEvent } from '../services/events.js'
import { round4 } from '../lib/utils.js'
import { claimIdempotencyKey, storeIdempotentResponse } from '../lib/idempotency.js'
import { IdempotencyKey } from '../schemas/sale.js'
import { mapPgError } from '../lib/errors.js'

const id = z.string().min(1).max(64)

const DocItem = z.object({
	productId: id,
	name: z.string().max(300).optional(),
	qty: z.number().finite().min(0).max(1_000_000),
	cost: z.number().finite().min(0).optional(),
	unitId: id.optional(),
	unitFactor: z.number().finite().positive().optional(),
})

const DocumentBody = z.object({
	document: z.object({
		id: id,
		no: z.string().max(64).optional(),
		type: z.enum(['receive', 'writeoff', 'adjust']),
		items: z.array(DocItem).min(1).max(500),
		reason: z.string().max(500).optional(),
		note: z.string().max(2000).optional(),
		warehouseId: id.optional(),
		supplierId: id.optional(),
	}),
})

/**
 * POST /v1/documents/post — проводка складского документа.
 * Вставляет docs + doc_lines, вызывает post_doc(). Вся арифметика — в БД.
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

			const actor = auth.memberName ?? auth.email ?? auth.userId

			// Маппинг старых типов на новые doc_type
			let docType: string
			let partyKind: string | null = null
			let partyId: string | null = null

			if (doc.type === 'receive') {
				if (doc.supplierId) {
					docType = 'purchase_receipt'
					partyKind = 'supplier'
					partyId = doc.supplierId
				} else {
					docType = 'stock_income'
				}
			} else if (doc.type === 'writeoff') {
				docType = 'writeoff'
			} else {
				docType = 'inventory'
			}

			// Склад: из документа или первый активный
			let warehouseId = doc.warehouseId ?? null
			if (!warehouseId) {
				const { rows: whs } = await client.query(
					`select id from warehouses where company_id = $1 and deleted_at is null order by id limit 1`,
					[auth.companyId],
				)
				warehouseId = whs[0]?.id ?? null
			}

			await client.query(
				`insert into docs (company_id, id, doc_type, warehouse_id, party_kind, party_id, note, reason, "by")
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
				[auth.companyId, doc.id, docType, warehouseId, partyKind, partyId, doc.note ?? null, doc.reason ?? null, actor],
			)

			const items = [...doc.items].sort((a, b) => a.productId.localeCompare(b.productId))

			for (const [i, item] of items.entries()) {
				const factor = item.unitFactor ?? 1
				const qtyBase = round4(item.qty * factor)
				await client.query(
					`insert into doc_lines (company_id, id, doc_id, line_no, product_id, unit_id, unit_factor,
					                        qty_input, qty, price)
					 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
					[
						auth.companyId,
						`${doc.id}-${i}`,
						doc.id,
						i,
						item.productId,
						item.unitId ?? null,
						factor,
						item.qty,
						qtyBase,
						item.cost ?? 0,
					],
				)
			}

			let total: number
			try {
				const { rows } = await client.query('select post_doc($1,$2) as total', [auth.companyId, doc.id])
				total = Number(rows[0].total)
			} catch (err) {
				throw mapPgError(err)
			}

			// Совместимость: пишем в старую таблицу documents тоже
			await client.query(
				`insert into documents (company_id, id, no, type, status, items, reason, note, total_qty, "by", posted_at)
				 values ($1,$2,$3,$4,'posted',$5,$6,$7,$8,$9, now())
				 on conflict (company_id, id) do nothing`,
				[
					auth.companyId,
					doc.id,
					doc.no ?? null,
					doc.type,
					JSON.stringify(doc.items),
					doc.reason ?? null,
					doc.note ?? null,
					items.reduce((s, it) => s + it.qty, 0),
					actor,
				],
			)

			await client.query(
				`insert into audit (company_id, id, "by", title, section, type)
				 values ($1, $2, $3, $4, 'documents', $5)`,
				[auth.companyId, randomUUID(), actor, `Документ ${doc.type} №${doc.no ?? doc.id}`, doc.type],
			)

			const body = { ok: true, document: { id: doc.id, type: doc.type, total } }
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
