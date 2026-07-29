import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createPool } from './db.js'

const config = loadConfig()
const pool = createPool(config)
const app = await buildApp({ config, pool })

const shutdown = async (signal: string) => {
	app.log.info({ signal }, 'shutting down')
	await app.close()
	await pool.end()
	process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
	await app.listen({ port: config.PORT, host: config.HOST })
	app.log.info(`SkladPro API запущен на http://${config.HOST}:${config.PORT}`)
} catch (err) {
	app.log.error(err)
	process.exit(1)
}
