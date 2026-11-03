import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { defineComponent, h, nextTick, ref, type Component } from 'vue'
import DsPageHeader from '../src/ds/DsPageHeader.vue'
import DsProgress from '../src/ds/DsProgress.vue'
import DsDataTable from '../src/ds/DsDataTable.vue'
import DsSpinner from '../src/ds/DsSpinner.vue'
import DsSkeleton from '../src/ds/DsSkeleton.vue'
import DsCard from '../src/ds/DsCard.vue'
import DsMenu from '../src/ds/DsMenu.vue'
import DsSegmented from '../src/ds/DsSegmented.vue'
import { mountApp } from './support/app'

// UI redesign R2–R5 spec §1–2: the page patterns' components and their ARIA contracts.
afterEach(() => {
  document.body.innerHTML = ''
})

describe('DsPageHeader', () => {
  it('names the page at its level, with its facts and actions', () => {
    mountApp(
      defineComponent(
        () => () =>
          h(
            DsPageHeader,
            { title: 'orders', context: 'shop', facts: ['36 documents', '11.5 KB'], level: 1 },
            { actions: () => h('button', 'New'), badges: () => h('span', 'View') },
          ),
      ),
    )
    const heading = document.querySelector('h1')!
    expect(heading.textContent).toContain('orders')
    expect(heading.textContent).toContain('View')
    // The "·" between facts is drawn, not read (aria-hidden); the gap between them is the layout's.
    const facts = [...document.querySelectorAll('header p > span:not([aria-hidden])')].map(
      (e) => e.textContent,
    )
    expect(facts).toEqual(['shop', '36 documents', '11.5 KB'])
    expect(document.querySelectorAll('header p > span[aria-hidden="true"]')).toHaveLength(2)
    expect(document.querySelector('header button')!.textContent).toBe('New')
  })

  // Review of R3–R5 (I-2): on a narrow screen the actions move under the title rather than squeeze
  // it to nothing, and wrap among themselves.
  it('wraps its actions under the title when the line is too narrow', () => {
    mountApp(
      defineComponent(
        () => () =>
          h(
            DsPageHeader,
            { title: 'Jobs', description: 'All of them' },
            { actions: () => h('button', 'Go') },
          ),
      ),
    )
    const row = document.querySelector('header h2')!.parentElement!.parentElement!
    expect(row.className).toContain('flex-wrap')
    expect(document.querySelector('header h2')!.parentElement!.className).toMatch(/\bbasis-/)
    const actions = document.querySelector('header button')!.parentElement!
    expect(actions.className).toContain('flex-wrap')
    expect(actions.className).not.toContain('shrink-0')
  })

  it('is a second-level heading by default and leaves out an empty facts line', () => {
    mountApp(defineComponent(() => () => h(DsPageHeader, { title: 'Backups' })))
    expect(document.querySelector('h2')!.textContent).toContain('Backups')
    expect(document.querySelector('header p')).toBeNull()
  })

  // R4: a page says what it is for under its title; a tab, which shows facts, does not.
  it('says what a page is for under its title, after its facts', () => {
    mountApp(
      defineComponent(
        () => () =>
          h(DsPageHeader, {
            title: 'Schedules',
            facts: ['3 schedules'],
            description: 'Back up on a timetable.',
          }),
      ),
    )
    const lines = [...document.querySelectorAll('header p')].map((p) => p.textContent!.trim())
    expect(lines).toEqual(['3 schedules', 'Back up on a timetable.'])
  })
})

