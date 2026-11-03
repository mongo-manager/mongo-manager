import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { killByComment } from '../src/data/operations'
import { startMongo, type TestMongo } from './support/mongo'

let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo({ args: ['--setParameter', 'enableTestCommands=1'] })
})
afterAll(async () => {
  await mongo?.stop()
})

describe('killByComment', () => {
  it('interrupts a running operation tagged with the comment', async () => {
    const client = await MongoClient.connect(`mongodb://127.0.0.1:${mongo.port}/`)
    const started = Date.now()
    const sleeping = client
      .db('admin')
      .command({ sleep: 1, secs: 10, lock: 'none', comment: 'mm:t-1' })
      .then(
        () => 'finished',
        (e: { codeName?: string }) => e.codeName,
      )
    await new Promise((r) => setTimeout(r, 300))
    expect(await killByComment(client, 'mm:t-1')).toBe(1)
    expect(await sleeping).toBe('Interrupted')
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(await killByComment(client, 'mm:nothing')).toBe(0)
    await client.close()
  })
})
