import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { AlertView, ConnectionHealth, ShardingView } from '@mongo-manager/shared/browser'
import JobsTray from '../src/jobs/JobsTray.vue'
import RuleDialog from '../src/alerts/RuleDialog.vue'
import WebhooksChannel from '../src/alerts/WebhooksChannel.vue'
import EmailChannel from '../src/alerts/EmailChannel.vue'
import PreferencesPanel from '../src/workspace/sidebar/PreferencesPanel.vue'
import { useToastStore } from '../src/stores/toasts'
import ChunkDistribution from '../src/monitor/ChunkDistribution.vue'
import ConnectionsWidget from '../src/workspace/overview/widgets/ConnectionsWidget.vue'
import { i18n } from '../src/i18n'
import { useSessionStore } from '../src/stores/session'
import { mockApi, mountApp } from './support/app'
import { byLabel, check, typeInto } from './support/dom'

/**
 * W3.3–W3.4 on the page: the bell's alerts and their acknowledgement, a rule's channels, a
 * webhook's secret shown once, the chunk distribution, and the cards' live health.
 */
beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function signIn(permissions: string[] = ['settings:manage']): void {
  const session = useSessionStore()
  session.status = { mode: 'team', authenticated: true, setupRequired: false } as never
  session.me = { id: 'u1', username: 'ada', role: 'admin', permissions } as never
}

const firing: AlertView = {
  id: 'a1',
  ruleId: 'r1',
  connectionId: 'c1',
  connectionName: 'Prod',
  metric: 'connections',
  event: null,
  state: 'firing',
  value: 812,
  threshold: 500,
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  detail: {},
  deliveries: [],
  snoozed: false,
}

describe('alerts in the bell (W3.3)', () => {
  it('shows firing alerts with their value, and acknowledges one', async () => {
    signIn()
    let acknowledged = false
    const { calls } = mockApi({
      'GET jobs': () => [200, { jobs: [], serverTime: Date.now() }],
      'GET alerts/active': () => [
        200,
        acknowledged ? [{ ...firing, acknowledgedAt: 'x', acknowledgedBy: 'ada' }] : [firing],
      ],
      'POST alerts/a1/acknowledge': () => {
        acknowledged = true
        return [200, { ...firing, acknowledgedAt: 'x', acknowledgedBy: 'ada' }]
      },
    })
    mountApp(JobsTray)
    await flushPromises()
    expect(document.querySelector('[data-test="alerts-dot"]')).not.toBeNull()
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label*="1 alert firing"]')!
    trigger.click()
    await flushPromises()
    const list = document.querySelector('[data-test="alerts-list"]')!
    expect(list.textContent).toContain('Connections 812 on Prod (over 500)')
    list.querySelector<HTMLButtonElement>('button[aria-label^="Acknowledge"]')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'alerts/a1/acknowledge')).toBe(true)
    expect(document.querySelector('[data-test="alerts-list"]')!.textContent).toContain('Acknowledged by ada')
  })
})

describe('alert rules (W3.3)', () => {
  it('makes a threshold rule with the channels chosen, the e-mail one only when it is set up', async () => {
    const made: unknown[] = []
    mockApi({
      'GET alerts/channels': () => [
        200,
        {
          email: null,
          webhooks: [
            { id: 'w1', name: 'Ops', url: 'https://hooks.example.com', enabled: true, createdAt: '' },
          ],
        },
      ],
      'POST alerts/rules': (body) => {
        made.push(body)
        return [201, {}]
      },
    })
    mountApp(RuleDialog, { props: { kind: 'metric', connectionId: 'c1' } })
    await flushPromises()
    expect(byLabel('E-mail').disabled).toBe(true)
    await typeInto(byLabel('Fire above (count)'), '750')
    await check(byLabel('Webhook Ops'))
    document.querySelector<HTMLButtonElement>('[data-save-rule]')!.click()
    await flushPromises()
    expect(made).toEqual([
      {
        kind: 'metric',
        connectionId: 'c1',
        metric: 'connections',
        threshold: 750,
        sustain: 2,
        enabled: true,
        channels: { inApp: true, email: false, webhooks: ['w1'] },
      },
    ])
  })
})

