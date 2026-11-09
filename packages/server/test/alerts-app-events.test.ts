// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectionSettingsSchema, type AlertEvent } from '@mongo-manager/shared'
import { makeApp, type TestApp } from './helpers'
import type { JobRecord } from '../src/jobs/types'

/**
 * W4 review I4: the app events W4 emits reach W3's alerts — a failed restore drill, two-way
 * conflicts, Watch matches — once each: a drill's failed job is not a second alert, a drill that
 * passed is history only, and a live sync that stops is told by its own record alone.
 */
const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})
const tick = () => new Promise((r) => setTimeout(r, 5))

async function setup() {
  const t = await makeApp({ alerts: { enabled: true, privateNetworks: ['127.0.0.1/32'] } } as never)
  apps.push(t)
  const { ctx } = t.app
  const connectionId = ctx.connections.create(
    {
      name: 'Prod',
      favorite: false,
      readOnly: false,
      settings: ConnectionSettingsSchema.parse({ hosts: [{ host: '127.0.0.1', port: 1 }] }),
    },
    null,
  ).id
  const rule = (event: Exclude<AlertEvent, 'report.ready'>) =>
    ctx.alerts.repo.createRule(
      {
        kind: 'event',
        event,
        connectionId: null,
        enabled: true,
        channels: { inApp: true, email: false, webhooks: [] },
      },
      null,
    )
  const history = () => ctx.alerts.repo.history({ limit: 50 })
  return { ctx, connectionId, rule, history }
}

describe('app events as alerts (W4 review I4)', () => {
  it('turns a failed drill, two-way conflicts and Watch matches into alerts, with what they said', async () => {
    const { ctx, connectionId, rule, history } = await setup()
    for (const e of ['backup.drillFailed', 'liveSync.conflicts', 'watch.matched'] as const) rule(e)
    ctx.events.emit('backup.drill.failed', {
      severity: 'critical',
      summary: 'The restore drill of nightly failed',
      connectionId,
      namespace: 'shop',
      ownerId: 'u1',
      details: { backup: 'b1', mismatched: 2 },
    })
    ctx.events.emit('liveSync.conflicts', {
      severity: 'warning',
      summary: 'c',
      connectionId,
      details: { conflicts: 3 },
    })
    ctx.events.emit('watch.matched', { severity: 'info', summary: 'm', connectionId, details: { count: 4 } })
    await tick()
    const byEvent = Object.fromEntries(history().map((e) => [e.event, e]))
    expect(Object.keys(byEvent).sort()).toEqual(['backup.drillFailed', 'liveSync.conflicts', 'watch.matched'])
    expect(byEvent['backup.drillFailed']).toMatchObject({
      connectionId,
      connectionName: 'Prod',
      detail: {
        backup: 'b1',
        mismatched: 2,
        severity: 'critical',
        summary: 'The restore drill of nightly failed',
        namespace: 'shop',
      },
    })
    expect(byEvent['liveSync.conflicts']!.detail).toMatchObject({ conflicts: 3, severity: 'warning' })
  })

  it('keeps a drill that passed as history only, and its failed job is not a second alert', async () => {
    const { ctx, connectionId, rule, history } = await setup()
    for (const e of ['backup.drillFailed', 'backup.failed', 'job.failed'] as const) rule(e)
    ctx.events.emit('backup.drill.passed', { severity: 'info', summary: 'ok', connectionId })
    ctx.alerts.onJob({
      id: 'd1',
      kind: 'backup.drill',
      state: 'failed',
      connectionId,
      db: 'shop',
      coll: '*',
    } as JobRecord)
    await tick()
    expect(history()).toEqual([])
    // Another backup job that fails still is one.
    ctx.alerts.onJob({
      id: 'b1',
      kind: 'backup.dump',
      state: 'failed',
      connectionId,
      db: 'shop',
      coll: '',
    } as JobRecord)
    expect(history().map((e) => e.event)).toEqual(['backup.failed'])
  })
})
