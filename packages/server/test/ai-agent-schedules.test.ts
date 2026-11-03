import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RETENTION_PRESETS,
  ScheduleInputSchema,
  type AiAgentStep,
  type AiChatLine,
} from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf } from './support/agent'

/**
 * The AI database manager (design 2026-10-25, B1): the person's own schedules from the chat — listed,
 * run now, paused, resumed, changed (the removals a retention change makes confirmed as the route
 * asks) and deleted (the name typed), each change a card, each through the schedule routes.
 */
let mongo: TestMongo
beforeAll(async () => {
  mongo = await startMongo()
})
afterAll(async () => {
  await mongo?.stop()
})
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of closers.splice(0).reverse()) await c()
})

const steps = (out: AiChatLine[]) =>
  out.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))

async function withSchedule() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const base = mkdtempSync(join(tmpdir(), 'mm-agent-b1-'))
  const h = await dataHarness(mongo, { backup: { folderRoots: [base] } } as never)
  closers.push(h.t.close)
  const db = `b1${randomUUID().slice(0, 8)}`
  const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  const provider = await inject('POST', 'ai/providers', {
    name: 'Fake',
    kind: 'openai',
    baseUrl: `${fake.url}/v1`,
    model: 'm',
  })
  expect(provider.statusCode).toBeLessThan(300)
  await inject('PUT', 'me/ai-agent', { on: true })
  const dest = (
    await inject('POST', 'backup-destinations', {
      type: 'folder',
      name: 'Disk',
      config: { path: join(base, 'd1') },
      policy: { encryptedOnly: false },
    })
  ).json().id as string
  const input = {
    name: 'Weekly',
    connectionId: h.connectionId,
    dump: { scope: { kind: 'database', db } },
    format: 'archive',
    cadence: { kind: 'weekly', days: [1], time: '03:00' },
    timeZone: 'Europe/Istanbul',
    destinations: [dest],
    retention: { last: 50, daily: 0, weekly: 0, monthly: 0 },
  }
  const made = await inject('POST', 'backup-schedules', input)
  expect(made.statusCode).toBe(201)
  const schedule = made.json() as { id: string; owner: { id: string } }
  const once = (calls: FakeCall[], text = 'ok') =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text })))
  const turn = async (message: string) =>
    (await inject('POST', 'ai/agent', { message })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
  const told = () => {
    const r = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
    return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)) as Record<string, unknown>
  }
  /** A change asked for, its card answered: what the card was, and how the decision ended. */
  const decide = async (calls: FakeCall[], decision: 'confirm' | 'decline', extra: object = {}) => {
    once(calls)
    const stream = await agentTurn(h.t.app, h.headers, { message: 'do it' })
    const card = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const res = await inject('POST', `ai/agent/runs/${run}/decide`, {
      call: card.step.id,
      decision,
      ...extra,
    })
    await stream.ended
    return { card: card.step, res, ended: steps(stream.lines).at(-1)! }
  }
  const current = async () =>
    ((await inject('GET', `backup-schedules`)).json() as { schedules: Array<Record<string, unknown>> })
      .schedules
  /** Copies of the schedule's backups at its destination, a minute apart. */
  const copies = (n: number) => {
    for (let i = 0; i < n; i++) {
      const copyId = randomUUID()
      const at = h.t.app.ctx.now() - i * 60_000
      h.t.app.ctx.store.db
        .prepare(
          `INSERT INTO backup_remote_copies (id, destination_id, backup_id, remote_key, owner, connection_id, meta, format,
            size, sha256, state, created_at, completed_at, schedule_id) VALUES (?, ?, NULL, ?, ?, NULL, ?, 'archive', 1, ?, 'complete', ?, ?, ?)`,
        )
        .run(
          copyId,
          dest,
          `mongo-manager/2026/01/mm-${copyId.slice(0, 8)}.archive`,
          schedule.owner.id,
          JSON.stringify({ startedAt: at }),
          'a'.repeat(64),
          at,
          at,
          schedule.id,
        )
    }
  }
  /** An answer the route refuses: the card still waits. */
  const pending = async (calls: FakeCall[]) => {
    once(calls)
    const stream = await agentTurn(h.t.app, h.headers, { message: 'do it' })
    const card = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const answer = (body: object) =>
      inject('POST', `ai/agent/runs/${run}/decide`, { call: card.step.id, ...body })
    return { card: card.step, answer, ended: () => stream.ended }
  }
  return { h, fake, db, dest, input, schedule, inject, once, turn, told, decide, current, copies, pending }
}

