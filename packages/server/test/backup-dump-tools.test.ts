// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { MongoClient } from 'mongodb'
import { startMongo, type TestMongo } from './support/mongo'
import { backupHarness } from './support/backup'
import { waitJob } from './support/jobs'
import { mongoTools } from './support/mongo-tools'
import { dumpToolArgs } from '../src/backup/dump-plan'
import { openArchive } from '../src/backup/pipeline'
import { slow } from './support/slowness'

const tools = await mongoTools()
const PW = 'correct horse battery staple'

describe('tools engine arguments (B15)', () => {
  it('names namespaces with --nsInclude and leaves the system databases out', () => {
    expect(dumpToolArgs({ kind: 'collection', db: 'shop', coll: 'orders' }, [])).toEqual([
      '--db=shop',
      '--collection=orders',
    ])
    expect(dumpToolArgs({ kind: 'database', db: 'shop', views: true }, [])).toEqual(['--db=shop'])
    expect(
      dumpToolArgs({ kind: 'database', db: 'shop', collections: ['a', 'b'], views: true }, [
        { db: 'shop', coll: 'a' },
        { db: 'shop', coll: 'b' },
      ]),
    ).toEqual(['--nsInclude=shop.a', '--nsInclude=shop.b'])
    expect(dumpToolArgs({ kind: 'server' }, [])).toEqual([
      '--nsExclude=admin.*',
      '--nsExclude=config.*',
      '--nsExclude=local.*',
    ])
  })
})

describe('tools engine arguments follow the plan (final review minor 14)', () => {
  it('names each planned namespace when the plan leaves something out', () => {
    const pairs = [
      { db: 'shop', coll: 'a' },
      { db: 'shop', coll: 'b' },
    ]
    // Views left out, or a namespace the plan skipped: --db would dump them anyway.
    expect(dumpToolArgs({ kind: 'database', db: 'shop', views: false }, pairs, false)).toEqual([
      '--nsInclude=shop.a',
      '--nsInclude=shop.b',
    ])
    expect(dumpToolArgs({ kind: 'server' }, pairs, false)).toEqual([
      '--nsInclude=shop.a',
      '--nsInclude=shop.b',
    ])
    expect(dumpToolArgs({ kind: 'server', databases: ['shop'] }, pairs, false)).toEqual([
      '--nsInclude=shop.a',
      '--nsInclude=shop.b',
    ])
    // Nothing left out: the short form.
    expect(dumpToolArgs({ kind: 'database', db: 'shop', views: true }, pairs, true)).toEqual(['--db=shop'])
  })
})