// UI redesign R2–R5 spec §5 (R4): every list page opens on the shared page header and draws its
// loading, error and empty states with the kit — no hand-made header, pulse boxes or red boxes.
describe('the R4 pages', () => {
  const SRC = join(import.meta.dirname, '..', 'src')
  const PAGES = [
    'destinations/DestinationsView.vue',
    'schedules/SchedulesView.vue',
    'livesync/LiveSyncsView.vue',
    'jobs/JobsView.vue',
    'transfer/SqlTransferView.vue',
  ]
  it.each(PAGES)('%s uses the kit’s page header and states', (page) => {
    const source = readFileSync(join(SRC, page), 'utf8')
    const template = source.slice(source.indexOf('<template>'))
    expect(template).toContain('<DsPageHeader')
    expect(template).not.toMatch(/<header\b/)
    expect(template).not.toContain('animate-pulse')
    expect(template).not.toMatch(/border-danger\/25 bg-danger-soft/)
    expect(template).not.toMatch(/border-warning\/25 bg-warning-soft/)
    expect(template).not.toMatch(/<input\b/)
  })

  // R5: the administration, AI, library and plugin pages open on the same header (a hidden file input
  // behind an Upload button is the only raw control they keep).
  const R5 = [
    'admin/UsersView.vue',
    'admin/AuditView.vue',
    'admin/PluginsView.vue',
    'admin/PluginDetailsView.vue',
    'library/LibraryView.vue',
    'ai/AiSettingsView.vue',
    'ai/history/AiHistoryView.vue',
  ]
  it.each(R5)('%s uses the kit’s page header', (page) => {
    const source = readFileSync(join(SRC, page), 'utf8')
    const template = source.slice(source.indexOf('<template>'))
    expect(template).toContain('<DsPageHeader')
    expect(template).not.toMatch(/<header\b/)
    expect(template).not.toMatch(/<input\b(?![^>]*type="file")/)
  })

  // Review of R3–R5 (I-5): every page draws its states with the kit — skeletons with a spoken status
  // while loading, callouts with a Retry for errors — never a spinner and a word, a lone red line or
  // a red box drawn by hand; its lists and choices are the kit's too.
  it.each([...PAGES, ...R5, 'transfer/CompareView.vue', 'account/AccountView.vue'])(
    '%s draws its states and lists with the kit',
    (page) => {
      const source = readFileSync(join(SRC, page), 'utf8')
      const template = source.slice(source.indexOf('<template>'))
      expect(template).not.toMatch(/<DsSpinner\b/)
      expect(template).not.toMatch(/<p\b[^>]*role="alert"[^>]*class="[^"]*text-danger/s)
      expect(template).not.toMatch(/border-danger\/\d+ bg-danger-soft/)
      expect(template).not.toMatch(/<select\b/)
    },
  )

  // UI review of R3–R5: a page whose whole content switches between sections shows its tabs in its
  // header, as the connection and database tabs do.
  it.each(['admin/UsersView.vue', 'workspace/tabs/ConnectionTab.vue', 'workspace/tabs/DatabaseTab.vue'])(
    '%s shows its section tabs in its header',
    (page) => {
      const source = readFileSync(join(SRC, page), 'utf8')
      const tabs = source.indexOf('<DsTabs')
      expect(tabs).toBeGreaterThan(source.indexOf('<DsPageHeader'))
      expect(tabs).toBeLessThan(source.indexOf('</DsPageHeader>'))
    },
  )

  // UI review of R3–R5: a page header's actions are one size, the size the tabs' headers use.
  it.each([
    ...PAGES,
    ...R5,
    'account/AccountView.vue',
    'transfer/CompareView.vue',
    'workspace/tabs/ConnectionTab.vue',
    'workspace/tabs/DatabaseTab.vue',
  ])('%s keeps its header buttons small', (page) => {
    const source = readFileSync(join(SRC, page), 'utf8')
    // A header without actions closes itself and has no buttons.
    const end = source.indexOf('</DsPageHeader>')
    const header = end < 0 ? '' : source.slice(source.indexOf('<DsPageHeader'), end)
    const buttons = header.match(/<DsButton\b[^>]*>/gs) ?? []
    expect(buttons.filter((b) => !/\bsize="sm"/.test(b))).toEqual([])
    // Its "…" too, at the small buttons' height, and its links styled as them (review minor 5).
    const menus = header.match(/<DsMenu\b[^>]*>/gs) ?? []
    expect(menus.filter((m) => !/\bsize="header"/.test(m))).toEqual([])
    expect(header).not.toMatch(/<a\b[^>]*class="[^"]*\bh-8\b/s)
  })

  it('draws its header "…" at the small buttons’ height', () => {
    mountApp(defineComponent(() => () => h(DsMenu, { label: 'More', items: [], size: 'header' })))
    expect(document.querySelector('button[aria-label="More"]')!.className).toContain('size-7')
  })
})

