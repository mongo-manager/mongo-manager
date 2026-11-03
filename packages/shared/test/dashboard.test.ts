import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  DashboardSchema,
  defaultDashboard,
  isNewerDashboard,
  readDashboard,
  WIDGET_TYPES,
  widgetKey,
} from '../src/api/dashboard'

const id = () => randomUUID()
const C = randomUUID()
const onServer = (type: string, connectionId: string) => ({
  id: id(),
  type,
  size: 'm',
  settings: { connectionId },
})

describe('dashboard layout (user review 2026-10-09: the Overview as widgets)', () => {
  it('accepts the default and one widget of every type', () => {
    expect(DashboardSchema.safeParse(defaultDashboard(id)).success).toBe(true)
    const settings: Record<string, object> = {
      serverStatus: { connectionId: C },
      replica: { connectionId: C },
      operations: { connectionId: C },
      topCollections: { connectionId: C },
      databaseSizes: { connectionId: C },
      metric: { connectionId: C, metric: 'opcounters', range: 'live' },
      queries: { view: 'saved' },
      slowQueries: { connectionId: C },
      replication: { connectionId: C },
      shardBalance: { connectionId: C },
      collectionLatency: { connectionId: C },
      serverFacts: { connectionId: C },
      indexHealth: { connectionId: C, db: 'shop' },
      dataKpi: {
        connectionId: C,
        db: 'shop',
        coll: 'orders',
        pipelineId: randomUUID(),
        display: 'number',
        refresh: 'manual',
      },
    }
    const widgets = WIDGET_TYPES.map((type) => ({
      id: id(),
      type,
      size: 'm',
      settings: settings[type] ?? {},
    }))
    expect(DashboardSchema.safeParse({ version: 1, widgets }).success).toBe(true)
  })

  // Widgets wave 2 (2026-10-27): a database's index health, once per server and database.
  it('takes an index health widget of one database, once per server and database', () => {
    const health = (connectionId: string, db: unknown) => ({
      id: id(),
      type: 'indexHealth',
      size: 'm',
      settings: { connectionId, db },
    })
    const ok = (...widgets: object[]) => DashboardSchema.safeParse({ version: 1, widgets }).success
    expect(ok(health(C, 'shop'), health(C, 'logs'))).toBe(true)
    expect(ok(health(C, 'shop'), health(C, 'shop'))).toBe(false)
    expect(ok(health(C, 'a/b'))).toBe(false)
    expect(ok(health(C, ''))).toBe(false)
    expect(ok({ ...health(C, 'shop'), settings: { connectionId: C } })).toBe(false)
    expect(ok({ id: id(), type: 'alerts', size: 'm', settings: {} })).toBe(true)
    expect(ok({ id: id(), type: 'alerts', size: 'm', settings: { connectionId: C } })).toBe(false)
  })

  // Widgets wave 2 (2026-10-27): a number or bars from a saved pipeline.
  it('takes a data KPI of one saved pipeline, once per pipeline and display', () => {
    const P = randomUUID()
    const kpi = (over: object = {}) => ({
      id: id(),
      type: 'dataKpi',
      size: 'm',
      settings: {
        connectionId: C,
        db: 'shop',
        coll: 'orders',
        pipelineId: P,
        display: 'number',
        refresh: '5m',
        ...over,
      },
    })
    const ok = (...widgets: object[]) => DashboardSchema.safeParse({ version: 1, widgets }).success
    expect(ok(kpi(), kpi({ display: 'bars' }), kpi({ pipelineId: randomUUID() }))).toBe(true)
    expect(ok(kpi(), kpi({ refresh: '1h' }))).toBe(false)
    expect(ok(kpi({ display: 'pie' }))).toBe(false)
    expect(ok(kpi({ refresh: '1m' }))).toBe(false)
    expect(ok(kpi({ pipelineId: 'x' }))).toBe(false)
    expect(ok(kpi({ coll: '' }))).toBe(false)
    expect(ok(kpi({ db: 'a.b' }))).toBe(false)
  })

  // Widgets wave 2 (2026-10-27): the new metric choices.
  it('takes a chart of query targeting, latency, cursors, transactions and errors', () => {
    for (const metric of ['queryTargeting', 'latency', 'cursors', 'transactions', 'errors']) {
      const w = { id: id(), type: 'metric', size: 'l', settings: { connectionId: C, metric, range: '24h' } }
      expect(DashboardSchema.safeParse({ version: 1, widgets: [w] }).success).toBe(true)
    }
  })

  // completion W6.2: the next steps, with the AI's ordering asked for or not, and what was dismissed.
  it('keeps the next steps widget’s own settings, bounded', () => {
    const one = (settings: object) => ({
      version: 1,
      widgets: [{ id: id(), type: 'nextActions', size: 'm', settings }],
    })
    expect(defaultDashboard(id).widgets.map((w) => w.type)).toContain('nextActions')
    expect(DashboardSchema.safeParse(one({})).success).toBe(true)
    expect(
      DashboardSchema.safeParse(one({ ai: true, dismissed: ['jobs:1', 'index:c1:shop.orders'] })).success,
    ).toBe(true)
    expect(DashboardSchema.safeParse(one({ ai: 'yes' })).success).toBe(false)
    expect(
      DashboardSchema.safeParse(one({ dismissed: Array.from({ length: 101 }, (_, i) => `x${i}`) })).success,
    ).toBe(false)
    expect(DashboardSchema.safeParse(one({ dismissed: ['x'.repeat(301)] })).success).toBe(false)
    expect(DashboardSchema.safeParse(one({ dismissed: [''] })).success).toBe(false)
    expect(DashboardSchema.safeParse(one({ other: 1 })).success).toBe(false)
  })

  // Review I2: a dismissal saved too long (an older build's key) never makes the layout unreadable.
  it('reads a stored next steps widget with dismissals past the limits, dropping only those', () => {
    const w = {
      id: id(),
      type: 'nextActions',
      size: 'm',
      settings: {
        ai: true,
        dismissed: ['ok:1', 'x'.repeat(400), '', ...Array.from({ length: 120 }, (_, i) => `k${i}`)],
      },
    }
    const read = readDashboard({ version: 1, widgets: [w] })!
    const settings = read.widgets[0]!.settings as { ai: boolean; dismissed: string[] }
    expect(settings.ai).toBe(true)
    expect(settings.dismissed).toHaveLength(100)
    expect(settings.dismissed.every((d) => d.length > 0 && d.length <= 300)).toBe(true)
    expect(settings.dismissed.at(-1)).toBe('k119')
    // What is read back saves again.
    expect(DashboardSchema.safeParse(read).success).toBe(true)
  })

  it('refuses unknown types, settings keys, sizes, bad ids, duplicates and more than 30 widgets', () => {
    const one = (over: object) => ({
      version: 1,
      widgets: [{ id: id(), type: 'quick', size: 'm', settings: {}, ...over }],
    })
    expect(DashboardSchema.safeParse(one({})).success).toBe(true)
    expect(DashboardSchema.safeParse(one({ type: 'shell' })).success).toBe(false)
    expect(DashboardSchema.safeParse(one({ settings: { x: 1 } })).success).toBe(false)
    expect(DashboardSchema.safeParse(one({ size: 'huge' })).success).toBe(false)
    expect(DashboardSchema.safeParse(one({ id: 'nope' })).success).toBe(false)
    expect(DashboardSchema.safeParse(one({ extra: true })).success).toBe(false)
    expect(
      DashboardSchema.safeParse(
        one({ type: 'metric', settings: { connectionId: 'x', metric: 'opcounters', range: 'live' } }),
      ).success,
    ).toBe(false)
    expect(
      DashboardSchema.safeParse(
        one({ type: 'metric', settings: { connectionId: C, metric: 'cpu', range: 'live' } }),
      ).success,
    ).toBe(false)
    expect(DashboardSchema.safeParse(one({ type: 'serverStatus', settings: {} })).success).toBe(false)
    const w = { id: id(), type: 'quick', size: 'm', settings: {} }
    expect(DashboardSchema.safeParse({ version: 1, widgets: [w, w] }).success).toBe(false)
    const many = Array.from({ length: 31 }, () => onServer('serverStatus', randomUUID()))
    expect(DashboardSchema.safeParse({ version: 1, widgets: many.slice(0, 30) }).success).toBe(true)
    expect(DashboardSchema.safeParse({ version: 1, widgets: many }).success).toBe(false)
    expect(DashboardSchema.safeParse({ version: 2, widgets: [] }).success).toBe(false)
  })

  it('reads a stored layout keeping what still validates', () => {
    const good = { id: id(), type: 'quick', size: 'm', settings: {} }
    const unknown = { id: id(), type: 'fromTheFuture', size: 'm', settings: {} }
    expect(readDashboard({ version: 1, widgets: [unknown, good, good] })).toEqual({
      version: 1,
      widgets: [good],
    })
    expect(readDashboard('nope')).toBeNull()
    expect(readDashboard(null)).toBeNull()
    expect(readDashboard({ version: 2, widgets: [] })).toBeNull()
    const many = Array.from({ length: 40 }, () => onServer('serverStatus', randomUUID()))
    expect(readDashboard({ version: 1, widgets: many })!.widgets).toHaveLength(30)
  })

  // User report 2026-10-27 ("aynı sunucu durumu Demo ekleyebiliyorum saçma olmuş"): a widget is on the
  // dashboard once — one of a kind, one of a server's kind per server, one chart per metric and range.
  it('refuses the same widget twice: of a kind, of a server, of a metric and range', () => {
    const D = randomUUID()
    const ok = (...widgets: object[]) => DashboardSchema.safeParse({ version: 1, widgets }).success
    const quick = () => ({ id: id(), type: 'quick', size: 'm', settings: {} })
    const chart = (connectionId: string, metric: string, range: string) => ({
      id: id(),
      type: 'metric',
      size: 'l',
      settings: { connectionId, metric, range },
    })
    expect(ok(quick(), quick())).toBe(false)
    expect(ok(onServer('serverStatus', C), onServer('serverStatus', C))).toBe(false)
    expect(ok(onServer('serverStatus', C), onServer('serverStatus', D), onServer('replica', C))).toBe(true)
    expect(ok(chart(C, 'memory', 'live'), chart(C, 'memory', 'live'))).toBe(false)
    expect(
      ok(
        chart(C, 'memory', 'live'),
        chart(C, 'memory', '7d'),
        chart(C, 'cache', 'live'),
        chart(D, 'memory', 'live'),
      ),
    ).toBe(true)
    // The queries widget is one, whatever it shows.
    const queries = (settings: object) => ({ id: id(), type: 'queries', size: 'm', settings })
    expect(ok(queries({ view: 'saved' }), queries({ view: 'recent', connectionId: C }))).toBe(false)
  })

  it('reads a stored layout with the same widget twice keeping the first', () => {
    const first = { ...onServer('serverStatus', C), size: 'l' }
    const again = onServer('serverStatus', C)
    const other = onServer('serverStatus', randomUUID())
    expect(readDashboard({ version: 1, widgets: [first, other, again] })!.widgets).toEqual([first, other])
  })

  it('tells two widgets the same by what they show, not by their place, size or id', () => {
    const a = onServer('replica', C)
    const placed = { ...onServer('replica', C), size: 'xl', col: 4, collapsed: true }
    expect(widgetKey(a)).toBe(widgetKey(placed))
    expect(widgetKey(a)).not.toBe(widgetKey(onServer('operations', C)))
    expect(widgetKey(a)).not.toBe(widgetKey(onServer('replica', randomUUID())))
  })

  it('makes the default as today’s Overview, with fresh ids each time', () => {
    const a = defaultDashboard(id)
    expect(a.widgets.map((w) => w.type)).toEqual([
      'continue',
      'pinned',
      'attention',
      'connections',
      'queries',
      'activity',
      'quick',
      // W6.2: the next steps beside Quick links.
      'nextActions',
    ])
    expect(defaultDashboard(id).widgets[0]!.id).not.toBe(a.widgets[0]!.id)
  })

  it('keeps where a widget starts on the wide grid: a column 1 to 12, whole', () => {
    const one = (col: unknown) => ({
      version: 1,
      widgets: [{ id: id(), type: 'quick', size: 's', settings: {}, col }],
    })
    expect(DashboardSchema.safeParse(one(1)).success).toBe(true)
    expect(DashboardSchema.safeParse(one(12)).success).toBe(true)
    for (const bad of [0, 13, 1.5, -1, '3', null])
      expect(DashboardSchema.safeParse(one(bad)).success).toBe(false)
    expect(readDashboard(one(7))!.widgets[0]!.col).toBe(7)
  })

  it('keeps a widget a newer version wrote with fields it does not know, without them (final review 13)', () => {
    const w = {
      id: id(),
      type: 'metric',
      size: 'm',
      settings: { connectionId: C, metric: 'memory', range: '1h', smooth: true },
      pinnedAt: 5,
    }
    const read = readDashboard({ version: 1, widgets: [w] })!
    expect(read.widgets).toEqual([
      { id: w.id, type: 'metric', size: 'm', settings: { connectionId: C, metric: 'memory', range: '1h' } },
    ])
    // What it reads is a layout this version saves.
    expect(DashboardSchema.safeParse(read).success).toBe(true)
  })

  it('tells a layout of a newer version from none at all', () => {
    expect(isNewerDashboard({ version: 2, widgets: [] })).toBe(true)
    expect(isNewerDashboard({ version: 1, widgets: [] })).toBe(false)
    expect(isNewerDashboard(null)).toBe(false)
    expect(isNewerDashboard({ version: '9' })).toBe(false)
  })
})
