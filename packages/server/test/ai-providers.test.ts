// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { makeApp, type TestApp } from './helpers'
import { resolveConfig } from '../src/config'
import { aiKeyContext } from '../src/ai/providers'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
async function repo() {
  const t = await makeApp()
  apps.push(t)
  return { t, repo: t.app.ctx.ai.providers }
}
const claude = {
  name: 'Claude',
  kind: 'anthropic' as const,
  apiKey: 'sk-ant-secret',
  maxTokens: 2048,
  enabled: true,
  isDefault: false,
}

describe('AI providers (phase 4a-1 spec §2.1)', () => {
  it('stores the key sealed and never in a record; the first provider is the default', async () => {
    const { t, repo: r } = await repo()
    const p = r.create(claude, 'u1')
    expect(p).toMatchObject({
      name: 'Claude',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5',
      keyStored: true,
      isDefault: true,
      samples: false,
      lastLocal: null,
    })
    expect(JSON.stringify(p)).not.toContain('sk-ant-secret')
    const row = t.app.ctx.store.db.prepare('SELECT api_key FROM ai_providers WHERE id = ?').get(p.id) as {
      api_key: string
    }
    expect(row.api_key).not.toContain('sk-ant')
    expect(t.app.ctx.secretBox.open(row.api_key, aiKeyContext(p.id))).toBe('sk-ant-secret')
    expect(r.key(p.id)).toBe('sk-ant-secret')
  })

  it('needs a model for OpenAI-compatible and Ollama providers, and a key for Anthropic', async () => {
    const { repo: r } = await repo()
    expect(() => r.create({ ...claude, apiKey: undefined }, null)).toThrow(/key/i)
    expect(() =>
      r.create({ name: 'O', kind: 'ollama', maxTokens: 2048, enabled: true, isDefault: false }, null),
    ).toThrow(/model/i)
    const o = r.create(
      { name: 'O', kind: 'ollama', model: 'llama3.3', maxTokens: 2048, enabled: true, isDefault: false },
      null,
    )
    expect(o).toMatchObject({ baseUrl: 'http://localhost:11434', keyStored: false, samples: true })
  })

  it('refuses addresses with credentials, other schemes, a query or a fragment', async () => {
    const { repo: r } = await repo()
    for (const baseUrl of [
      'https://u:p@x.example',
      'ftp://x.example',
      'https://x.example/?a=1',
      'https://x.example/#a',
      'not a url',
    ])
      expect(() => r.create({ ...claude, baseUrl }, null), baseUrl).toThrow()
    expect(r.create({ ...claude, baseUrl: 'https://gw.example/anthropic/' }, null).baseUrl).toBe(
      'https://gw.example/anthropic',
    )
  })

  it('asks for the key again when the address or the kind changes', async () => {
    const { repo: r } = await repo()
    const p = r.create(claude, null)
    expect(() => r.update(p.id, { baseUrl: 'https://evil.example' })).toThrow(/key/i)
    const moved = r.update(p.id, { baseUrl: 'https://gw.example', apiKey: 'new-key' })
    expect(r.key(moved.id)).toBe('new-key')
    // Same address: the key is kept when left out.
    r.update(p.id, { name: 'Claude 2' })
    expect(r.key(p.id)).toBe('new-key')
    // An Ollama provider at a new address simply loses nothing it needs.
    const o = r.create(
      { name: 'O', kind: 'ollama', model: 'm', maxTokens: 2048, enabled: true, isDefault: false },
      null,
    )
    r.setLocal(o.id, true)
    expect(r.update(o.id, { baseUrl: 'http://10.0.0.5:11434' }).lastLocal).toBeNull()
    // Final review minor 11: an Anthropic provider never loses its key.
    expect(() => r.update(p.id, { apiKey: null })).toThrow(/key/i)
  })

  it('keeps one default, never a disabled one, and moves it when the default goes', async () => {
    const { repo: r, t } = await repo()
    const a = r.create(claude, null)
    t.clock.now += 1000
    const b = r.create({ ...claude, name: 'B', isDefault: true }, null)
    expect(r.get(a.id)!.isDefault).toBe(false)
    expect(r.byDefault()!.id).toBe(b.id)
    expect(() => r.update(b.id, { enabled: false })).not.toThrow()
    expect(r.byDefault()!.id).toBe(a.id)
    expect(() => r.update(b.id, { isDefault: true })).toThrow(/disabled/i)
    r.remove(a.id)
    expect(r.byDefault()).toBeUndefined()
    r.update(b.id, { enabled: true })
    expect(r.byDefault()!.id).toBe(b.id)
  })

  it('holds at most 10 providers with distinct names', async () => {
    const { repo: r } = await repo()
    for (let i = 0; i < 10; i++) r.create({ ...claude, name: `P${i}` }, null)
    expect(() => r.create({ ...claude, name: 'P10' }, null)).toThrow(/10/)
    r.remove(r.list()[0]!.id)
    expect(() => r.create({ ...claude, name: 'P1' }, null)).toThrow(/name/i)
  })

  it('reads its settings from the environment (spec §3.3)', () => {
    const c = resolveConfig({
      env: {
        MM_AI: '0',
        MM_AI_PRIVATE_NETWORKS: '10.0.0.0/8, 192.168.1.0/24',
        MM_AI_PER_MINUTE: '5',
        MM_AI_AGENT_PER_MINUTE: '12',
        MM_AI_PER_DAY: '50',
        MM_AI_MAX_CONCURRENT: '4',
      },
    })
    expect(c.ai).toEqual({
      enabled: false,
      privateNetworks: ['10.0.0.0/8', '192.168.1.0/24'],
      perMinute: 5,
      agentPerMinute: 12,
      perDay: 50,
      maxConcurrent: 4,
      chatDays: 30,
    })
    expect(() => resolveConfig({ env: { MM_AI_PRIVATE_NETWORKS: '8.8.8.0/24' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_AI_PER_MINUTE: '0' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_AI_AGENT_PER_MINUTE: '121' } })).toThrow()
  })

  it('stores a connection’s policy beside its settings', async () => {
    const { t } = await repo()
    const { ctx } = t.app
    const c = ctx.connections.create(
      {
        name: 'C',
        favorite: false,
        readOnly: false,
        aiPolicy: 'local',
        settings: { hosts: [{ host: 'h', port: 1 }] } as never,
      },
      null,
    )
    expect(ctx.connections.get(c.id)!.aiPolicy).toBe('local')
    ctx.connections.setAiPolicy(c.id, 'off')
    expect(ctx.connections.get(c.id)!.aiPolicy).toBe('off')
  })
})