// UI redesign R3 §4 (Monitoring): the Performance section is cards on the kit — data tables, kit
// fields, states drawn with the kit — its time span in the connection's header, and Kill only in a
// row's menu (never a red button on every row).
describe('the Monitoring screens', () => {
  const SRC = join(import.meta.dirname, '..', 'src')
  const read = (f: string) => readFileSync(join(SRC, f), 'utf8')
  const template = (f: string) => {
    const source = read(f)
    return source.slice(source.indexOf('<template>'))
  }
  const SCREENS = [
    'monitor/PerformanceView.vue',
    'monitor/HistoryControls.vue',
    'monitor/ReplicaSetPanel.vue',
    'monitor/OperationsTable.vue',
    'monitor/OperationsFilter.vue',
    'monitor/ProfilerPanel.vue',
    'monitor/SlowQueriesPanel.vue',
    'monitor/ShardingPanel.vue',
    'monitor/IndexAdvicePanel.vue',
  ]

  it.each(SCREENS)('%s uses the kit’s controls, tables and states', (f) => {
    const html = template(f)
    expect(html).not.toMatch(/<(?:select|input|table|textarea)\b/)
    expect(html).not.toMatch(/<DsSpinner\b/)
    expect(html).not.toMatch(/<p\b[^>]*role="alert"/s)
    expect(html).not.toMatch(/<h[2-6]\b[^>]*class="text-ui font-semibold"/)
    expect(html).not.toContain('animate-pulse')
  })

  it.each(SCREENS.filter((f) => !/HistoryControls|OperationsFilter/.test(f)))('%s is made of cards', (f) => {
    expect(template(f)).toMatch(/<DsCard\b|<(?:ReplicaSetPanel|ShardingPanel)\b/)
  })

  it('lists members, operations, databases, shards and suggestions in data tables', () => {
    for (const f of [
      'monitor/ReplicaSetPanel.vue',
      'monitor/OperationsTable.vue',
      'monitor/ProfilerPanel.vue',
      'monitor/ShardingPanel.vue',
      'monitor/IndexAdvicePanel.vue',
    ])
      expect(template(f), f).toContain('<DsDataTable')
    expect(template('monitor/ReplicaSetPanel.vue')).toContain('<DsStatusDot')
  })

  it('kills an operation from its row menu in danger colour, never from a red button', () => {
    const source = read('monitor/OperationsTable.vue')
    expect(source).toMatch(/id: 'kill'[^}]*danger: true/)
    expect(template('monitor/OperationsTable.vue')).not.toMatch(/variant="danger"|text-danger/)
  })

  it('chooses the time span in the connection header, with the header’s small controls', () => {
    const tab = read('workspace/tabs/ConnectionTab.vue')
    const header = tab.slice(tab.indexOf('<DsPageHeader'), tab.indexOf('</DsPageHeader>'))
    expect(header).toContain('<HistoryControls')
    expect(template('monitor/PerformanceView.vue')).not.toContain('<HistoryControls')
    const controls = template('monitor/HistoryControls.vue')
    expect(controls).toMatch(/<DsSegmented\b[^>]*\bsize="sm"/s)
    for (const menu of controls.match(/<DsMenu\b[^>]*>/gs) ?? []) expect(menu).toMatch(/\bsize="header"/)
    expect(controls).not.toMatch(/<DsButton\b/)
  })

  it('announces no figure that refreshes by itself', () => {
    for (const f of SCREENS) expect(template(f), f).not.toMatch(/aria-live="(?:polite|assertive)"/)
  })
})

// Review of R3–R5, minor 15: a page that may be open in two tabs at once (SQL transfer is kept open
// per tab) names its parts with ids of its own, never a fixed id another copy also has.
describe('pages open more than once', () => {
  it.each(['transfer/SqlTransferView.vue', 'admin/PluginsView.vue'])('%s has no fixed id', (page) => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', page), 'utf8')
    const template = source.slice(source.indexOf('<template>'))
    expect(
      template.match(
        /\s(?:id|id-prefix|panel-id|aria-labelledby|aria-controls|aria-describedby|for)="[^"]+"/g,
      ) ?? [],
    ).toEqual([])
  })
})