describe('webhooks (W3.3)', () => {
  it('shows a new webhook’s signing secret once, in a dialog that only its own button closes', async () => {
    mockApi({
      'POST alerts/channels/webhooks': () => [
        201,
        {
          id: 'w2',
          name: 'Chat',
          url: 'https://chat.example.com/x',
          enabled: true,
          createdAt: '',
          secret: 'whsec_abc',
        },
      ],
      'GET alerts/channels': () => [200, { email: null, webhooks: [] }],
    })
    mountApp(WebhooksChannel, { props: { webhooks: [] } })
    await typeInto(byLabel('Name'), 'Chat')
    await typeInto(byLabel('Address'), 'https://chat.example.com/x')
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Add webhook'))!.click()
    await flushPromises()
    expect(document.querySelector('[data-webhook-secret]')?.textContent).toContain('whsec_abc')
    // No close icon: only "I have copied it" ends it.
    expect(document.querySelector('[role="dialog"] button[aria-label="Close"]')).toBeNull()
    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-webhook-secret]')).not.toBeNull()
    ;[...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('I have copied it'))!
      .click()
    await flushPromises()
    expect(document.querySelector('[data-webhook-secret]')).toBeNull()
  })
})

describe('chunk distribution (W3.2)', () => {
  it('draws each collection’s chunks per shard, said in words too', () => {
    const view = {
      shards: [
        { id: 'rs0', hosts: '', draining: false, tags: [], collections: 1, chunks: 3 },
        { id: 'rs1', hosts: '', draining: false, tags: [], collections: 1, chunks: 1 },
      ],
      balancer: null,
      mongos: [],
      collections: [
        {
          ns: 'shop.orders',
          key: { _id: 'hashed' },
          unique: false,
          balancing: true,
          chunks: { rs0: 3, rs1: 1 },
          imbalance: 2,
          jumbo: 0,
        },
      ],
      more: false,
      refused: {},
    } as ShardingView
    mountApp(ChunkDistribution, { props: { view } })
    const bar = document.querySelector('[role="img"]')!
    expect(bar.getAttribute('aria-label')).toBe('shop.orders: rs0: 3 (75%), rs1: 1 (25%)')
    expect(bar.querySelectorAll('span')).toHaveLength(2)
  })
})

