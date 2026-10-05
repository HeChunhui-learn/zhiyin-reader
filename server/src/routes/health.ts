import type { FastifyInstance } from 'fastify'
import { getDb } from '../db'

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    // 真正碰一下数据库，避免"服务活着但库连不上"这种假健康
    getDb().prepare('SELECT 1').get()
    return { ok: true, db: 'ok', time: new Date().toISOString() }
  })
}
