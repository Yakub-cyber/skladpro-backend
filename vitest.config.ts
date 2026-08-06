import { defineConfig } from 'vitest/config'

/**
 * Два вида тестов:
 *   test/*.test.ts            — юнит-тесты на фейковом пуле, быстрые, без базы.
 *   test/integration/*.test.ts — интеграционные, на ЖИВОМ PostgreSQL.
 *
 * Интеграционные запускаются, только если задан TEST_DATABASE_URL:
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:5432/skladpro_test npm test
 *
 * Без переменной они сами себя пропускают, поэтому обычный `npm test`
 * на машине без базы не краснеет.
 */
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// Интеграционные тесты трогают одни и те же таблицы — параллелить нельзя.
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
})
