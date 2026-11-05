// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { Analyzer } from '../src/analyze'
import { mount, TEXT } from '../src/view'

/** Plugins wave 3, the third review of the branch: the log analyzer's page. */
const line = (o: Record<string, unknown>) =>
  JSON.stringify({ t: { $date: '2026-10-26T10:00:00Z' }, s: 'I', c: 'X', id: 1, msg: 'a', ...o })
const slow = (i: number) =>
  line({
    c: 'COMMAND',
    id: 51803,
    msg: 'Slow query',
    attr: {
      type: 'command',
      ns: 'shop.orders',
      command: { find: 'orders', filter: { [`k${i}`]: 1 } },
      planSummary: 'COLLSCAN',
      durationMillis: 100 + i,
    },
  })
const LOG = [slow(1), slow(2), slow(3)].join('\n')

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
afterEach(() => vi.restoreAllMocks())
const app = () => document.getElementById('app')!

async function opened(content: string) {
  const fake = fakeClient({ place: null, kind: 'sidebarPanel', id: 'logs' }, { 'ui.copy': () => true })
  mount(app(), fake.client)
  fake.greet()
  await flush()
  const input = app().querySelector<HTMLInputElement>('#file')!
  input.focus()
  Object.defineProperty(input, 'files', { value: [new File([content], 'mongod.log')], configurable: true })
  input.dispatchEvent(new Event('change'))
  await flush(12)
  return fake
}

describe('the focus after a read (third review)', () => {
  it('never takes the focus back when the page no longer has it', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await opened(LOG)
    expect(app().querySelector('#summary-title')).not.toBeNull()
    expect(document.activeElement).not.toBe(app().querySelector('#summary-title'))
  })

  it('moves it to the summary when the page still has it', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await opened(LOG)
    expect(document.activeElement).toBe(app().querySelector('#summary-title'))
  })
})

describe('the status line (third review)', () => {
  it('is said once: a redraw that changes nothing in it never touches it', async () => {
    await opened(LOG)
    const status = app().querySelector('#status')!
    expect(status.textContent).toBe('Read mongod.log: 3 lines.')
    const changes: MutationRecord[] = []
    const watch = new MutationObserver((records) => changes.push(...records))
    watch.observe(status, { childList: true, characterData: true, subtree: true })
    app().querySelector<HTMLButtonElement>('#sort [data-value="count"]')!.click()
    await flush()
    app().querySelector<HTMLButtonElement>('#sort [data-value="total"]')!.click()
    await flush()
    changes.push(...watch.takeRecords())
    watch.disconnect()
    expect(changes).toEqual([])
    expect(status.textContent).toBe('Read mongod.log: 3 lines.')
  })
})

describe('what is counted past the caps (third review)', () => {
  it('says how many lines had a severity or a component past those kept by name', async () => {
    const letters = 'ABCGHJKLMNOPQRSTUVXYZ'
    const lines = [
      ...Array.from({ length: 205 }, (_, i) => line({ c: `C${i}` })),
      ...[...letters].map((s) => line({ s })),
    ]
    const counted = new Analyzer()
    for (const l of lines) counted.add(l)
    const { otherSeverities, otherComponents } = counted.result()
    expect(otherSeverities).toBeGreaterThan(0)
    expect(otherComponents).toBeGreaterThan(0)
    await opened(lines.join('\n'))
    const note = app().querySelector('#other-kinds')!
    expect(note).not.toBeNull()
    expect(note.textContent).toContain(
      TEXT.en.otherKinds(otherSeverities, String(otherSeverities), otherComponents, String(otherComponents)),
    )
    expect(TEXT.tr.otherKinds(1, '1', 2, '2')).toContain('2 satır')
  })
})
