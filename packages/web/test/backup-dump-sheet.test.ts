// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { DumpPlan } from '@mongo-manager/shared'
import BackupDumpSheet from '../src/backup/BackupDumpSheet.vue'
import { i18n } from '../src/i18n'
import { mockApi, mountApp } from './support/app'
import { button } from './support/dom'

const ALL = [
  'documents:read',
  'documents:write',
  'databases:write',
  'indexes:write',
  'jobs:run',
  'data:export',
]
const CONNS = [{ id: 'c1', name: 'Prod', access: 'editor', permissions: ALL, export: true }]
const plan = (over: Partial<DumpPlan> = {}): DumpPlan => ({
  planHash: 'a'.repeat(64),
  namespaces: [
    {
      db: 'shop',
      coll: 'orders',
      type: 'collection',
      documents: 1200,
      bytes: 2_000_000,
      ttl: [],
      personal: ['shop.orders.email'],
    },
    { db: 'shop', coll: 'v', type: 'view', documents: null, bytes: null, ttl: [], personal: [] },
  ],
  estimate: { bytes: 2_000_000, fileBytes: 500_000, seconds: 30 },
  tools: { available: false, reason: 'not_admin' },
  masked: false,
  recommended: { format: 'mmbak', engine: 'builtin', reason: 'personal' },
  checks: [{ key: 'personal', level: 'warn', params: { count: 1 }, fix: { kind: 'encrypt' } }],
  refusals: [],
  ...over,
})
const JOB = {
  id: 'j1',
  kind: 'backup.dump',
  state: 'running',
  connectionId: 'c1',
  db: 'shop',
  coll: '*',
  target: 'shop.mmbak',
  targetConnectionId: null,
  progress: null,
  estimate: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  mine: true,
  cancellable: true,
}
const settle = async () => {
  await vi.advanceTimersByTimeAsync(400)
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('dump sheet (spec §3.1, U1–U3)', () => {
  it('opens on the quick path with the recommended encrypted format and starts with a password', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [
        200,
        [
          { name: 'orders', type: 'collection' },
          { name: 'v', type: 'view' },
        ],
      ],
      'POST connections/c1/backup/plan': (body) => [
        200,
        plan(
          (body as { format: string }).format === 'mmbak'
            ? { checks: [{ key: 'personal', level: 'ok', params: { count: 1 } }] }
            : {},
        ),
      ],
      'POST connections/c1/backup': () => [202, { job: JOB }],
    })
    const closed = vi.fn()
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop', onClose: closed } })
    await settle()
    // The recommendation changes the settings: they are planned again.
    await settle()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Recommended for this backup')
    expect(text).toContain('It holds personal data')
    expect(text).toContain('1 collection · 1 view')
    // The recommended format was applied and planned again; no password ever goes to the plan.
    const plans = calls.filter((c) => c.path === 'connections/c1/backup/plan')
    expect(plans.at(-1)!.body).toMatchObject({ format: 'mmbak', scope: { kind: 'database', db: 'shop' } })
    expect(plans.every((c) => !('password' in (c.body as object)))).toBe(true)
    expect(button('Start backup').disabled).toBe(true)
    button('Generate a strong password').click()
    await settle()
    expect(button('Start backup').disabled).toBe(false)
    button('Start backup').click()
    await flushPromises()
    const start = calls.find((c) => c.path === 'connections/c1/backup')!
    expect(start.body).toMatchObject({ planHash: 'a'.repeat(64), format: 'mmbak' })
    expect((start.body as { password: string }).password).toMatch(/^[1-9A-Za-z]{4}(-[1-9A-Za-z]{4}){5}$/)
    expect(closed).toHaveBeenCalled()
  })

  it('never overrides a choice made before the first plan arrives (U1)', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'POST connections/c1/backup/plan': () => [
        200,
        plan({ recommended: { format: 'gzip', engine: 'builtin', reason: null } }),
      ],
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await flushPromises()
    // The user picks before any answer: the recommendation must not undo it.
    document.querySelector<HTMLInputElement>('input[name="format"][value="archive"]')!.click()
    await settle()
    await settle()
    expect(document.querySelector<HTMLInputElement>('input[name="format"][value="archive"]')!.checked).toBe(
      true,
    )
    expect(calls.filter((c) => c.path === 'connections/c1/backup/plan').at(-1)!.body).toMatchObject({
      format: 'archive',
    })
  })

  it('closes a fresh sheet at once, and asks once something was changed (U12)', async () => {
    mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'POST connections/c1/backup/plan': () => [
        200,
        plan({ recommended: { format: 'gzip', engine: 'builtin', reason: null } }),
      ],
    })
    const closed = vi.fn()
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop', onClose: closed } })
    await settle()
    const escape = () =>
      document
        .querySelector<HTMLElement>('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    escape()
    await flushPromises()
    expect(closed).toHaveBeenCalledTimes(1)
    document.querySelector<HTMLInputElement>('input[value="archive"]')!.click()
    await settle()
    escape()
    await flushPromises()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Discard these settings?')
    // Final review minor 12: Cancel asks the same question.
    button('Keep editing').click()
    await flushPromises()
    button('Cancel').click()
    await flushPromises()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Discard these settings?')
  })

  it('applies a preflight fix, opens the steps, and locks anonymous for a restricted user (U2, U3)', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, [{ ...CONNS[0], restricted: true }]],
      'GET connections/c1/databases/shop/collections': () => [200, [{ name: 'orders', type: 'collection' }]],
      'POST connections/c1/backup/plan': () => [
        200,
        plan({
          masked: true,
          recommended: { format: 'gzip', engine: 'builtin', reason: null },
          checks: [{ key: 'personal', level: 'warn', params: { count: 1 }, fix: { kind: 'encrypt' } }],
        }),
      ],
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    button('Encrypt').click()
    await settle()
    expect(calls.filter((c) => c.path === 'connections/c1/backup/plan').at(-1)!.body).toMatchObject({
      format: 'mmbak',
    })
    button('Customize…').click()
    await flushPromises()
    expect(document.querySelector('[aria-current="step"]')!.textContent).toContain('Scope')
    for (let i = 0; i < 2; i++) {
      button('Next').click()
      await flushPromises()
    }
    expect(document.querySelector('[aria-current="step"]')!.textContent).toContain('Content')
    // Backup review M11: what a backup is not — one moment's copy, or the server's users.
    expect(document.querySelector('[data-test="backup-limits"]')!.textContent).toBe(
      'A backup reads collection after collection, not one moment: what is written meanwhile may be partly in it. MongoDB users and roles are not included.',
    )
    const anon = document.querySelector<HTMLInputElement>('[data-test="backup-anonymous"]')!
    expect(anon.checked).toBe(true)
    expect(anon.disabled).toBe(true)
    expect(calls.filter((c) => c.path === 'connections/c1/backup/plan').at(-1)!.body).toMatchObject({
      anonymous: true,
    })
    // Alt+Left goes back a step.
    document
      .querySelector<HTMLElement>('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[aria-current="step"]')!.textContent).toContain('Engine')
    expect(document.body.textContent).toContain('Only an administrator of this connection can use it.')
  })

  it("offers the server's part size as the default and sends one only when chosen (final review minor 2)", async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET backups/usage': () => [200, { used: 0, quota: 1e10, ttlHours: 24, chunkMb: 32 }],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'POST connections/c1/backup/plan': () => [
        200,
        plan({ recommended: { format: 'mmbak', engine: 'builtin', reason: null } }),
      ],
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    await settle()
    expect(calls.filter((c) => c.path === 'connections/c1/backup/plan').at(-1)!.body).not.toHaveProperty(
      'chunkMb',
    )
    button('Customize…').click()
    await flushPromises()
    for (let i = 0; i < 3; i++) {
      button('Next').click()
      await flushPromises()
    }
    const select = document.querySelector<HTMLSelectElement>('select')!
    expect(select.selectedOptions[0]!.textContent).toContain('32 MB (default)')
    select.value = '128'
    select.dispatchEvent(new Event('change'))
    await settle()
    expect(calls.filter((c) => c.path === 'connections/c1/backup/plan').at(-1)!.body).toMatchObject({
      chunkMb: 128,
    })
  })

  it('shows blocking refusals in words and never starts', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'POST connections/c1/backup/plan': () => [
        200,
        plan({
          refusals: ['backup_quota'],
          checks: [
            {
              key: 'quota',
              level: 'block',
              params: { room: 1000, fileBytes: 5000 },
              fix: { kind: 'deleteOld' },
            },
          ],
          recommended: { format: 'gzip', engine: 'builtin', reason: null },
        }),
      ],
    })
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop' } })
    await settle()
    expect(document.body.textContent).toContain('Not enough space')
    expect(document.body.textContent).toContain('Not enough backup space.')
    expect(button('Start backup').disabled).toBe(true)
    document
      .querySelector<HTMLElement>('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(calls.some((c) => c.path === 'connections/c1/backup')).toBe(false)
  })

  it('shows a refusal from the start as an error and keeps the sheet open', async () => {
    const { calls } = mockApi({
      'GET connections': () => [200, CONNS],
      'GET connections/c1/databases/shop/collections': () => [200, []],
      'POST connections/c1/backup/plan': () => [
        200,
        plan({ recommended: { format: 'gzip', engine: 'builtin', reason: null } }),
      ],
      'POST connections/c1/backup': () => [
        409,
        {
          code: 'CONFLICT',
          message: 'The backup changed since its plan; review it again',
          details: { reason: 'plan_changed' },
        },
      ],
    })
    const closed = vi.fn()
    mountApp(BackupDumpSheet, { props: { connectionId: 'c1', db: 'shop', onClose: closed } })
    await settle()
    button('Start backup').click()
    await flushPromises()
    expect(closed).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent ?? '').toMatch(/changed since this plan/i)
    // It planned again at once.
    await settle()
    expect(calls.filter((c) => c.path === 'connections/c1/backup/plan').length).toBeGreaterThan(1)
  })
})
