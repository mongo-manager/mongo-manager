// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * ECharts options for the app's two chart shapes (phase 1j spec §1), as pure functions so they are
 * tested without a canvas. Tooltips are the app's (ChartTip, text only): series names and labels are
 * user data (namespaces, field values) and must not become markup.
 */

export interface ChartTheme {
  /** The card behind the chart. */
  surface: string
  text: string
  muted: string
  grid: string
  palette: string[]
}

export interface LineInput {
  label: string
  /** null is a gap: no measurement (a member that was down). */
  series: Array<{ name: string; points: Array<number | null> }>
  format?: (value: number) => string
}

export interface BarInput {
  label: string
  items: Array<{ label: string; value: number }>
  format?: (value: number) => string
}

const plain = (v: number) => String(Math.round(v * 100) / 100)

/**
 * The chart says what is pointed at and draws no tooltip itself: on its canvas a tall one was cut in
 * half (user report 2026-10-16). The app's ChartTip shows it, as text, above the page.
 */
const tooltip = (trigger: 'axis' | 'item') => ({ trigger, showContent: false })

export function lineOption(input: LineInput, theme: ChartTheme): Record<string, unknown> {
  const format = input.format ?? plain
  const longest = Math.max(0, ...input.series.map((s) => s.points.length))
  return {
    animation: false,
    color: theme.palette,
    aria: { enabled: true, label: { description: input.label } },
    grid: { left: 8, right: 8, top: 28, bottom: 8, containLabel: true },
    legend: {
      // One line, scrolling when narrow (user review 2026-10-09: on a phone it ran over the chart).
      type: 'scroll',
      top: 0,
      left: 0,
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: theme.text, fontSize: 11 },
    },
    tooltip: tooltip('axis'),
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: Array.from({ length: longest }, (_, i) => String(i)),
      show: false,
    },
    yAxis: {
      type: 'value',
      min: 0,
      splitNumber: 4,
      axisLabel: { color: theme.muted, fontSize: 10, formatter: (v: number) => format(v) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    series: input.series.map((s) => ({
      type: 'line',
      name: s.name,
      showSymbol: false,
      lineStyle: { width: 2 },
      // A series that started later is aligned to the right of the longest one.
      data: [...new Array<null>(longest - s.points.length).fill(null), ...s.points],
    })),
  }
}

export function barOption(input: BarInput, theme: ChartTheme): Record<string, unknown> {
  const format = input.format ?? plain
  return {
    animation: false,
    color: theme.palette,
    aria: { enabled: true, label: { description: input.label } },
    grid: { left: 8, right: 16, top: 8, bottom: 8, containLabel: true },
    tooltip: tooltip('item'),
    xAxis: {
      type: 'value',
      // A few labels, and none drawn over another (a chart in a narrow card; UI redesign R2).
      splitNumber: 3,
      axisLabel: { color: theme.muted, fontSize: 10, hideOverlap: true, formatter: (v: number) => format(v) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: input.items.map((i) => i.label),
      axisLabel: { color: theme.text, fontSize: 11, width: 160, overflow: 'truncate' },
    },
    series: [{ type: 'bar', barMaxWidth: 14, data: input.items.map((i) => i.value) }],
  }
}

// ---- W1 (completion §2): the results chart of the Documents section

export interface CategoryInput {
  kind: 'bar' | 'line'
  label: string
  categories: string[]
  series: Array<{ name: string; values: Array<number | null> }>
  format?: (value: number) => string
}

export interface PieInput {
  label: string
  items: Array<{ label: string; value: number }>
}

export interface ScatterInput {
  label: string
  xType: 'number' | 'date'
  series: Array<{ name: string; points: Array<[number, number]> }>
  format?: (value: number) => string
}

const legendOf = (theme: ChartTheme, shown: boolean) => ({
  show: shown,
  type: 'scroll',
  top: 0,
  left: 0,
  itemWidth: 10,
  itemHeight: 10,
  textStyle: { color: theme.text, fontSize: 11 },
})

const valueAxis = (theme: ChartTheme, format: (v: number) => string) => ({
  type: 'value',
  splitNumber: 4,
  axisLabel: { color: theme.muted, fontSize: 10, hideOverlap: true, formatter: (v: number) => format(v) },
  splitLine: { lineStyle: { color: theme.grid } },
})

/** Vertical bars or a line over categories (the values of a field), one series per group. */
export function categoryOption(input: CategoryInput, theme: ChartTheme): Record<string, unknown> {
  const format = input.format ?? plain
  const legend = input.series.length > 1
  return {
    animation: false,
    color: theme.palette,
    aria: { enabled: true, label: { description: input.label } },
    grid: { left: 8, right: 16, top: legend ? 28 : 8, bottom: 8, containLabel: true },
    legend: legendOf(theme, legend),
    tooltip: tooltip(input.kind === 'bar' ? 'item' : 'axis'),
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    xAxis: {
      type: 'category',
      data: input.categories,
      axisLabel: { color: theme.text, fontSize: 11, hideOverlap: true, width: 120, overflow: 'truncate' },
    },
    yAxis: valueAxis(theme, format),
    series: input.series.map((s) =>
      input.kind === 'bar'
        ? { type: 'bar', name: s.name, barMaxWidth: 28, data: s.values }
        : {
            type: 'line',
            name: s.name,
            connectNulls: false,
            symbolSize: 5,
            lineStyle: { width: 2 },
            data: s.values,
          },
    ),
  }
}

/** A pie of a field's values (the largest first, the rest as one slice). */
export function pieOption(input: PieInput, theme: ChartTheme): Record<string, unknown> {
  return {
    animation: false,
    color: theme.palette,
    aria: { enabled: true, label: { description: input.label } },
    legend: { ...legendOf(theme, true), top: 'auto', bottom: 0 },
    tooltip: tooltip('item'),
    series: [
      {
        type: 'pie',
        radius: ['38%', '68%'],
        center: ['50%', '45%'],
        itemStyle: { borderColor: theme.surface, borderWidth: 2 },
        label: { color: theme.text, fontSize: 11, overflow: 'truncate', width: 120 },
        data: input.items.map((i) => ({ name: i.label, value: i.value })),
      },
    ],
  }
}

/** Points of two numbers (or a date and a number), one series per group. */
export function scatterOption(input: ScatterInput, theme: ChartTheme): Record<string, unknown> {
  const format = input.format ?? plain
  const legend = input.series.length > 1
  return {
    animation: false,
    color: theme.palette,
    aria: { enabled: true, label: { description: input.label } },
    grid: { left: 8, right: 16, top: legend ? 28 : 8, bottom: 8, containLabel: true },
    legend: legendOf(theme, legend),
    tooltip: tooltip('item'),
    dataZoom: [{ type: 'inside', filterMode: 'none' }],
    xAxis:
      input.xType === 'date'
        ? {
            type: 'time',
            axisLabel: { color: theme.muted, fontSize: 10, hideOverlap: true },
            splitLine: { show: false },
          }
        : { ...valueAxis(theme, format), scale: true },
    yAxis: { ...valueAxis(theme, format), scale: true },
    series: input.series.map((s) => ({ type: 'scatter', name: s.name, symbolSize: 7, data: s.points })),
  }
}
