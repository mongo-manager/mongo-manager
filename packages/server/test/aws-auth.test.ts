import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { clientSpec } from '../src/connections/client-spec'
import { AWS_KEYS_NEEDED, classifyError } from '../src/connections/errors'
import { slow } from './support/slowness'

// MONGODB-AWS through the real driver: the connection's keys are what it signs with, and the
// server's own AWS identity (here, keys in its environment) is never used.
describe('MONGODB-AWS sign-in', () => {
  let m: TestMongo
  const saved = { ...process.env }
  beforeAll(async () => {
    m = await startMongo()
    process.env.AWS_ACCESS_KEY_ID = 'AKIAHOSTOWN'
    process.env.AWS_SECRET_ACCESS_KEY = 'host-own-secret'
  }, slow(180_000))
  afterAll(async () => {
    process.env = saved
    await m?.stop()
  })

  async function attempt(auth: object): Promise<Error> {
    const settings = ConnectionSettingsSchema.parse({
      hosts: [{ host: '127.0.0.1', port: m.port }],
      directConnection: true,
      serverSelectionTimeoutMS: 5000,
    })
    const spec = clientSpec({ ...settings, auth } as never)
    const client = new MongoClient(spec.uri, spec.options)
    try {
      await client.connect()
      await client.db('admin').command({ ping: 1 })
      throw new Error('signed in')
    } catch (e) {
      return e as Error
    } finally {
      await client.close()
    }
  }

  it('reaches the server with the connection’s keys (it has no AWS sign-in, so it refuses)', async () => {
    const e = await attempt({ mechanism: 'MONGODB-AWS', username: 'AKIAEXAMPLE', password: 'secret' })
    // The driver accepted the keys and asked the server: not a refusal of the options, not a
    // missing package.
    expect(e.message).not.toMatch(/cannot be provided|Optional module|not found/i)
    expect(e.message).toMatch(/MONGODB-AWS|mechanism|Authentication/i)
  })

  it('never signs in with the host’s own AWS identity', async () => {
    const e = await attempt({ mechanism: 'MONGODB-AWS' })
    expect(e.message).toMatch(/access key ID and a secret access key/)
    // Said as a sign-in problem, in its own words.
    expect(classifyError(e)).toMatchObject({ kind: 'auth', message: AWS_KEYS_NEEDED })
  })
})
