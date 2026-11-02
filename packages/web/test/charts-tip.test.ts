import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import LineChart from '../src/charts/LineChart.vue'
import BarChart from '../src/charts/BarChart.vue'
import { tipPlacement } from '../src/charts/tip'
import { mountApp } from './support/app'

/**
 * User report 2026-10-16: the tooltip of "Operations per second" was cut in half — drawn on the
 * chart's own canvas, it could not leave the chart. The app draws it now, above the page, as text.
 */
let listeners: Record<string, (params: unknown) => void> = {}
vi.mock('../src/charts/lazy', () => ({
  LazyVChart: defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs }) {
      return () => {
        listeners = Object.fromEntries(
          Object.entries(attrs)
            .filter(([k]) => k.startsWith('on'))
            .map(([k, v]) => [k.slice(2).toLowerCase(), v as (p: unknown) => void]),
        )
        return h('canvas', { 'data-chart': '' })
      }
    },
  }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  listeners = {}
})
afterEach(() => {
  document.body.innerHTML = ''
})

const tip = () => document.querySelector<HTMLElement>('[data-chart-tip]')
const pointAt = (x: number, y: number) =>
  document
    .querySelector('[data-chart]')!
    .parentElement!.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }))

describe('chart tooltips drawn by the app', () => {
  it('shows every series at the pointed sample above the page, as text', async () => {
    mountApp(LineChart, {
      props: {
        label: 'Operations per second',
        series: [
          { name: 'query', points: [1, 2, 3] },
          { name: '<img src=x onerror=alert(1)>', points: [7, 8] },
        ],
        format: (v: number) => `${v}/s`,
      },
    })
    await flushPromises()
    pointAt(100, 100)
    listeners.updateaxispointer!({ axesInfo: [{ value: 1 }] })
    await flushPromises()
    const shown = tip()!
    expect(shown.parentElement).toBe(document.body)
    expect(shown.textContent).toContain('query')
    expect(shown.textContent).toContain('2/s')
    // The later series is aligned to the right: its first point is at index 1.
    expect(shown.textContent).toContain('7/s')
    expect(shown.querySelector('img')).toBeNull()
    expect(shown.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(shown.getAttribute('aria-hidden')).toBe('true')
    document.querySelector('[data-chart]')!.parentElement!.dispatchEvent(new MouseEvent('mouseleave'))
    await flushPromises()
    expect(tip()).toBeNull()
  })

  it('shows the pointed bar', async () => {
    mountApp(BarChart, {
      props: { label: 'Sizes', items: [{ label: 'orders', value: 5 }], format: (v: number) => `${v} MB` },
    })
    await flushPromises()
    pointAt(50, 50)
    listeners.mouseover!({ dataIndex: 0, seriesType: 'bar' })
    await flushPromises()
    expect(tip()!.textContent).toContain('orders')
    expect(tip()!.textContent).toContain('5 MB')
    listeners.globalout!({})
    await flushPromises()
    expect(tip()).toBeNull()
  })

  it('keeps the tooltip inside the window, flipping beside the pointer', () => {
    const view = { width: 400, height: 300 }
    expect(tipPlacement({ x: 100, y: 100 }, { width: 120, height: 80 }, view)).toEqual({
      left: 112,
      top: 112,
    })
    // Near the right and bottom edges it goes left and up of the pointer.
    expect(tipPlacement({ x: 350, y: 280 }, { width: 120, height: 80 }, view)).toEqual({
      left: 218,
      top: 188,
    })
    // Larger than the room on both sides: pinned to the edge, never off screen.
    expect(tipPlacement({ x: 10, y: 10 }, { width: 500, height: 80 }, view).left).toBe(8)
  })
})
