import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, type DataHarness } from './support/data'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const harnesses: DataHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.t.close()
})
async function harness(...args: Parameters<typeof dataHarness> extends [unknown, ...infer R] ? R : never) {
  const h = await dataHarness(mongo, ...args)
  harnesses.push(h)
  return h
}
const dbName = () => `d${randomUUID().slice(0, 8)}`

describe('database routes', () => {
  it('creates, lists, reports stats and drops a database', async () => {
    const h = await harness()
    const name = dbName()
    const created = await h.call('POST', '/databases', { name, collection: 'first' })
    expect(created.statusCode).toBe(201)
    const list = (await h.call('GET', '/databases')).json()
    expect(list.databases.map((d: { name: string }) => d.name)).toContain(name)
    expect(typeof list.totalSize).toBe('number')
    const stats = (await h.call('GET', `/databases/${name}/stats`)).json()
    expect(stats).toMatchObject({ collections: 1, objects: 0 })
    expect((await h.call('DELETE', `/databases/${name}`, { confirm: 'wrong' })).statusCode).toBe(400)
    expect((await h.call('DELETE', `/databases/${name}`, { confirm: name })).statusCode).toBe(204)
    expect(
      (await h.call('GET', '/databases')).json().databases.map((d: { name: string }) => d.name),
    ).not.toContain(name)
  })

  it('refuses invalid names and system database drops', async () => {
    const h = await harness()
    expect((await h.call('POST', '/databases', { name: 'a.b', collection: 'x' })).statusCode).toBe(400)
    expect((await h.call('DELETE', '/databases/admin', { confirm: 'admin' })).statusCode).toBe(400)
    expect((await h.call('GET', '/databases/a%2Fb/stats')).statusCode).toBe(400)
  })

  it('is read-only for read-only connections and audits drops with the namespace', async () => {
    const h = await harness()
    const name = dbName()
    await h.call('POST', '/databases', { name, collection: 'c' })
    h.t.app.ctx.connections.update(h.connectionId, { readOnly: true })
    const res = await h.call('DELETE', `/databases/${name}`, { confirm: name })
    expect(res.json().code).toBe('READ_ONLY')
    h.t.app.ctx.connections.update(h.connectionId, { readOnly: false })
    await h.call('DELETE', `/databases/${name}`, { confirm: name })
    const [entry] = h.t.app.ctx.audit.list({ action: 'databases.drop' })
    expect(entry).toMatchObject({ outcome: 'success', connectionId: h.connectionId, namespace: name })
  })
})
