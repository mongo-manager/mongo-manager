// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, type Component } from 'vue'
import DsDataTable from '../src/ds/DsDataTable.vue'
import type { DsColumn } from '../src/ds/table'
import { mountApp } from './support/app'

/**
 * Review of the Monitoring redesign (Important 1): a data table clipped its right-hand columns — its
 * row menu included — when the fixed widths of its columns were wider than its box (a phone, a card
 * beside the sidebar). The table measures its box: lower-priority columns leave first, fixed widths
 * apply only when they fit, and the actions column always stays.
 */
type Row = { name: string; size: number; created: string; expires: string }
const rows: Row[] = [{ name: 'a.archive', size: 10, created: 'today', expires: 'tomorrow' }]
const columns: DsColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size', align: 'right', width: '6.5rem' },
  { key: 'created', label: 'Created', width: '9rem', hideBelow: 520 },
  { key: 'expires', label: 'Expires', width: '9rem', hideBelow: 640 },
]

/** A ResizeObserver that reports the given width for every box it observes. */
function boxWidth(width: number): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.callback(
          [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  )
}

const mount = (props: object = {}) =>
  mountApp(
    defineComponent(
      () => () =>
        h(
          DsDataTable as unknown as Component,
          { label: 'Backups', columns, rows, rowKey: (r: Row) => r.name, actionsLabel: 'Actions', ...props },
          { actions: () => h('button', { 'aria-label': 'Actions for a.archive' }) },
        ),
    ),
  )
const heads = () => [...document.querySelectorAll('thead th')].map((th) => th.textContent!.trim())

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('DsDataTable on a narrow box', () => {
  it('keeps every column and its widths when they fit', async () => {
    boxWidth(1000)
    mount()
    await flushPromises()
    expect(heads()).toEqual(['Name', 'Size', 'Created', 'Expires', 'Actions'])
    expect((document.querySelectorAll('thead th')[1] as HTMLElement).style.width).toBe('6.5rem')
  })

  it('drops the columns that leave first, never the actions, on a phone-wide card', async () => {
    boxWidth(324)
    mount()
    await flushPromises()
    expect(heads()).toEqual(['Name', 'Size', 'Actions'])
    expect(document.querySelectorAll('tbody tr:first-child td')).toHaveLength(3)
    expect(document.querySelector('button[aria-label="Actions for a.archive"]')).not.toBeNull()
  })

  it('lets the columns share the box when their fixed widths do not fit it', async () => {
    boxWidth(560)
    mount({
      columns: [
        { key: 'name', label: 'Name', width: '14rem' },
        { key: 'size', label: 'Size', width: '14rem' },
        { key: 'created', label: 'Created', width: '14rem' },
      ],
    })
    await flushPromises()
    const widths = [...document.querySelectorAll<HTMLElement>('thead th')].map((th) => th.style.width)
    expect(widths.slice(0, 3)).toEqual(['', '', ''])
  })

  it('gives the actions column the width asked for, and shows its actions when asked', async () => {
    boxWidth(1000)
    mount({ actionsWidth: '7rem', actionsVisible: true })
    await flushPromises()
    const head = [...document.querySelectorAll<HTMLElement>('thead th')].at(-1)!
    expect(head.style.width).toBe('7rem')
    expect(head.className).not.toContain('w-14')
    expect(document.querySelector('tbody td:last-child > div')!.className).not.toContain('opacity-0')
  })

  it('keeps its actions to hover by default, in the 3.5 rem column', async () => {
    boxWidth(1000)
    mount()
    await flushPromises()
    expect([...document.querySelectorAll('thead th')].at(-1)!.className).toContain('w-14')
    expect(document.querySelector('tbody td:last-child > div')!.className).toContain('opacity-0')
  })
})

// The callers say which columns leave first: at a phone's card width (324 px) each of these tables
// keeps at most three columns besides its actions.
describe('the tables of the redesigned screens on a phone', () => {
  const SRC = join(import.meta.dirname, '..', 'src')
  const TABLES: Array<[string, string]> = [
    ['backup/BackupsCard.vue', 'columns'],
    ['monitor/OperationsTable.vue', 'columns'],
    ['monitor/ProfilerPanel.vue', 'columns'],
    ['monitor/ReplicaSetPanel.vue', 'columns'],
    ['monitor/ShardingPanel.vue', 'shardColumns'],
    ['monitor/ShardingPanel.vue', 'routerColumns'],
    ['monitor/ShardingPanel.vue', 'collectionColumns'],
    ['monitor/IndexAdvicePanel.vue', 'columns'],
    ['gridfs/GridFsView.vue', 'fileColumns'],
    ['livesync/LiveSyncDetail.vue', 'verifyColumns'],
  ]
  it.each(TABLES)('%s (%s) keeps three columns or fewer at 324 px', (file, name) => {
    const source = readFileSync(join(SRC, file), 'utf8')
    const start = source.indexOf(`const ${name} = computed<DsColumn[]>(() => [`)
    expect(start, `${file} ${name}`).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n])', start))
    // From one column's key to the next: that column's own options.
    const entries = body.split(/\bkey: '/).slice(1)
    expect(entries.length).toBeGreaterThan(0)
    const shown = entries.filter((e) => {
      const m = /hideBelow: (\d+)/.exec(e)
      return !m || Number(m[1]) <= 324
    })
    expect(shown.length, `${file} ${name}`).toBeLessThanOrEqual(3)
  })
})
