// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import type { AiAgentStep, AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness, teamAdminHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn } from './support/agent'
import { waitJob } from './support/jobs'

/**
 * User request 2026-10-26: "back up the sales database and download it" — an agent's backup may be made
 * without a password, as a compressed archive, where its card offers that: never where the route
 * would refuse it (a destination that takes encrypted backups only), the person's own choice on the
 * card (never the model's), and said when it would hold personal data in clear.
 */
let mongo: TestMongo
let client: MongoClient
beforeAll(async () => {
  mongo = await startMongo()
  client = await new MongoClient(`mongodb://127.0.0.1:${mongo.port}`).connect()
})
afterAll(async () => {
  await client?.close()
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of closers.splice(0).reverse()) await c()
})

const PASSWORD = 'correct-horse-battery-1'

async function agent(harness: 'local' | 'team' = 'local', overrides: Record<string, unknown> = {}) {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h =
    harness === 'team'
      ? await teamAdminHarness(mongo, { ai: { privateNetworks: ['127.0.0.1/32'] }, ...overrides } as never)
      : await dataHarness(mongo, overrides as never)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  await inject('POST', 'ai/providers', { name: 'F', kind: 'openai', baseUrl: `${fake.url}/v1`, model: 'm' })
  await inject('PUT', 'me/ai-agent', { on: true })
  const db = `bp${randomUUID().slice(0, 8)}`
  await client
    .db(db)
    .collection('people')
    .insertMany([{ email: 'a@bp.test', n: 1 }, { n: 2 }])
  /** The card of a backup the model asks for, and the person's answer to it. */
  const card = async (args: Record<string, unknown>) => {
    const calls: FakeCall[] = [{ name: 'run_backup', args: { connection: 'Test', database: db, ...args } }]
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text: 'ok' })))
    const stream = await agentTurn(h.t.app, h.headers, { message: 'back it up' })
    const awaiting = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const decide = (body: object) =>
      inject('POST', `ai/agent/runs/${run}/decide`, { call: awaiting.step.id, ...body })
    return { step: awaiting.step, decide, stream }
  }
  return { h, fake, db, inject, card }
}

const toolSteps = (lines: AiChatLine[]) =>
  lines.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))

