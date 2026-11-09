// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { AiAgentStep, AiChatLine } from '@mongo-manager/shared'
import { startMongo, type TestMongo } from './support/mongo'
import { dataHarness } from './support/data'
import { startFakeAi, type FakeCall } from './support/fake-ai'
import { agentReply, agentTurn, conversationOf } from './support/agent'

/**
 * The AI database manager (design 2026-10-25, B6): the rows the app's own routes audit for an agent's
 * call carry the run, the chat and the call they were made for — from the call's token, held in the
 * process only, never from anything a request says.
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

const steps = (out: AiChatLine[]) =>
  out.flatMap((l) => (l.type === 'step' && l.step.state !== 'running' ? [l.step] : []))

async function agent() {
  const fake = await startFakeAi()
  closers.push(fake.close)
  const h = await dataHarness(mongo)
  closers.push(h.t.close)
  const inject = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
    h.t.app.inject({ method, url: `/api/${path}`, headers: h.headers, ...(payload ? { payload } : {}) })
  expect(
    (
      await inject('POST', 'ai/providers', {
        name: 'Fake',
        kind: 'openai',
        baseUrl: `${fake.url}/v1`,
        model: 'm',
      })
    ).statusCode,
  ).toBeLessThan(300)
  await inject('PUT', 'me/ai-agent', { on: true })
  const db = `b6${randomUUID().slice(0, 8)}`
  const once = (calls: FakeCall[], text = 'ok') =>
    fake.reply(agentReply((c) => (c.results.length === 0 ? { calls } : { text })))
  const turn = async (message: string) =>
    (await inject('POST', 'ai/agent', { message })).payload
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AiChatLine)
  const toldJson = () => {
    const r = conversationOf(fake.requests.at(-1)!.body).results.at(-1)!
    return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)) as Record<string, unknown>
  }
  const card = async (calls: FakeCall[]) => {
    once(calls)
    const stream = await agentTurn(h.t.app, h.headers, { message: 'do it' })
    const awaiting = (await stream.waitFor((l) => l.type === 'step' && l.step.state === 'awaiting')) as {
      step: AiAgentStep
    }
    const run = (stream.lines.find((l) => l.type === 'chat') as { run: string }).run
    const attempt = (extra: object) =>
      inject('POST', `ai/agent/runs/${run}/decide`, { call: awaiting.step.id, decision: 'confirm', ...extra })
    const decide = async (decision: 'confirm' | 'decline', extra: object = {}) => {
      const res = await inject('POST', `ai/agent/runs/${run}/decide`, {
        call: awaiting.step.id,
        decision,
        ...extra,
      })
      await stream.ended
      return { res, ended: steps(stream.lines).at(-1)! }
    }
    return { step: awaiting.step, attempt, decide }
  }
  const usersOf = async () =>
    ((await client.db(db).command({ usersInfo: 1 })).users as Array<{ user: string; roles: unknown[] }>).map(
      (u) => u.user,
    )
  return { h, fake, db, inject, once, turn, toldJson, card, usersOf }
}

describe('the audit of an agent’s calls (B6)', () => {
  it('ties the route’s own row to the run, the chat and the call', async () => {
    const { h, db, card, inject } = await agent()
    const asked = await card([
      { name: 'create_collection', args: { connection: 'Test', database: db, collection: 'orders' } },
    ])
    const { ended } = await asked.decide('confirm')
    expect(ended).toMatchObject({ state: 'done' })
    const { ctx } = h.t.app
    const tool = ctx.audit.list({ action: 'ai.agent.tool' }).at(0)!
    const { chat, run } = tool.details as { chat: string; run: string }
    expect(chat).toEqual(expect.any(String))
    const row = ctx.audit.list({ action: 'collections.create' }).at(0)!
    expect(row).toMatchObject({ outcome: 'success', namespace: db })
    expect((row.details as { agent?: unknown }).agent).toEqual({ run, chat, call: asked.step.id })
    // The log shows one turn's entries together: the tool's row, the person's answer, the route's row.
    const listed = (await inject('GET', `audit?run=${run}`)).json() as Array<{ action: string }>
    expect(listed.map((r) => r.action).sort()).toEqual([
      'ai.agent.decision',
      'ai.agent.tool',
      'ai.chat',
      'collections.create',
    ])
    expect((await inject('GET', 'audit?run=x%27%20OR%201%3D1')).statusCode).toBe(400)
  })

  it('never ties a request the person made themselves', async () => {
    const { h, db, inject } = await agent()
    const { ctx } = h.t.app
    // The person's own request, even one naming an agent's call in its body or headers, is not.
    const own = await inject('POST', `connections/${h.connectionId}/databases/${db}/collections`, {
      kind: 'collection',
      name: 'mine',
      agent: { run: 'forged', chat: 'forged', call: '9.9' },
    })
    expect(own.statusCode).toBeLessThan(500)
    const forged = await h.t.app.inject({
      method: 'POST',
      url: `/api/connections/${h.connectionId}/databases/${db}/collections`,
      headers: { ...h.headers, 'x-mm-agent-call': 'not-a-token' },
      payload: { kind: 'collection', name: 'mine2' },
    })
    expect(forged.statusCode).toBe(401)
    for (const r of ctx.audit.list({ limit: 50 })) expect(JSON.stringify(r.details)).not.toContain('forged')
  })
})

describe('the audit of an agent’s calls: the review of B6', () => {
  it('ties a refusal for personal data to the turn too (M1)', async () => {
    const { RefusalAudit } = await import('../src/masking/audit')
    const { AppError } = await import('../src/errors')
    const rows: Array<Record<string, unknown>> = []
    const audit = new RefusalAudit({ append: (r) => void rows.push(r as never) }, () => 0)
    const refusal = new AppError('FORBIDDEN', 'x', 403, {
      reason: 'personal_field',
      field: 'email',
      ns: 'hr.people',
    })
    const request = (agentVia: unknown) =>
      ({
        principal: { kind: 'user', userId: 'u1', username: 'u' },
        ip: '1',
        connection: { id: 'c' },
        agentVia,
      }) as never
    audit.refused(request({ run: 'r9', chat: 'c9', call: '1.1' }), refusal)
    audit.refused(request(null), refusal)
    expect(rows.map((r) => (r.details as { agent?: unknown }).agent)).toEqual([
      { run: 'r9', chat: 'c9', call: '1.1' },
      undefined,
    ])
  })

  it('names a run in a decision only once it is the person’s own (M2)', async () => {
    const { h, inject } = await agent()
    const other = randomUUID()
    const res = await inject('POST', `ai/agent/runs/${other}/decide`, { call: '1.1', decision: 'confirm' })
    expect(res.statusCode).toBe(404)
    const row = h.t.app.ctx.audit.list({ action: 'ai.agent.decision' }).at(0)!
    expect(row.details).toMatchObject({ asked: other })
    expect((row.details as { run?: unknown }).run).toBeUndefined()
    expect(h.t.app.ctx.audit.list({ run: other, limit: 50 })).toEqual([])
    // Review of B8 (M3): one's own run with no change waiting (answered already): still tied to it.
    const own = randomUUID()
    h.t.app.ctx.ai.agent.runs.open(own, 'local')
    try {
      const late = await inject('POST', `ai/agent/runs/${own}/decide`, { call: '1.1', decision: 'confirm' })
      expect(late.statusCode).toBe(404)
      expect(h.t.app.ctx.audit.list({ action: 'ai.agent.decision' }).at(0)!.details).toMatchObject({
        run: own,
      })
    } finally {
      h.t.app.ctx.ai.agent.runs.close(own)
    }
  })
})
