// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { barOption, lineOption, type ChartTheme } from '../src/charts/options'
import { pick } from './support/dom'

const theme: ChartTheme = {
  surface: '#ffffff',
  text: '#344054',
  muted: '#667085',
  grid: '#e4e7ec',
  palette: ['#465fff', '#12b76a', '#f79009'],
}

describe('ECharts options (phase 1j spec §1)', () => {
  it('builds a line chart: a series per input, zoom inside, aria on, the format on the axis', () => {
    const format = (v: number) => `${v}/s`
    const o = lineOption(
      {
        label: 'Operations per second',
        series: [
          { name: 'insert', points: [1, 2, 3] },
          { name: 'query', points: [4, 5] },
        ],
        format,
      },
      theme,
    )
    expect(pick(o, 'series')).toHaveLength(2)
    expect(pick(o, 'series.0')).toMatchObject({ type: 'line', name: 'insert', showSymbol: false })
    expect(pick(o, 'series.0.data')).toEqual([1, 2, 3])
    // A later series is aligned to the right, as the samples it missed came before it.
    expect(pick(o, 'series.1.data')).toEqual([null, 4, 5])
    expect(pick(o, 'color')).toEqual(theme.palette)
    expect(pick(o, 'dataZoom')).toEqual([expect.objectContaining({ type: 'inside' })])
    expect(pick(o, 'aria')).toMatchObject({ enabled: true })
    expect((pick(o, 'yAxis.axisLabel.formatter') as (v: number) => string)(2)).toBe('2/s')
    expect(pick(o, 'animation')).toBe(false)
  })

  // User report 2026-10-16: the chart draws no tooltip of its own (on its canvas it was cut in half);
  // it only says what is pointed at, and the app's ChartTip shows it as text (Review Focus 2 holds).
  it('leaves the tooltip to the app, and never turns names into HTML', () => {
    const name = '<img src=x onerror=alert(1)>'
    const line = lineOption({ label: 'x', series: [{ name, points: [1] }] }, theme)
    const bar = barOption({ label: 'x', items: [{ label: name, value: 1 }] }, theme)
    expect(pick(line, 'tooltip')).toEqual({ trigger: 'axis', showContent: false })
    expect(pick(bar, 'tooltip')).toEqual({ trigger: 'item', showContent: false })
    expect(pick(line, 'series.0.name')).toBe(name)
    expect(pick(bar, 'yAxis.data')).toEqual([name])
  })

  // UI redesign R2: in a card a third of the page wide, five or six size labels ran into each other.
  it('keeps a bar chart’s value axis to a few labels that never overlap', () => {
    const o = barOption({ label: 'Sizes', items: [{ label: 'a', value: 60_000 }] }, theme)
    expect(pick(o, 'xAxis.splitNumber')).toBe(3)
    expect(pick(o, 'xAxis.axisLabel.hideOverlap')).toBe(true)
  })

  it('builds a horizontal bar chart that keeps labels, even repeated ones', () => {
    const o = barOption(
      {
        label: 'Index size',
        items: [
          { label: '_id_', value: 100 },
          { label: '_id_', value: 25 },
        ],
        format: (v: number) => `${v} B`,
      },
      theme,
    )
    expect(pick(o, 'yAxis')).toMatchObject({ type: 'category', inverse: true, data: ['_id_', '_id_'] })
    expect(pick(o, 'xAxis.type')).toBe('value')
    expect(pick(o, 'series.0')).toMatchObject({ type: 'bar', data: [100, 25] })
    expect((pick(o, 'xAxis.axisLabel.formatter') as (v: number) => string)(25)).toBe('25 B')
  })

  it('takes its colours from the theme it is given, so a theme switch changes them (Review Focus 4)', () => {
    const dark: ChartTheme = {
      surface: '#101828',
      text: '#fff',
      muted: '#98a2b3',
      grid: '#1d2939',
      palette: ['#7592ff'],
    }
    const light = lineOption({ label: 'x', series: [{ name: 'a', points: [1] }] }, theme)
    const night = lineOption({ label: 'x', series: [{ name: 'a', points: [1] }] }, dark)
    expect(pick(light, 'yAxis.splitLine.lineStyle.color')).toBe('#e4e7ec')
    expect(pick(night, 'yAxis.splitLine.lineStyle.color')).toBe('#1d2939')
    expect(pick(night, 'legend.textStyle.color')).toBe('#fff')
  })
})

describe('chart layout', () => {
  it('keeps a line chart’s legend on one line, scrolling, so it never runs over the chart on a phone', () => {
    const o = lineOption({ label: 'x', series: [{ name: 'a', points: [1] }] }, theme) as {
      legend: { type?: string }
    }
    expect(o.legend.type).toBe('scroll')
  })
})