// Review of R3–R5 (I-7): a module sits under its page's title (h2), so its own title is an h3; on
// Home, whose title is the h1, its widgets ask for h2.
describe('DsCard heading level', () => {
  it('is a third-level heading under a page, and the level asked for elsewhere', () => {
    mountApp(defineComponent(() => () => h(DsCard, { title: 'Indexes' })))
    expect(document.querySelector('section h3')!.textContent).toContain('Indexes')
    document.body.innerHTML = ''
    mountApp(defineComponent(() => () => h(DsCard, { title: 'Server', level: 2 })))
    expect(document.querySelector('section h2')!.textContent).toContain('Server')
  })
})

describe('DsPageHeader crumbs', () => {
  it('puts a way back above the title', () => {
    mountApp(
      defineComponent(
        () => () => h(DsPageHeader, { title: 'Hello' }, { crumbs: () => h('button', 'Back to plugins') }),
      ),
    )
    const header = document.querySelector('header')!
    expect(header.firstElementChild!.textContent).toBe('Back to plugins')
    expect(header.querySelector('h2')!.textContent).toContain('Hello')
  })
})

describe('DsProgress', () => {
  const bar = (props: object) => {
    mountApp(defineComponent(() => () => h(DsProgress, { label: 'Building', ...props })))
    return document.querySelector('[role="progressbar"]')!
  }

  it('says how far along, within 0–100', () => {
    expect(bar({ value: 0.4 }).getAttribute('aria-valuenow')).toBe('40')
    document.body.innerHTML = ''
    expect(bar({ value: 1.7 }).getAttribute('aria-valuenow')).toBe('100')
    document.body.innerHTML = ''
    expect(bar({ value: 0.25, valueText: '1 of 4' }).getAttribute('aria-valuetext')).toBe('1 of 4')
  })

  it('says only that it is under way when how far is not known', () => {
    const el = bar({})
    expect(el.getAttribute('aria-label')).toBe('Building')
    expect(el.hasAttribute('aria-valuenow')).toBe(false)
  })

  // UI redesign R3 leftovers: a job still running says what is known ("still running, 3 min"), and
  // how full a space is, is a meter rather than a task's progress.
  it('says what is known while how far is not, and measures as a meter', () => {
    expect(bar({ valueText: 'Still running, 3 min' }).getAttribute('aria-valuetext')).toBe(
      'Still running, 3 min',
    )
    document.body.innerHTML = ''
    mountApp(defineComponent(() => () => h(DsProgress, { label: 'Storage', value: 0.9, meter: true })))
    const meter = document.querySelector('[role="meter"]')!
    expect(meter.getAttribute('aria-valuenow')).toBe('90')
    expect(document.querySelector('[role="progressbar"]')).toBeNull()
  })
})

// UI redesign R3 leftovers (the gap audit): bars, selects, tables and section errors are the kit's.
describe('the leftovers of the old look', () => {
  const SRC = join(import.meta.dirname, '..', 'src')
  const vueFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? vueFiles(join(dir, e.name)) : e.name.endsWith('.vue') ? [join(dir, e.name)] : [],
    )
  const screens = () =>
    vueFiles(SRC)
      .filter((f) => !f.includes(`${sep}ds${sep}`))
      .map((f) => ({ name: relative(SRC, f).split(sep).join('/'), source: readFileSync(f, 'utf8') }))

  it('draws no progress bar or meter by hand', () => {
    const found = screens()
      .filter(({ source }) => /role="(?:progressbar|meter)"/.test(source))
      .map(({ name }) => name)
    expect(found).toEqual([])
  })

  // A stage's operator is the accent-tinted chip at the head of its card (its identity, not a field).
  // W2.5 (2026-10-16): a stage's operator is a searchable combobox now, the last plain select gone.
  it('uses the kit’s select everywhere', () => {
    const found = screens()
      .filter(({ source }) => /<select\b/.test(source))
      .map(({ name }) => name)
    expect(found).toEqual([])
  })

  it.each(['backup/BackupsCard.vue', 'workspace/tabs/PersonalDataCard.vue', 'workspace/tabs/AccessCard.vue'])(
    '%s is a card with a data table and the kit’s fields',
    (f) => {
      const source = readFileSync(join(SRC, f), 'utf8')
      const template = source.slice(source.indexOf('<template>'))
      expect(template).toMatch(/^<template>\s*<DsCard\b/)
      expect(template).toContain('<DsDataTable')
      expect(template).not.toMatch(/<(?:select|input|table)\b/)
      expect(template).not.toMatch(/<p\b[^>]*role="alert"[^>]*class="[^"]*text-ui text-danger/s)
    },
  )

  it('deletes a backup from its row menu in danger colour, never from a red button', () => {
    const source = readFileSync(join(SRC, 'backup/BackupsCard.vue'), 'utf8')
    expect(source).toMatch(/id: 'delete'[^}]*danger: true/)
    expect(source.slice(source.indexOf('<template>'))).not.toContain('text-danger')
  })
})

