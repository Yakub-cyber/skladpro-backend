import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DbPool } from '../db.js'
import { CancellationBody } from '../services/cancellationsV2.js'
import { Errors } from '../lib/errors.js'
import { reconcileStock } from '../services/stockReconcile.js'

const id = z.string().min(1).max(128)
const legacyCommand = z.object({
	commandId: id,
	kind: z.enum(['sale', 'doc_post', 'order_status', 'return_v2']),
	idempotencyKey: z.string().min(1).max(200),
	payload: z.record(z.unknown()),
}).strict()
const cancellationCommand = z.object({
 commandId: id, kind: z.literal('order_cancel'), orderId: z.string().regex(/^[\w:.-]{1,64}$/),
 idempotencyKey: z.string().min(1).max(200), payload: CancellationBody,
}).strict().superRefine((c, ctx) => {
 if(c.commandId !== `cancelled:${c.payload.shipmentId}` || c.idempotencyKey !== c.commandId)
  ctx.addIssue({code:'custom',message:'ÕÂ‚ÂÌ‡ˇ Ë‰ÂÌÚË˜ÌÓÒÚ¸ ÓÚÏÂÌ˚'})
})
const command = z.union([legacyCommand, cancellationCommand])
export const StockReconcileBody = z.object({
	contractVersion: z.literal(1),
	requestId: z.string().uuid(),
	productIds: z.array(id).min(1).max(500),
	commands: z.array(command).max(500),
}).strict().superRefine((body, ctx) => {
	if (new Set(body.productIds).size !== body.productIds.length ||
		new Set(body.commands.map(c => c.commandId)).size !== body.commands.length) {
		ctx.addIssue({ code: 'custom', message: '–ü–æ–≤—Ç–æ—Ä—è—é—â–∏–µ—Å—è productIds –∏–ª–∏ commandId' })
	}
})
export type StockReconcileInput = z.infer<typeof StockReconcileBody>

export function registerStockRoutes(app: FastifyInstance, pool: DbPool) {
	app.post('/v1/stock/reconcile', { preHandler: app.authenticate, bodyLimit: 256 * 1024 }, async (request, reply) => {
		reply.header('cache-control', 'no-store')
		if (request.auth.role === 'courier') throw Errors.forbidden('–°–∫–ª–∞–¥—Å–∫–∞—è —Å–≤–µ—Ä–∫–∞ –Ω–µ–¥–æ—Å—Ç—É–ø–Ω–∞ –∫—É—Ä—å–µ—Ä—É')
		const parsed = StockReconcileBody.safeParse(request.body)
		if (!parsed.success) throw Errors.validation(parsed.error.issues)
		return reconcileStock(pool, request.auth.companyId, parsed.data)
	})
}
