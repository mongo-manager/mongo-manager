// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolveConfig } from '../src/config'
import { ClientMessage } from '../src/realtime/protocol'

describe('Watch settings (phase 3e-1 spec §2.2)', () => {
  it('reads MM_WATCH and MM_WATCH_MAX_FEEDS within bounds', () => {
    expect(resolveConfig({}).watch).toEqual({ enabled: true, maxFeeds: 50 })
    expect(resolveConfig({ env: { MM_WATCH: '0', MM_WATCH_MAX_FEEDS: '500' } }).watch).toEqual({
      enabled: false,
      maxFeeds: 500,
    })
    expect(resolveConfig({ env: { MM_WATCH_MAX_FEEDS: '7' } }).watch).toEqual({ enabled: true, maxFeeds: 7 })
    expect(() => resolveConfig({ env: { MM_WATCH_MAX_FEEDS: '0' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_WATCH_MAX_FEEDS: '501' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_WATCH: 'perhaps' } })).toThrow(/MM_WATCH/)
  })
})

describe('the watch messages (phase 3e-1 spec §1.2)', () => {
  const id = randomUUID()
  it('takes a subscription, pause, resume and unsub, and fills the options', () => {
    const sub = ClientMessage.parse({
      ch: 'watch',
      type: 'sub',
      id,
      connectionId: 'c1',
      scope: 'collection',
      db: 'shop',
      coll: 'orders',
    })
    expect(sub).toMatchObject({
      filter: {},
      options: { ops: ['insert', 'update', 'replace', 'delete'], before: true },
    })
    expect(ClientMessage.parse({ ch: 'watch', type: 'pause', id })).toEqual({
      ch: 'watch',
      type: 'pause',
      id,
    })
    expect(ClientMessage.parse({ ch: 'watch', type: 'resume', id, from: 'now' })).toMatchObject({
      from: 'now',
    })
    expect(ClientMessage.parse({ ch: 'watch', type: 'unsub', id })).toMatchObject({ type: 'unsub' })
  })

  it('refuses a malformed subscription', () => {
    for (const bad of [
      { ch: 'watch', type: 'sub', id: 'not-a-uuid', connectionId: 'c1', scope: 'deployment' },
      { ch: 'watch', type: 'sub', id, connectionId: 'c1', scope: 'collection', db: 'shop' },
      { ch: 'watch', type: 'sub', id, connectionId: 'c1', scope: 'deployment', filter: [] },
      { ch: 'watch', type: 'sub', id, connectionId: 'c1', scope: 'deployment', extra: true },
      { ch: 'watch', type: 'resume', id, from: 'yesterday' },
    ])
      expect(ClientMessage.safeParse(bad).success).toBe(false)
  })
})
