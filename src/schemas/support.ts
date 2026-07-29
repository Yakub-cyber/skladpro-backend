import { z } from 'zod'

/**
 * Тикет клиентской поддержки: жалоба + автособранный клиентский контекст.
 * Сервер сохраняет как есть и отдаёт наружу в n8n; поля-JSON проходят
 * passthrough — не ломаем схему при добавлении новых полей на фронте.
 */
export const SupportTicketBody = z.object({
	// Свободный текст: минимум 10 символов, чтобы отсечь пустые жалобы;
	// максимум 2000 — реалистичная жалоба, защита от гигантского тела.
	description: z.string().trim().min(10, 'Опишите проблему подробнее (минимум 10 символов)').max(2000),
	// URL страницы, где случилось; hash-роутинг допустим.
	pageUrl: z.string().url().max(2048).optional(),
	pageTitle: z.string().max(300).optional(),
	// UA пишем свой (не из request.headers), чтобы клиент мог прислать
	// дополненную строку с версией сборки и билд-хэшем.
	userAgent: z.string().max(500).optional(),
	// Свободный контекст: sentryEventId, buildHash, viewport, breadcrumb,
	// последние console errors. passthrough — не роняем схему при новом поле.
	context: z
		.record(z.unknown())
		.default({})
		.refine(o => JSON.stringify(o).length <= 32 * 1024, {
			message: 'context не должен превышать 32 КБ',
		}),
})

export type SupportTicketBodyType = z.infer<typeof SupportTicketBody>

/**
 * Разрешённые статусы для PATCH со стороны n8n (см. 0005_support_tickets.sql).
 * received клиент выставить не может — это делает сам сервер при вставке.
 */
export const SupportTicketPatch = z.object({
	status: z.enum(['analyzing', 'pr_open', 'merged', 'rejected', 'failed']),
	prUrl: z.string().url().max(500).optional(),
	prNumber: z.number().int().positive().optional(),
	branchName: z.string().max(200).optional(),
	aiExplanation: z.string().max(4000).optional(),
	aiFilePath: z.string().max(500).optional(),
})

export type SupportTicketPatchType = z.infer<typeof SupportTicketPatch>

export type SupportTicketRow = {
	company_id: string
	id: string
	user_id: string
	description: string
	page_url: string | null
	page_title: string | null
	user_agent: string | null
	role_snapshot: string | null
	context: Record<string, unknown>
	status: 'received' | 'analyzing' | 'pr_open' | 'merged' | 'rejected' | 'failed'
	pr_url: string | null
	pr_number: number | null
	branch_name: string | null
	ai_explanation: string | null
	ai_file_path: string | null
	created_at: string
	updated_at: string
	deleted_at: string | null
}