describe('the agent and the person’s own schedules (B1)', () => {
  it('lists the person’s own schedules — where, when, how they went — never another’s', async () => {
    const { h, db, input, once, turn, told } = await withSchedule()
    // Another person's, as an administrator would see it.
    h.t.app.ctx.backup.schedules.create({
      ...ScheduleInputSchema.parse({ ...input, name: 'Theirs' }),
      owner: randomUUID(),
      keyId: null,
      nextRunAt: null,
    })
    once([{ name: 'list_schedules', args: {} }])
    const out = await turn('my schedules?')
    expect(steps(out)[0]).toMatchObject({ tool: 'list_schedules', state: 'done', summary: { schedules: 1 } })
    const list = told().schedules as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      name: 'Weekly',
      connection: 'Test',
      database: db,
      timeZone: 'Europe/Istanbul',
      state: 'active',
      format: 'archive',
      destinations: ['Disk'],
    })
    expect(String(list[0]!.cadence)).toMatch(/Monday/)
    expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('pauses and resumes a schedule named in any letter case, each on its card', async () => {
    const { schedule, decide, current, once, turn } = await withSchedule()
    const paused = await decide([{ name: 'pause_schedule', args: { schedule: 'weekly' } }], 'confirm')
    expect(paused.card.proposal!.payload).toEqual({ pauseSchedule: 'Weekly' })
    expect(paused.ended).toMatchObject({ state: 'done', summary: { schedule: 'Weekly', did: 'paused' } })
    expect((await current()).find((s) => s.id === schedule.id)).toMatchObject({ state: 'paused' })
    // Paused already: said so, no card.
    once([{ name: 'pause_schedule', args: { schedule: 'Weekly' } }])
    expect(steps(await turn('pause it'))[0]).toMatchObject({ state: 'refused', reason: 'schedule_paused' })
    const resumed = await decide([{ name: 'resume_schedule', args: { schedule: 'Weekly' } }], 'confirm')
    expect(resumed.ended).toMatchObject({ state: 'done', summary: { did: 'resumed' } })
    expect((await current()).find((s) => s.id === schedule.id)).toMatchObject({ state: 'active' })
  })

  it('runs a schedule now, on its card', async () => {
    const { h, schedule, decide, inject } = await withSchedule()
    const ran = await decide([{ name: 'run_schedule', args: { schedule: 'Weekly' } }], 'confirm')
    expect(ran.card.proposal!.payload).toEqual({ runSchedule: 'Weekly' })
    expect(ran.ended).toMatchObject({ state: 'done', summary: { did: 'started' } })
    expect(((await inject('GET', `backup-schedules/${schedule.id}/runs`)).json() as unknown[]).length).toBe(1)
    // Final review of wave B (M1): the run it started, and what the run did, are rows of the turn.
    await h.t.app.ctx.backup.scheduler.idle()
    const started = h.t.app.ctx.audit.list({ action: 'backup.schedule.run' }).at(0)!
    const via = (started.details as { agent?: { run: string } }).agent!
    expect(via.run).toEqual(expect.any(String))
    const finished = h.t.app.ctx.audit.list({ action: 'backup.schedule.run.finish' }).at(0)!
    expect((finished.details as { agent?: unknown }).agent).toEqual(via)
  })

  it('changes a schedule, the backups its new retention removes now said on the card and confirmed', async () => {
    const { h, schedule, dest, decide, current, inject } = await withSchedule()
    // Thirty copies at the destination, a minute apart.
    for (let i = 0; i < 30; i++) {
      const copyId = randomUUID()
      const at = h.t.app.ctx.now() - i * 60_000
      h.t.app.ctx.store.db
        .prepare(
          `INSERT INTO backup_remote_copies (id, destination_id, backup_id, remote_key, owner, connection_id, meta, format,
            size, sha256, state, created_at, completed_at, schedule_id) VALUES (?, ?, NULL, ?, ?, NULL, ?, 'archive', 1, ?, 'complete', ?, ?, ?)`,
        )
        .run(
          copyId,
          dest,
          `mongo-manager/2026/01/mm-${copyId.slice(0, 8)}.archive`,
          schedule.owner.id,
          JSON.stringify({ startedAt: at }),
          'a'.repeat(64),
          at,
          at,
          schedule.id,
        )
    }
    const removals = (
      (
        await inject('POST', 'backup-schedules/preview', {
          scheduleId: schedule.id,
          retention: RETENTION_PRESETS.daily30,
        })
      ).json() as { removals: Array<{ count: number }> }
    ).removals.reduce((n, r) => n + r.count, 0)
    expect(removals).toBeGreaterThan(10)
    const changed = await decide(
      [
        {
          name: 'update_schedule',
          args: { schedule: 'Weekly', retention: 'daily30', cadence: '{"kind":"daily","times":["02:00"]}' },
        },
      ],
      'confirm',
    )
    expect(changed.card.proposal!.preview).toMatchObject({ removals, retention: RETENTION_PRESETS.daily30 })
    expect(changed.card.proposal!.preview!.nextRuns!.length).toBeGreaterThan(0)
    expect(changed.ended).toMatchObject({ state: 'done', summary: { did: 'updated' } })
    expect((await current()).find((s) => s.id === schedule.id)).toMatchObject({
      retention: RETENTION_PRESETS.daily30,
      cadence: { kind: 'daily', times: ['02:00'] },
    })
  })

  it('refuses a change that changes nothing, a cadence that would not run, a destination not listed', async () => {
    const { once, turn } = await withSchedule()
    const asked = async (args: object) => {
      once([{ name: 'update_schedule', args: { schedule: 'Weekly', ...args } }])
      return steps(await turn('change it'))[0]
    }
    expect(await asked({})).toMatchObject({ state: 'refused', reason: 'invalid_arguments' })
    expect(await asked({ cadence: '{"kind":"cron","expression":"*/30 * * * *"}' })).toMatchObject({
      state: 'refused',
      reason: 'cadence_min_gap',
    })
    expect(await asked({ destinations: ['Nowhere'] })).toMatchObject({
      state: 'refused',
      reason: 'destination_unknown',
    })
  })

  it('deletes a schedule with its name typed on the card', async () => {
    const { decide, current } = await withSchedule()
    const gone = await decide([{ name: 'delete_schedule', args: { schedule: 'Weekly' } }], 'confirm', {
      confirm: 'Weekly',
    })
    expect(gone.card.proposal).toMatchObject({ typed: 'Weekly', destructive: true })
    expect(gone.ended).toMatchObject({ state: 'done', summary: { did: 'deleted' } })
    expect(await current()).toEqual([])
  })

  it('says a schedule it does not know, with the names it may use', async () => {
    const { once, turn, fake } = await withSchedule()
    once([{ name: 'run_schedule', args: { schedule: 'Nightly' } }])
    expect(steps(await turn('run nightly'))[0]).toMatchObject({
      state: 'refused',
      reason: 'schedule_unknown',
    })
    expect(conversationOf(fake.requests.at(-1)!.body).results.at(-1)).toContain('Weekly')
  })

  // Review of B1 (I1): the model is told the latest runs, newest first — not the oldest kept.
  it('tells the latest runs, newest first', async () => {
    const { h, schedule, once, turn, told } = await withSchedule()
    const runs = h.t.app.ctx.backup.runs
    for (let i = 7; i >= 1; i--) {
      const run = runs.insert({
        scheduleId: schedule.id,
        dueAt: h.t.app.ctx.now() - i * 86_400_000,
        kind: 'scheduled',
      })!
      runs.finish(run.id, i === 1 ? 'succeeded' : 'failed', i === 1 ? null : 'dump_failed', {})
    }
    once([{ name: 'list_schedules', args: {} }])
    await turn('how did it go?')
    const [weekly] = told().schedules as Array<{ lastRuns: Array<{ outcome: string; atUtc: string }> }>
    expect(weekly!.lastRuns).toHaveLength(5)
    expect(weekly!.lastRuns[0]!.outcome).toBe('succeeded')
    expect(weekly!.lastRuns.slice(1).every((r) => r.outcome === 'failed')).toBe(true)
    expect(new Date(weekly!.lastRuns[0]!.atUtc).getTime()).toBe(h.t.app.ctx.now() - 86_400_000)
  })

  // Review of B1 (M2, M3): removals only for a change that removes; a zone alone gives its next runs.
  it('says no removals for a rename, and the next runs for a zone alone', async () => {
    const { copies, pending } = await withSchedule()
    // More than its retention keeps: removals are due already, whatever is changed.
    copies(60)
    const renamed = await pending([
      { name: 'update_schedule', args: { schedule: 'Weekly', name: 'Weekly backup' } },
    ])
    expect(renamed.card.proposal!.preview?.removals).toBeUndefined()
    await renamed.answer({ decision: 'decline' })
    await renamed.ended()
    const zoned = await pending([
      { name: 'update_schedule', args: { schedule: 'Weekly', timeZone: 'Asia/Tokyo' } },
    ])
    expect(zoned.card.proposal!.preview).toMatchObject({ timeZone: 'Asia/Tokyo' })
    expect(zoned.card.proposal!.preview!.nextRuns!.length).toBeGreaterThan(0)
    await zoned.answer({ decision: 'decline' })
    await zoned.ended()
  })

  it('says on the card a paused schedule’s new runs wait for it to be resumed', async () => {
    const { schedule, inject, pending } = await withSchedule()
    await inject('POST', `backup-schedules/${schedule.id}/pause`)
    const changed = await pending([
      {
        name: 'update_schedule',
        args: { schedule: 'Weekly', cadence: '{"kind":"daily","times":["02:00"]}' },
      },
    ])
    expect(changed.card.proposal!.preview).toMatchObject({ paused: true })
    await changed.answer({ decision: 'decline' })
    await changed.ended()
  })

  // M4: what the route answers on the click, said before any card.
  it('refuses to run a schedule already running, or where the server turns schedules off', async () => {
    const { h, once, turn } = await withSchedule()
    const busy = vi.spyOn(h.t.app.ctx.backup.scheduler, 'busy').mockReturnValue(true)
    once([{ name: 'run_schedule', args: { schedule: 'Weekly' } }])
    expect(steps(await turn('run it'))[0]).toMatchObject({ state: 'refused', reason: 'run_running' })
    busy.mockRestore()
    const limits = h.t.app.ctx.backup.limits as { schedules: boolean }
    limits.schedules = false
    once([{ name: 'run_schedule', args: { schedule: 'Weekly' } }])
    expect(steps(await turn('run it'))[0]).toMatchObject({ state: 'refused', reason: 'schedules_off' })
  })

  // M6: two of the person's schedules by one name are not taken for either; a name in use is not given.
  it('says when a name is two schedules, and never renames one to a name in use', async () => {
    const { input, inject, once, turn, fake } = await withSchedule()
    expect((await inject('POST', 'backup-schedules', { ...input, name: 'Daily' })).statusCode).toBe(201)
    once([{ name: 'update_schedule', args: { schedule: 'Weekly', name: 'daily' } }])
    expect(steps(await turn('rename it'))[0]).toMatchObject({
      state: 'refused',
      reason: 'schedule_name_taken',
    })
    expect((await inject('POST', 'backup-schedules', input)).statusCode).toBe(201)
    once([{ name: 'pause_schedule', args: { schedule: 'Weekly' } }])
    expect(steps(await turn('pause it'))[0]).toMatchObject({ state: 'refused', reason: 'schedule_ambiguous' })
    expect(conversationOf(fake.requests.at(-1)!.body).results.at(-1)).toMatch(/2 schedules/)
  })

  // M11: another person's by name, a declined card, a name not typed.
  it('never acts on another person’s schedule; a declined card changes nothing; a delete needs the name', async () => {
    const { h, input, schedule, once, turn, decide, current, pending } = await withSchedule()
    h.t.app.ctx.backup.schedules.create({
      ...ScheduleInputSchema.parse({ ...input, name: 'Theirs' }),
      owner: randomUUID(),
      keyId: null,
      nextRunAt: null,
    })
    once([{ name: 'pause_schedule', args: { schedule: 'Theirs' } }])
    expect(steps(await turn('pause theirs'))[0]).toMatchObject({
      state: 'refused',
      reason: 'schedule_unknown',
    })
    const declined = await decide([{ name: 'pause_schedule', args: { schedule: 'Weekly' } }], 'decline')
    expect(declined.ended.state).toBe('declined')
    expect((await current()).find((s) => s.id === schedule.id)).toMatchObject({ state: 'active' })
    const deleting = await pending([{ name: 'delete_schedule', args: { schedule: 'Weekly' } }])
    expect(deleting.card.proposal!.preview).toMatchObject({ backupsStay: true })
    const wrong = await deleting.answer({ decision: 'confirm', confirm: 'weekly' })
    expect(wrong.json().details).toMatchObject({ reason: 'typed_name' })
    await deleting.answer({ decision: 'decline' })
    await deleting.ended()
    expect((await current()).some((s) => s.id === schedule.id)).toBe(true)
  })
})

// Review of C5 (I1, I2): a schedule found by its name alone, on a connection where its tool is off.
describe('schedules where an administrator turned the agent’s tools off (C5)', () => {
  it('refuses a change to it before any card, and lists none there where listing is off', async () => {
    const { h, once, turn, told } = await withSchedule()
    h.t.app.ctx.connections.setAiAgentToolsOff(h.connectionId, ['pause_schedule', 'list_schedules'])
    once([{ name: 'pause_schedule', args: { schedule: 'Weekly' } }])
    expect(steps(await turn('pause it'))[0]).toMatchObject({ state: 'refused', reason: 'tool_off' })
    once([{ name: 'list_schedules', args: {} }])
    await turn('my schedules')
    expect(told()).toMatchObject({ schedules: [] })
  })
})
