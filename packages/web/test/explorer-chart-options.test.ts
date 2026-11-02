import { describe, expect, it } from 'vitest'
import { categoryOption, pieOption, scatterOption, type ChartTheme } from '../src/charts/options'
import { pick } from './support/dom'

// W1 (completion §2): the results chart's shapes, as ECharts options.
const theme: ChartTheme = {
  surface: '#ffffff',
  text: '#344054',
  muted: '#667085',
  grid: '#e4e7ec',
  palette: ['#465fff', '#12b76a', '#f79009'],
}

describe('results chart options', () => {
  it('draws vertical bars or a line over categories, one series each, no tooltip of its own', () => {
    const input = {
      label: 'Orders by status',
      categories: ['paid', 'open'],
      series: [
        { name: 'eu', values: [1, 2] },
        { name: 'us', values: [1, null] },
      ],
    }
    const bars = categoryOption({ ...input, kind: 'bar' }, theme)
    expect(pick(bars, 'xAxis.data')).toEqual(['paid', 'open'])
    expect(pick(bars, 'series')).toEqual([
      expect.objectContaining({ type: 'bar', name: 'eu', data: [1, 2] }),
      expect.objectContaining({ type: 'bar', name: 'us', data: [1, null] }),
    ])
    expect(pick(bars, 'tooltip')).toMatchObject({ showContent: false })
    expect(pick(bars, 'legend')).toBeTruthy()
    const line = categoryOption({ ...input, kind: 'line' }, theme)
    expect(pick(line, 'series.0')).toMatchObject({ type: 'line', connectNulls: false })
    // A single series has no legend to read.
    const one = categoryOption({ ...input, series: [input.series[0]!], kind: 'bar' }, theme)
    expect(pick(one, 'legend')).toMatchObject({ show: false })
  })

  it('draws a pie of slices and a scatter of points (time on the axis for dates)', () => {
    const pie = pieOption({ label: 'Share', items: [{ label: 'a', value: 3 }] }, theme)
    expect(pick(pie, 'series.0')).toMatchObject({ type: 'pie', data: [{ name: 'a', value: 3 }] })
    const scatter = scatterOption(
      { label: 'Price by weight', xType: 'date', series: [{ name: 'p', points: [[1, 2]] }] },
      theme,
    )
    expect(pick(scatter, 'xAxis.type')).toBe('time')
    expect(pick(scatter, 'series.0')).toMatchObject({ type: 'scatter', data: [[1, 2]] })
  })
})