describe.skipIf(!tools)('dump through mongodump (spec §5.3, B14)', () => {
  let a: TestMongo
  let b: TestMongo
  beforeAll(async () => {
    a = await startMongo({ auth: { user: 'root', password: 's3cr3t-pw' } })
    b = await startMongo()
  }, slow(180_000))
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()])
  })

  it('stops mongodump when the backup cannot be written any further (final review minor 8)', async () => {
    // About 40 MiB that gzip cannot shrink: planned at a third of that, it outgrows a 16 MiB quota.
    const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump), quotaMb: 16 } } as never)
    try {
      const rec = h.ctx.connections.get(h.ids.A)!
      h.ctx.connections.update(h.ids.A, {
        settings: {
          ...rec.settings,
          auth: { mechanism: 'SCRAM-SHA-256', username: 'root', password: 's3cr3t-pw', authSource: 'admin' },
        },
      } as never)
      const c = await new MongoClient(
        `mongodb://root:s3cr3t-pw@127.0.0.1:${a.port}/?authSource=admin`,
      ).connect()
      await c.db('big').dropDatabase()
      for (let i = 0; i < 40; i++)
        await c
          .db('big')
          .collection('r')
          .insertOne({ i, z: randomBytes(1024 * 1024) })
      await c.close()
      const children: ChildProcess[] = []
      h.ctx.backup.spawnImpl = ((bin: string, args: readonly string[], o: object) => {
        const child = spawn(bin, args, o as never)
        children.push(child)
        return child
      }) as typeof spawn
      const admin = h.user({ role: 'admin' })
      const body = { scope: { kind: 'database', db: 'big' }, engine: 'tools', format: 'gzip' }
      const plan = (await admin.call('POST', `/api/connections/${h.ids.A}/backup/plan`, body)).json()
      expect(plan.refusals).toEqual([])
      const res = await admin.call('POST', `/api/connections/${h.ids.A}/backup`, {
        ...body,
        planHash: plan.planHash,
      })
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      expect(job.state).toBe('failed')
      const tool = children.find((ch) => ch.spawnargs.some((x) => x.includes('mongodump')))!
      if (tool.exitCode === null && tool.signalCode === null) await once(tool, 'exit')
      // Killed, not run to its end.
      expect(tool.exitCode === 0).toBe(false)
      // Both tool slots are free again.
      h.ctx.backup.tools.acquire()()
      h.ctx.backup.tools.acquire()()
    } finally {
      await h.t.close()
    }
  }, 90_000)

  it('dumps with credentials only in the config file, then encrypts like a built-in dump', async () => {
    const h = await backupHarness(a, b, { backup: { toolsPath: dirname(tools!.dump) } } as never)
    try {
      const rec = h.ctx.connections.get(h.ids.A)!
      h.ctx.connections.update(h.ids.A, {
        settings: {
          ...rec.settings,
          auth: { mechanism: 'SCRAM-SHA-256', username: 'root', password: 's3cr3t-pw', authSource: 'admin' },
        },
      } as never)
      const c = await new MongoClient(
        `mongodb://root:s3cr3t-pw@127.0.0.1:${a.port}/?authSource=admin`,
      ).connect()
      await c
        .db('shop')
        .collection('orders')
        .insertMany([{ a: 1 }, { a: 2 }])
      await c.close()
      const seen: string[][] = []
      h.ctx.backup.spawnImpl = ((bin: string, args: readonly string[], o: object) => {
        seen.push([...args])
        return spawn(bin, args, o as never)
      }) as typeof spawn
      const admin = h.user({ role: 'admin' })
      const base = `/api/connections/${h.ids.A}/backup`
      const body = { scope: { kind: 'database', db: 'shop' }, engine: 'tools', format: 'mmbak' }
      const plan = (await admin.call('POST', `${base}/plan`, body)).json()
      expect(plan.refusals).toEqual([])
      expect(plan.tools).toMatchObject({ available: true, version: '100.19.1' })
      const res = await admin.call('POST', base, { ...body, planHash: plan.planHash, password: PW })
      expect(res.statusCode, res.body).toBe(202)
      const job = await waitJob(h.t, res.json().job.id, 60_000)
      const report = (await admin.get(`/api/transfer/jobs/${job.id}/report`)).json()
      expect(job.state, JSON.stringify(report)).toBe('done')
      expect(seen.flat().join(' ')).not.toContain('s3cr3t-pw')
      const configArg = seen.flat().find((x) => x.startsWith('--config='))!
      expect(existsSync(configArg.slice('--config='.length))).toBe(false)
      expect(report).toMatchObject({ engine: 'tools', format: 'mmbak' })
      expect(report.namespaces.find((n: { coll: string }) => n.coll === 'orders').written).toBe(2)
      expect(JSON.stringify(report.toolLog ?? [])).not.toContain('s3cr3t-pw')
      // The file is ours: encrypted, and it holds mongodump's archive.
      const row = h.ctx.backup.store.get(admin.id, report.backupId)!
      const { events } = await openArchive(h.ctx.backup.store, row, {
        password: PW,
        signal: new AbortController().signal,
        follow: 'complete',
      })
      let docs = 0
      for await (const e of events) if (e.kind === 'doc' && e.coll === 'orders') docs++
      expect(docs).toBe(2)
    } finally {
      await h.t.close()
    }
  }, 90_000)
})
