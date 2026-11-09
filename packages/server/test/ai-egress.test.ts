// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config'
import { aiNetworks, createAiEgress } from '../src/ai/egress'
import { EgressError } from '../src/net/egress'
import { startHttpsServer } from './support/https-server'

const servers: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})
const config = (auth: boolean, nets: string[] = []) =>
  resolveConfig({
    cli: { auth, dataDir: '/tmp/x' },
    env: nets.length ? { MM_AI_PRIVATE_NETWORKS: nets.join(',') } : {},
  })
const reason = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as EgressError).reason
  }
}

describe('the assistant’s egress (phase 4a-1 spec §2.2)', () => {
  it('allows loopback in local mode only, and the listed networks in team mode', () => {
    expect(aiNetworks(config(false))).toEqual(['127.0.0.0/8', '::1/128'])
    expect(aiNetworks(config(true))).toEqual([])
    expect(aiNetworks(config(true, ['10.0.0.0/8']))).toEqual(['10.0.0.0/8'])
  })

  it('reaches a local Ollama over plain http in local mode, and tells local from cloud', async () => {
    const s = await startHttpsServer((_req, res) => res.end('ok'), { plain: true })
    servers.push(s)
    const egress = createAiEgress(config(false))
    const res = await egress.request({ method: 'GET', url: s.url, privateOnly: true })
    expect(res.status).toBe(200)
    expect(res.remoteAddress).toBe('127.0.0.1')
    expect(egress.listed(res.remoteAddress!)).toBe(true)
    expect(egress.listed('8.8.8.8')).toBe(false)
    res.body.destroy()
  })

  it('refuses loopback in team mode unless listed, naming the right setting', async () => {
    const s = await startHttpsServer((_req, res) => res.end('ok'), { plain: true })
    servers.push(s)
    const refused = createAiEgress(config(true))
    await expect(refused.request({ method: 'GET', url: s.url })).rejects.toMatchObject({
      reason: 'address_refused',
    })
    const listed = createAiEgress(config(true, ['127.0.0.1/32']))
    expect(await reason(listed.request({ method: 'GET', url: s.url }).then((r) => r.body.destroy()))).toBe(
      'ok',
    )
  })

  it('keeps a local-only request on the listed networks, whatever the name resolves to', async () => {
    const egress = createAiEgress(config(true, ['10.0.0.0/8']), async () => [
      { address: '93.184.216.34', family: 4 },
    ])
    expect(
      await reason(egress.request({ method: 'GET', url: 'https://ollama.internal', privateOnly: true })),
    ).toBe('address_refused')
    // Plain http to a public address is refused whatever the policy.
    expect(await reason(egress.request({ method: 'GET', url: 'http://ollama.internal' }))).toBe(
      'http_refused',
    )
  })

  it('never reaches cloud metadata or link-local addresses, listed or not', async () => {
    const egress = createAiEgress(config(true, ['10.0.0.0/8']))
    for (const url of ['http://169.254.169.254/latest', 'http://[fe80::1]/', 'http://100.100.100.200/'])
      expect(await reason(egress.request({ method: 'GET', url })), url).toBe('address_never')
  })
})
