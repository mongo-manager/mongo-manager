// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePreferencesStore } from '../src/stores/preferences'
import LineChart from '../src/charts/LineChart.vue'
import BarChart from '../src/charts/BarChart.vue'
import { i18n } from '../src/i18n'
import { mountApp } from './support/app'
import { chartOptions, pick } from './support/dom'

beforeEach(() => {
  setActivePinia(createPinia())
  i18n.global.locale.value = 'en'
})
afterEach(() => {
  document.body.innerHTML = ''
})

describe('LineChart (on ECharts, phase 1j)', () => {
  it('draws one series per input and says the latest values in its name and a hidden table', async () => {
    mountApp(LineChart, {
      props: {
        label: 'Operations per second',
        series: [
          { name: 'insert', points: [1, 2, 3] },
          { name: 'query', points: [4, 5, 6] },
        ],
        format: (v: number) => `${v}/s`,
      },
    })
    await flushPromises()
    const [chart] = chartOptions()
    expect(chart!.label).toBe('Operations per second: insert 3/s, query 6/s')
    expect((pick(chart!.option, 'series') as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'insert',
      'query',
    ])
    const cells = [...document.querySelectorAll('.sr-only table td')].map((c) => c.textContent)
    expect(cells).toEqual(['insert', '3/s', 'query', '6/s'])
  })

  it('waits for data when there is none', async () => {
    mountApp(LineChart, { props: { label: 'x', series: [{ name: 'a', points: [] }] } })
    await flushPromises()
    expect(document.body.textContent).toContain('Waiting for data')
  })
})

describe('BarChart (on ECharts, phase 1j)', () => {
  it('draws the bars in order with their labels, and a hidden table', async () => {
    mountApp(BarChart, {
      props: {
        label: 'Index size',
        items: [
          { label: '_id_', value: 100 },
          { label: 'n_1', value: 25 },
        ],
        format: (v: number) => `${v} B`,
      },
    })
    await flushPromises()
    const [chart] = chartOptions()
    expect(pick(chart!.option, 'yAxis.data')).toEqual(['_id_', 'n_1'])
    expect(pick(chart!.option, 'series.0.data')).toEqual([100, 25])
    const cells = [...document.querySelectorAll('.sr-only table td')].map((c) => c.textContent)
    expect(cells).toEqual(['_id_', '100 B', 'n_1', '25 B'])
  })
})

describe('a chart follows the theme (final review 1j, Minor 13)', () => {
  it('redraws with the dark colours when the theme switches, without a remount', async () => {
    mountApp(LineChart, { props: { label: 'x', series: [{ name: 'a', points: [1, 2] }] } })
    await flushPromises()
    const preferences = usePreferencesStore()
    preferences.setTheme('light')
    await flushPromises()
    const light = pick(chartOptions()[0]!.option, 'yAxis.splitLine.lineStyle.color')
    preferences.setTheme('dark')
    await flushPromises()
    const dark = pick(chartOptions()[0]!.option, 'yAxis.splitLine.lineStyle.color')
    expect(light).toBeTruthy()
    expect(dark).toBeTruthy()
    expect(dark).not.toBe(light)
    preferences.setTheme('light')
  })
})
