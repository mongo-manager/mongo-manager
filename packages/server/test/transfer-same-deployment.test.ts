import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { compareDeployments, deploymentOf } from '../src/transfer/same-deployment'
import { slow } from './support/slowness'

let a: TestMongo
let b: TestMongo
beforeAll(async () => {
  ;[a, b] = await Promise.all([startMongo(), startMongo()])
}, slow(180_000))
afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop()])
})

const open = (host: string, port: number) => new MongoClient(`mongodb://${host}:${port}`).connect()

describe('same deployment (phase 3d-2 spec §5.5)', () => {
  it('two connections to one process are the same deployment, whatever the host name', async () => {
    const [x, y, z] = await Promise.all([
      open('127.0.0.1', a.port),
      open('localhost', a.port),
      open('127.0.0.1', b.port),
    ])
    try {
      const [dx, dy, dz] = await Promise.all([deploymentOf(x), deploymentOf(y), deploymentOf(z)])
      expect(dx.kind).toBe('standalone')
      expect(dx.processId).toBeTruthy()
      expect(compareDeployments(dx, dy)).toBe('same')
      expect(compareDeployments(dx, dz)).toBe('different')
    } finally {
      await Promise.all([x.close(), y.close(), z.close()])
    }
  })

  it('classifies replica sets and mongos by name, hosts and cluster id', () => {
    const rs = (setName: string, hosts: string[]) => ({ kind: 'replicaSet' as const, setName, hosts })
    expect(compareDeployments(rs('rs0', ['h1:1', 'h2:1']), rs('rs0', ['h2:1']))).toBe('same')
    expect(compareDeployments(rs('rs0', ['h1:1']), rs('rs1', ['h1:1']))).toBe('different')
    expect(compareDeployments(rs('rs0', ['h1:1']), rs('rs0', ['h9:1']))).toBe('unknown')
    // Phase 3e-2: the set's own id, where it can be read, decides (two "rs0" sets are told apart).
    const id = (replicaSetId: string, hosts: string[]) => ({ ...rs('rs0', hosts), replicaSetId })
    expect(compareDeployments(id('a', ['h1:1']), id('b', ['h9:1']))).toBe('different')
    expect(compareDeployments(id('a', ['h1:1']), id('a', ['h9:1']))).toBe('same')
    expect(compareDeployments(id('a', ['h1:1']), rs('rs0', ['h9:1']))).toBe('unknown')
    expect(compareDeployments({ kind: 'mongos', clusterId: 'c1' }, { kind: 'mongos', clusterId: 'c1' })).toBe(
      'same',
    )
    expect(compareDeployments({ kind: 'mongos' }, { kind: 'mongos', clusterId: 'c1' })).toBe('unknown')
    expect(compareDeployments({ kind: 'mongos', clusterId: 'c1' }, rs('rs0', ['h1:1']))).toBe('unknown')
    expect(compareDeployments({ kind: 'standalone', processId: 'p' }, rs('rs0', ['h1:1']))).toBe('different')
  })
})
