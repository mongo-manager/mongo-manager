// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeClient, flush } from '../../kit/test/fakeClient'
import { mount } from '../src/view'

/**
 * 2026-10-26: a log of one minute drew its timeline as one block the chart's whole width, the same
 * time at both ends. A bar keeps a bar's width, the few there are stand in the middle, and one time
 * is said once.
 */
const at = (minute: number) => `2026-10-26T10:${String(minute).padStart(2, '0')}:00Z`
const line = (minute: number) =>
  JSON.stringify({ t: { $date: at(minute) }, s: 'I', c: 'NETWORK', id: 1, msg: 'Connection accepted' })

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
})
const app = () => document.getElementById('app')!
async function opened(minutes: number[]) {
  const fake = fakeClient({ place: null, kind: 'sidebarPanel', id: 'logs' }, {})
  mount(app(), fake.client)
  fake.greet()
  await flush()
  const input = app().querySelector<HTMLInputElement>('#file')!
  const content = minutes.map(line).join('\n')
  Object.defineProperty(input, 'files', { value: [new File([content], 'mongod.log')], configurable: true })
  input.dispatchEvent(new Event('change'))
  await flush(12)
}
const bars = () =>
  [...app().querySelectorAll('.la-chart rect.la-bar')].map((r) => ({
    x: Number(r.getAttribute('x')),
    w: Number(r.getAttribute('width')),
  }))

describe('the timeline', () => {
  it('draws one minute as a bar of its own width, in the middle', async () => {
    await opened([1, 1, 1])
    const [bar] = bars()
    expect(bars()).toHaveLength(1)
    expect(bar!.w).toBeLessThanOrEqual(48)
    // Centred in the chart's 720 units.
    expect(Math.abs(bar!.x + bar!.w / 2 - 360)).toBeLessThan(1)
  })

  it('keeps a few bars a bar’s width each, together in the middle', async () => {
    await opened([1, 2, 3])
    const drawn = bars()
    expect(drawn).toHaveLength(3)
    for (const b of drawn) expect(b.w).toBeLessThanOrEqual(48)
    const left = drawn[0]!.x
    const right = drawn[2]!.x + drawn[2]!.w
    expect(Math.abs((left + right) / 2 - 360)).toBeLessThan(1)
  })

  it('says the time of one minute once, under its bar', async () => {
    await opened([1, 1])
    const axis = app().querySelector('.la-axis')!
    // Review 2026-10-26 (M6): bars in the middle, their times under them, not at the chart's ends.
    expect(axis.classList.contains('la-axis-centred')).toBe(true)
    expect(axis.textContent!.match(/10:01/g)).toHaveLength(1)
  })

  it('says a few minutes’ first and last time under their bars', async () => {
    await opened([1, 2, 3])
    const axis = app().querySelector('.la-axis')!
    expect(axis.classList.contains('la-axis-centred')).toBe(true)
    expect(axis.textContent).toMatch(/10:01.*10:03/)
  })

  it('still spreads many minutes over the whole width', async () => {
    await opened(Array.from({ length: 50 }, (_, i) => i))
    const drawn = bars()
    expect(drawn[0]!.x).toBeLessThanOrEqual(1)
    const last = drawn.at(-1)!
    expect(last.x + last.w).toBeGreaterThan(710)
    // Spread over the chart: its times at its ends, as before.
    expect(app().querySelector('.la-axis')!.classList.contains('la-axis-centred')).toBe(false)
  })
})
