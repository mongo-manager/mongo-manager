// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema } from '@mongo-manager/shared'
import { JobRepo } from '../src/jobs/repo'
import { JobRunner } from '../src/jobs/runner'
import type { JobKind } from '../src/jobs/types'
import { makeApp, type TestApp } from './helpers'

const apps: TestApp[] = []
const runners: JobRunner[] = []
afterEach(async () => {
  for (const r of runners.splice(0)) r.close()
  for (const t of apps.splice(0)) await t.close()
})

async function setup() {
  const t = await makeApp()
  apps.push(t)
  const connection = (name: string) =>
    t.app.ctx.connections.create(
      {
        name,
        favorite: false,
        readOnly: false,
        settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1' }] }),
      },
      null,
    ).id
  const a = connection('a')
  const b = connection('b')
  const user = (name: string) =>
    t.app.ctx.users.create({ username: name, passwordHash: 'x', role: 'editor' }).id
  const repo = new JobRepo(t.app.ctx.store.db)
  const held: string[] = []
  const runner = new JobRunner({
    repo,
    now: () => Date.now(),
    hold: (id) => {
      held.push(id)
      return () => void held.splice(held.indexOf(id), 1)
    },
    describe: (e) => String(e),
  })
  runners.push(runner)
  return { a, b, user, repo, runner, held }
}

const hanging = (): JobKind<null> => ({
  name: 'data.copy',
  run: () => new Promise<void>(() => undefined),
  cancel: async () => true,
  recover: () => 'interrupted',
})

describe('jobs on two connections (phase 3d-2)', () => {
  it('holds both connections while the job runs, and stores the target connection', async () => {
    const { a, b, runner, held, repo } = await setup()
    let release!: () => void
    const kind: JobKind<null> = {
      name: 'data.copy',
      run: () => new Promise<void>((r) => (release = r)),
      cancel: async () => true,
      recover: () => 'interrupted',
    }
    const job = runner.start(
      kind,
      { userId: null, connectionId: a, targetConnectionId: b, db: 'd', coll: 'c', target: 't' },
      null,
    )
    expect([...held].sort()).toEqual([a, b].sort())
    expect(repo.get(job.id)!.targetConnectionId).toBe(b)
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(held).toEqual([])
  })

  it('counts a job on both connections toward the per-connection limit', async () => {
    const { a, b, user, runner } = await setup()
    for (let i = 0; i < 4; i++)
      runner.start(
        hanging(),
        { userId: user(`u${i}`), connectionId: a, targetConnectionId: b, db: 'd', coll: 'c', target: 't' },
        null,
      )
    expect(() =>
      runner.start(hanging(), { userId: user('x'), connectionId: b, db: 'd', coll: 'c', target: 't' }, null),
    ).toThrow(/already running on this connection/)
  })

  it('finds staging by the connection it lives on, falling back to the job connection', async () => {
    const { a, b, runner } = await setup()
    const kind: JobKind<null> = {
      name: 'data.copy',
      run: async (ctx) => ctx.setStaging('mm_copy_0123456789abcdef', { connectionId: b, db: 'target' }),
      cancel: async () => true,
      recover: () => 'interrupted',
    }
    const job = runner.start(
      kind,
      { userId: null, connectionId: a, targetConnectionId: b, db: 'd', coll: 'c', target: 't' },
      null,
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(runner.withStaging(b).map((j) => [j.id, j.staging, j.stagingDb])).toEqual([
      [job.id, 'mm_copy_0123456789abcdef', 'target'],
    ])
    expect(runner.withStaging(a)).toEqual([])
    runner.forgetStaging(job.id)
    expect(runner.withStaging(b)).toEqual([])
  })
})