describe('DsDataTable', () => {
  type Row = { name: string; size: number }
  const rows: Row[] = [
    { name: 'a_1', size: 10 },
    { name: 'b_1', size: 2048 },
  ]
  const columns = [
    { key: 'name', label: 'Name', mono: true },
    { key: 'size', label: 'Size', align: 'right' as const },
  ]
  const table = (props: object, slots: Record<string, unknown> = {}) =>
    mountApp(
      defineComponent(
        () => () =>
          h(
            DsDataTable as unknown as Component,
            { label: 'Indexes', columns, rows, rowKey: (r: Row) => r.name, ...props },
            slots,
          ),
      ),
    )

  it('is a named table with column headers, cells and a row actions column', () => {
    table(
      { actionsLabel: 'Actions', current: 'b_1' },
      {
        'cell-size': ({ row }: { row: Row }) => `${row.size} B`,
        actions: ({ row }: { row: Row }) => h('button', { 'aria-label': `More for ${row.name}` }),
      },
    )
    const el = document.querySelector('table')!
    expect(el.getAttribute('aria-label')).toBe('Indexes')
    const heads = [...el.querySelectorAll('th')].map((th) => th.textContent!.trim())
    expect(heads).toEqual(['Name', 'Size', 'Actions'])
    expect(el.querySelectorAll('th[scope="col"]')).toHaveLength(3)
    const cells = [...el.querySelectorAll('tbody tr:first-child td')].map((td) => td.textContent!.trim())
    expect(cells.slice(0, 2)).toEqual(['a_1', '10 B'])
    expect(el.querySelector('button[aria-label="More for b_1"]')).not.toBeNull()
    expect(el.querySelector('tbody tr[aria-current="true"]')!.textContent).toContain('b_1')
  })

  // Review of K+R2 (I4, minors): a head that sticks to the page's scroller, actions that stay while
  // their menu is open, a loading state that says it is loading, and an error in the table's place.
  it('keeps its head sticky to the page and a row’s actions shown while their menu is open', () => {
    table({ actionsLabel: 'Actions' }, { actions: () => h('button', { 'aria-expanded': 'true' }) })
    const wrapper = document.querySelector('table')!.parentElement!
    expect(wrapper.className).not.toMatch(/overflow-(x-)?(auto|scroll|hidden)/)
    // Review of R3 (I-2): clipped, not scrolled — and fixed columns, so a long name truncates in its
    // cell instead of pushing the table past its card.
    expect(wrapper.className).toContain('overflow-x-clip')
    expect(document.querySelector('table')!.className).toContain('table-fixed')
    const actions = document.querySelector('tbody td:last-child > div')!
    expect(actions.className).toContain('has-[[aria-expanded=true]]:opacity-100')
    // Review of R3–R5 (I-3): a long value ends in an ellipsis inside its own cell, never over the next
    // one; the actions column holds a 44 px touch trigger and its padding.
    for (const td of document.querySelectorAll('tbody td:not(:last-child)'))
      expect(td.className).toMatch(/overflow-hidden.*text-ellipsis|text-ellipsis.*overflow-hidden/)
    expect(document.querySelector('thead th:last-child')!.className).toContain('w-14')
  })

  it('says it is loading, and shows an error with its retry in the table’s place', () => {
    table({ loading: true, loadingLabel: 'Loading indexes' })
    expect(document.querySelector('[role="status"]')!.getAttribute('aria-label')).toBe('Loading indexes')
    document.body.innerHTML = ''
    table({ error: 'Server unreachable' }, { retry: () => h('button', 'Retry') })
    expect(document.querySelector('table')).toBeNull()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Server unreachable')
    expect(document.body.textContent).toContain('Retry')
  })

  it('shows its empty and loading states in the table’s place', () => {
    table({ rows: [] }, { empty: () => h('p', 'No indexes') })
    expect(document.querySelector('table')).toBeNull()
    expect(document.body.textContent).toContain('No indexes')
    document.body.innerHTML = ''
    table({ loading: true })
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    expect(document.querySelector('table')).toBeNull()
  })
})