describe('W3 review on the page', () => {
  // I3: another server or account needs the password typed again.
  it('asks for the SMTP password again when the server changes', async () => {
    const { calls } = mockApi({})
    mountApp(EmailChannel, {
      props: {
        settings: {
          enabled: true,
          host: 'smtp.example.com',
          port: 587,
          security: 'starttls',
          username: 'mailer',
          passwordSet: true,
          from: 'a@example.com',
          recipients: ['ops@example.com'],
        },
      },
    })
    await typeInto(byLabel('SMTP server'), 'evil.example.net')
    document.querySelector<HTMLFormElement>('[data-email-channel]')!.dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(document.body.textContent).toContain('Enter the password again')
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([])
  })

  // User report 2026-10-30: the switch turned off at once, and saving with it off asked for a server.
  it('turns saved mail off by its switch alone, keeping the fields being edited', async () => {
    const saved = {
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls' as const,
      username: 'mailer',
      passwordSet: true,
      from: 'a@example.com',
      recipients: ['ops@example.com'],
    }
    const { calls } = mockApi({
      'PATCH alerts/channels/email': (body) => [200, { ...saved, ...(body as object) }],
      'GET alerts/channels': () => [200, { email: { ...saved, enabled: false }, webhooks: [] }],
    })
    mountApp(EmailChannel, { props: { settings: saved } })
    await typeInto(byLabel('From'), 'b@example.com')
    await check(byLabel('Send alerts by e-mail'), false)
    await flushPromises()
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([
      expect.objectContaining({ method: 'PATCH', path: 'alerts/channels/email', body: { enabled: false } }),
    ])
    expect(byLabel('Send alerts by e-mail').checked).toBe(false)
    expect(byLabel('From').value).toBe('b@example.com')
  })

  it('puts the switch back when mail could not be turned off', async () => {
    mockApi({ 'PATCH alerts/channels/email': () => [500, { code: 'INTERNAL', message: 'boom' }] })
    mountApp(EmailChannel, {
      props: {
        settings: {
          enabled: true,
          host: 'smtp.example.com',
          port: 587,
          security: 'starttls',
          username: null,
          passwordSet: false,
          from: 'a@example.com',
          recipients: ['ops@example.com'],
        },
      },
    })
    await check(byLabel('Send alerts by e-mail'), false)
    await flushPromises()
    expect(byLabel('Send alerts by e-mail').checked).toBe(true)
    expect(document.querySelector('[data-email-channel]')!.textContent).not.toContain('Enter the server')
  })

  it('starts off when mail is not set up, and saves nothing (and asks for nothing) left off', async () => {
    const { calls } = mockApi({})
    mountApp(EmailChannel, { props: { settings: null } })
    expect(byLabel('Send alerts by e-mail').checked).toBe(false)
    document.querySelector<HTMLFormElement>('[data-email-channel]')!.dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(document.body.textContent).not.toContain('Enter the server, the sender')
    expect(calls).toEqual([])
    // Turned on, the server and the rest are needed.
    await check(byLabel('Send alerts by e-mail'))
    document.querySelector<HTMLFormElement>('[data-email-channel]')!.dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(document.body.textContent).toContain('Enter the server, the sender')
    expect(calls).toEqual([])
  })

  // M10: what a failed test says, in words.
  it('says why a webhook test failed in words, not codes', async () => {
    mockApi({
      'POST alerts/channels/webhooks/w1/test': () => [
        200,
        { ok: false, attempts: 1, error: 'address_refused' },
      ],
    })
    mountApp(WebhooksChannel, {
      props: {
        webhooks: [{ id: 'w1', name: 'Ops', url: 'https://10.0.0.1/x', enabled: true, createdAt: '' }],
      },
    })
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click()
    await flushPromises()
    const toast = useToastStore().toasts.at(-1)!.message
    expect(toast).not.toContain('address_refused')
    expect(toast).toContain('MM_ALERTS_PRIVATE_NETWORKS')
  })

  // M8: someone who is not an administrator dismisses an alert from their own bell.
  it('lets a non-administrator dismiss an alert for themselves', async () => {
    signIn([])
    const { calls } = mockApi({
      'GET jobs': () => [200, { jobs: [], serverTime: Date.now() }],
      'GET alerts/active': () => [200, calls.some((c) => c.path === 'alerts/a1/dismiss') ? [] : [firing]],
      'POST alerts/a1/dismiss': () => [200, { ok: true }],
    })
    mountApp(JobsTray)
    await flushPromises()
    document.querySelector<HTMLButtonElement>('button[aria-label*="1 alert firing"]')!.click()
    await flushPromises()
    const list = document.querySelector('[data-test="alerts-list"]')!
    expect(list.querySelector('button[aria-label^="Acknowledge"]')).toBeNull()
    list.querySelector<HTMLButtonElement>('button[aria-label^="Dismiss"]')!.click()
    await flushPromises()
    expect(calls.some((c) => c.method === 'POST' && c.path === 'alerts/a1/dismiss')).toBe(true)
  })

  // M10: a refused opt-in says so.
  it('says when turning bell alerts on failed', async () => {
    mockApi({
      'GET me/alerts': () => [200, { inApp: false, available: true }],
      'PUT me/alerts': () => [500, { code: 'INTERNAL', message: 'x' }],
    })
    mountApp(PreferencesPanel)
    await flushPromises()
    await check(document.querySelector<HTMLInputElement>('[data-test="alerts-opt-in"] input')!)
    await flushPromises()
    expect(useToastStore().toasts.at(-1)?.kind).toBe('error')
  })
})

describe('live health on the cards (W3.4)', () => {
  it('shows ping, version and topology, alerts firing, and "not connected" without asking the server to dial', async () => {
    signIn([])
    const health: ConnectionHealth[] = [
      {
        connectionId: 'c1',
        state: 'ok',
        latencyMs: 12,
        version: '8.0.4',
        topology: 'replicaSet',
        alertsFiring: 2,
        checkedAt: '',
      },
      {
        connectionId: 'c2',
        state: 'idle',
        latencyMs: null,
        version: null,
        topology: null,
        alertsFiring: 0,
        checkedAt: null,
      },
    ]
    const conn = (id: string, name: string) => ({
      id,
      name,
      favorite: false,
      readOnly: false,
      access: 'admin',
      permissions: [],
      restricted: false,
      color: null,
      group: null,
    })
    const { calls } = mockApi({
      'GET connections': () => [200, [conn('c1', 'Prod'), conn('c2', 'Lab')]],
      'GET connections/health': () => [200, health],
    })
    mountApp(ConnectionsWidget)
    await flushPromises()
    const lines = [...document.querySelectorAll('[data-test="connection-health"]')].map((l) =>
      l.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(
      lines.some((l) => l?.includes('12 ms · MongoDB 8.0.4 · replica set') && l.includes('2 alerts firing')),
    ).toBe(true)
    expect(lines.some((l) => l?.includes('Not connected'))).toBe(true)
    // The list, never one connection's own health (which may open it).
    expect(calls.map((c) => c.path)).not.toContain('connections/c2/health')
  })
})
