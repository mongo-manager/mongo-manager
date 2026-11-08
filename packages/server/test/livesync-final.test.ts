// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { makeApp, type TestApp } from './helpers'
import { closesLoop, type SyncNode } from '../src/livesync/plan'
import { pipelineFor } from '../src/livesync/runner'
import { targetOf } from '../src/livesync/worker'
import { errorTextFor } from '../src/livesync/checks'
import { sourceReadOptions } from '../src/transfer/copy-job'
import type { LiveSyncRecord } from '../src/livesync/repo'

/** Final review fixes that need no MongoDB (phase 3e-2). */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('I2: a live sync’s initial copy reads where T0 was read', () => {
  it('reads the source from its primary, whatever the connection prefers', () => {
    expect(sourceReadOptions({ primaryReads: true })).toMatchObject({ readPreference: 'primary' })
    expect(sourceReadOptions({})).not.toHaveProperty('readPreference')
  })
})

describe('I6: loops between deployments known by different means', () => {
  const rs = (hosts: string[], replicaSetId?: string) => ({
    kind: 'replicaSet' as const,
    setName: 'rs0',
    hosts,
    ...(replicaSetId ? { replicaSetId } : {}),
  })
  const node = (deployment: SyncNode['deployment'], db: string, coll: string | null = null): SyncNode => ({
    deployment,
    db,
    coll,
  })

  it('sees a loop when one side may read the set’s id and the other knows it by another hostname', () => {
    const a1 = rs(['10.0.0.1:27017'], 'x')
    const a2 = rs(['db.example:27017'])
    const b = rs(['other:27017'], 'y')
    // B → A (known by its id) runs; A (known by a hostname) → B closes a loop.
    expect(
      closesLoop([{ source: node(b, 'shop'), target: node(a1, 'shop') }], node(a2, 'shop'), node(b, 'shop')),
    ).toBe(true)
    // Two sets told apart by their ids never overlap.
    expect(
      closesLoop(
        [{ source: node(rs(['q:1'], 'z'), 'shop'), target: node(a1, 'shop') }],
        node(a1, 'shop'),
        node(b, 'shop'),
      ),
    ).toBe(false)
  })
})

describe('I3, I8: the change stream a database sync reads', () => {
  const record = (followNew: boolean) =>
    ({
      source: { db: 'shop', coll: null },
      options: { followNew, pairs: [['one', 'one']] },
    }) as unknown as LiveSyncRecord

  it('drops what it never uses, and sees renames onto its collections', () => {
    expect(pipelineFor(record(false))).toEqual([
      {
        $match: {
          $or: [
            { 'ns.coll': { $in: ['one'] } },
            { 'to.coll': { $in: ['one'] } },
            { operationType: { $in: ['dropDatabase', 'invalidate'] } },
          ],
        },
      },
      { $project: { updateDescription: 0 } },
    ])
    expect(pipelineFor(record(true))).toEqual([{ $project: { updateDescription: 0 } }])
  })
})

describe('m13: verify’s errors hide MongoDB’s words from an owner restricted on either side', () => {
  it('says only the code when the owner may not see personal data on one side', async () => {
    const t = await makeApp({ auth: true })
    apps.push(t)
    const { ctx } = t.app
    const conn = (name: string) =>
      ctx.connections.create(
        {
          name,
          favorite: false,
          readOnly: false,
          settings: ConnectionSettingsSchema.parse({ hosts: [{ host: 'h', port: 1 }] }),
        },
        null,
      ).id
    const [a, b] = [conn('A'), conn('B')]
    const owner = ctx.users.create({ username: 'o', passwordHash: 'x', role: 'editor' })
    // Restricted on the source only: a verify error from either side keeps MongoDB's words back.
    ctx.grants.set(a, owner.id, 'editor')
    ctx.grants.setMasked(a, owner.id, true)
    const r = {
      owner: owner.id,
      source: { connectionId: a },
      target: { connectionId: b },
    } as unknown as LiveSyncRecord
    expect(errorTextFor(ctx, r, 'either', { code: 11000, errmsg: 'dup key: { email: "a@x" }' })).toBe(
      'code 11000',
    )
  })
})

describe('m12: a database sync that follows new collections leaves the server’s own aside', () => {
  it('follows no aggregation’s temporary collection', () => {
    const r = {
      source: { db: 'shop', coll: null },
      target: { db: 'copy' },
      options: { followNew: true, pairs: [] },
    } as unknown as LiveSyncRecord
    expect(targetOf(r, 'shop', 'tmp.agg_out.0f3c')).toBeNull()
    expect(targetOf(r, 'shop', 'orders')).toEqual({ db: 'copy', coll: 'orders' })
  })

  // Security audit 2026-10-16 (Important 4): file contents cannot be masked; a masked sync never
  // follows a GridFS bucket that appears later, as its plan never carries one.
  it('a masked sync follows no new GridFS bucket; an unmasked one does', () => {
    const r = (masked: boolean) =>
      ({
        source: { db: 'shop', coll: null },
        target: { db: 'copy' },
        options: { followNew: true, pairs: [], masked },
      }) as unknown as LiveSyncRecord
    // Withheld where the checks withhold file contents (user report 2026-10-27: a bucket a rule reaches).
    const ruled = (_db: string, coll: string) => coll.endsWith('.chunks') || coll.endsWith('.files')
    for (const coll of ['fs.chunks', 'fs.files', 'photos.chunks', 'photos.files']) {
      expect(targetOf(r(true), 'shop', coll, ruled)).toBeNull()
      expect(targetOf(r(false), 'shop', coll)).toEqual({ db: 'copy', coll })
      // Independent review (minor): masked with no rule reaching it — carried.
      expect(targetOf(r(true), 'shop', coll, () => false)).toEqual({ db: 'copy', coll })
    }
    expect(targetOf(r(true), 'shop', 'orders', ruled)).toEqual({ db: 'copy', coll: 'orders' })
  })
})
