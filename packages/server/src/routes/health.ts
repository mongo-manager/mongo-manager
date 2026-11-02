import type { FastifyInstance } from 'fastify'

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }))
  app.get('/readyz', async () => {
    app.ctx.store.db.prepare('SELECT 1').get()
    return { status: 'ready' }
  })
}
