export type Batch = { id: string; qty: number; cost: number; at: string }

/**
 * Списание по FIFO: старые партии первыми; хвост без партий — по fallback-цене
 * (legacy-товары, заведённые до партионного учёта).
 */
export function consumeFifo(
	batches: Batch[],
	qty: number,
	fallbackCost: number,
): { batches: Batch[]; cogs: number } {
	const sorted = [...batches].sort((a, b) => String(a.at).localeCompare(String(b.at)))
	let remaining = qty
	let cogs = 0
	const rest: Batch[] = []
	for (const b of sorted) {
		if (remaining <= 1e-9) {
			rest.push(b)
			continue
		}
		const take = Math.min(b.qty, remaining)
		cogs += take * b.cost
		remaining = round4(remaining - take)
		if (b.qty - take > 1e-9) rest.push({ ...b, qty: round4(b.qty - take) })
	}
	if (remaining > 1e-9) cogs += remaining * fallbackCost
	return { batches: rest, cogs: round4(cogs) }
}

export function round4(n: number): number {
	return Math.round(n * 10000) / 10000
}