// Review of K+R2 (minors): the wide forms open as wide as before the kit merge, and a footer with
// three buttons wraps on a phone rather than clipping.
describe('dialogs after the kit merge', () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8')
  it('opens the wizards and the connection form wide', () => {
    // User request 2026-10-16: a short form, anchored at the top so Advanced options grow it downward.
    expect(src('connections/ConnectionDialog.vue')).toMatch(/<DsDialog[^>]*size="lg"[^>]*align="top"/s)
    for (const f of [
      'transfer/CopyWizard.vue',
      'transfer/ImportWizard.vue',
      'transfer/ExportDataDialog.vue',
      'livesync/LiveSyncWizard.vue',
    ])
      expect(src(f), f).toMatch(/<DsDialog[^>]*\bsize="xl"/s)
  })
  it('wraps a dialog footer', () => {
    expect(src('ds/DsDialog.vue')).toMatch(/<footer[^>]*class="[^"]*\bflex-wrap\b/s)
  })
})

// Review of K+R2 (minor): a labelled spinner is announced (UiSpinner was a status; DsSpinner was an image).
describe('DsSpinner', () => {
  it('is a status when it says what is loading, and hidden when it says nothing', () => {
    mountApp(defineComponent(() => () => [h(DsSpinner, { label: 'Loading providers' }), h(DsSpinner)]))
    const [labelled, bare] = [...document.querySelectorAll('svg')]
    expect(labelled!.getAttribute('role')).toBe('status')
    expect(labelled!.getAttribute('aria-label')).toBe('Loading providers')
    expect(bare!.getAttribute('aria-hidden')).toBe('true')
  })
})

// R4/R5: a placeholder takes the shape of what it stands in for. Its own small rounding came after
// rounded-card, -lg and -full in the stylesheet and won, so a pill or a card placeholder lost its shape.
describe('DsSkeleton', () => {
  const skeleton = (cls?: string) => {
    mountApp(defineComponent(() => () => h(DsSkeleton, cls ? { class: cls } : {})))
    return document.querySelector('[aria-hidden="true"]')!.className.split(' ')
  }
  it('keeps the rounding it is given', () => {
    const classes = skeleton('h-8 w-28 rounded-full')
    expect(classes).toContain('rounded-full')
    expect(classes).not.toContain('rounded-md')
  })
  it('is slightly rounded when given none', () => {
    expect(skeleton('h-4')).toContain('rounded-md')
  })

  // Review of R3–R5, minor 6: a rounding given as an object, or changed later, counts as well.
  it('follows a rounding given as an object, and a change of it', async () => {
    const pill = ref(true)
    mountApp(
      defineComponent(() => () => h(DsSkeleton, { class: { 'h-8': true, 'rounded-full': pill.value } })),
    )
    const el = () => document.querySelector('[aria-hidden="true"]')!.className.split(' ')
    expect(el()).toContain('rounded-full')
    expect(el()).not.toContain('rounded-md')
    pill.value = false
    await nextTick()
    expect(el()).toContain('rounded-md')
  })
})

// The narrow screen review (390 px): the library's five kinds overflowed their card. A segmented
// control is never wider than its box; its choices wrap instead.
describe('DsSegmented on a narrow screen', () => {
  it('stays within its box, wrapping its choices', () => {
    mountApp(
      defineComponent(
        () => () =>
          h(DsSegmented, {
            label: 'Kind',
            modelValue: 'a',
            options: ['a', 'b', 'c'].map((v) => ({ value: v, label: v })),
          }),
      ),
    )
    const group = document.querySelector('[role="radiogroup"]')!
    expect(group.className).toContain('max-w-full')
    expect(group.className).toContain('flex-wrap')
  })
})