describe('a backup without a password, chosen on its card', () => {
  it('is offered beside the encrypted one, and made as a compressed archive with none', async () => {
    const { h, inject, card } = await agent()
    const asked = await card({})
    expect(asked.step.proposal).toMatchObject({ password: true, plain: { personal: false } })
    const answer = await asked.decide({ decision: 'confirm', plain: true })
    expect(answer.statusCode).toBe(200)
    const done = answer.json() as { summary: { job: string; format: string } }
    expect(done.summary).toMatchObject({ started: true, format: 'gzip' })
    await asked.stream.ended
    expect(await waitJob(h.t, done.summary.job, 7000)).toMatchObject({ state: 'done' })
    const kept = (await inject('GET', 'backups')).json() as Array<{ jobId: string | null; format: string }>
    expect(kept.find((b) => b.jobId === done.summary.job)?.format).toBe('gzip')
    // The decision's audit row says the person chose it.
    expect(h.t.app.ctx.audit.list({ action: 'ai.agent.decision' })[0]).toMatchObject({
      details: { plain: true, state: 'done' },
    })
    // The backup's own audit row says the format it was made in.
    expect(h.t.app.ctx.audit.list({ action: 'backup.dump.start' })[0]).toMatchObject({
      details: { format: 'gzip' },
    })
    // The model is told the format made.
    expect(toolSteps(asked.stream.lines).at(-1)).toMatchObject({ summary: { format: 'gzip' } })
  })

  it('still makes the encrypted one with its password', async () => {
    const { h, card } = await agent()
    const asked = await card({})
    expect((await asked.decide({ decision: 'confirm' })).json()).toMatchObject({
      details: { reason: 'password_required' },
    })
    const done = (await asked.decide({ decision: 'confirm', password: PASSWORD })).json() as {
      summary: { job: string; format: string }
    }
    expect(done.summary.format).toBe('mmbak')
    await waitJob(h.t, done.summary.job, 7000)
  })

  it('refuses a password beside it, and the choice where the card did not offer it', async () => {
    const { card } = await agent()
    const asked = await card({})
    expect(
      (await asked.decide({ decision: 'confirm', plain: true, password: PASSWORD })).json(),
    ).toMatchObject({ details: { reason: 'plain_with_password' } })
    await asked.decide({ decision: 'decline' })
    await asked.stream.ended
    // An archive asked for already has no password: nothing to choose.
    const archive = await card({ format: 'archive' })
    expect(archive.step.proposal).not.toHaveProperty('plain')
    expect((await archive.decide({ decision: 'confirm', plain: true })).json()).toMatchObject({
      details: { reason: 'no_plain_offer' },
    })
    await archive.decide({ decision: 'decline' })
  })

  it('is never offered where a destination takes encrypted backups only', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mm-agent-plain-'))
    const { inject, card } = await agent('local', { backup: { folderRoots: [base] } })
    const dest = await inject('POST', 'backup-destinations', {
      type: 'folder',
      name: 'Disk',
      config: { path: join(base, 'd1') },
    })
    expect(dest.statusCode).toBe(201)
    const asked = await card({ destinations: ['Disk'] })
    expect(asked.step.proposal).toMatchObject({ password: true })
    expect(asked.step.proposal).not.toHaveProperty('plain')
    await asked.decide({ decision: 'decline' })
  })

  it('says a backup without a password would hold personal data in clear', async () => {
    const { h, db, card } = await agent('team')
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    const asked = await card({})
    expect(asked.step.proposal).toMatchObject({ plain: { personal: true } })
    await asked.decide({ decision: 'decline' })
  })

  // Review (minor 4): where the route refuses it — a destination it may not leave for with personal data.
  it('is never offered where personal data may not leave for a destination unencrypted', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mm-agent-plain-'))
    const { h, db, inject, card } = await agent('team', { backup: { folderRoots: [base] } })
    const dest = await inject('POST', 'backup-destinations', {
      type: 'folder',
      name: 'Open disk',
      config: { path: join(base, 'd2') },
      policy: { encryptedOnly: false },
    })
    expect(dest.statusCode).toBe(201)
    // No personal data: offered.
    const before = await card({ destinations: ['Open disk'] })
    expect(before.step.proposal).toMatchObject({ plain: { personal: false } })
    await before.decide({ decision: 'decline' })
    await before.stream.ended
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    const after = await card({ destinations: ['Open disk'] })
    expect(after.step.proposal).not.toHaveProperty('plain')
    await after.decide({ decision: 'decline' })
  })

  // Review (minor 4): personal-data rules named between the card and the click — nothing made.
  it('makes nothing where the rules changed since its card', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mm-agent-plain-'))
    const { h, db, inject, card } = await agent('team', { backup: { folderRoots: [base] } })
    await inject('POST', 'backup-destinations', {
      type: 'folder',
      name: 'Open disk',
      config: { path: join(base, 'd3') },
      policy: { encryptedOnly: false },
    })
    const asked = await card({ destinations: ['Open disk'] })
    expect(asked.step.proposal).toHaveProperty('plain')
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    const answer = (await asked.decide({ decision: 'confirm', plain: true })).json() as { state: string }
    expect(answer.state).toBe('error')
    await asked.stream.ended
    expect(
      h.t.app.ctx.audit.list({ action: 'backup.dump.start' }).filter((r) => r.outcome === 'success'),
    ).toEqual([])
    expect((await inject('GET', 'backups')).json()).toEqual([])
  })

  // Review (minor 3): the second plan failing (a busy read, a timeout) offers none — the card stands.
  it('still offers the encrypted backup when its plan without a password fails', async () => {
    const { h, card } = await agent()
    const through = h.t.app.inject.bind(h.t.app) as (opts: unknown) => unknown
    h.t.app.inject = ((opts: unknown) => {
      const o = opts as { url?: string; payload?: unknown }
      if (String(o.url).includes('/backup/plan') && JSON.stringify(o.payload ?? '').includes('"gzip"'))
        return Promise.reject(new Error('busy'))
      return through(opts)
    }) as unknown as typeof h.t.app.inject
    const asked = await card({})
    expect(asked.step.proposal).toMatchObject({ password: true })
    expect(asked.step.proposal).not.toHaveProperty('plain')
    await asked.decide({ decision: 'decline' })
  })

  it('says none where the backup masks it (rules hide it from the person)', async () => {
    const { h, db, card } = await agent()
    h.t.app.ctx.personalFields.set(h.connectionId, [{ db, coll: 'people', field: 'email' }])
    const asked = await card({})
    expect(asked.step.proposal).toMatchObject({ plain: { personal: false } })
    await asked.decide({ decision: 'decline' })
  })
})
