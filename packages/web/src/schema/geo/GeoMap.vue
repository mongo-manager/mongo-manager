<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Filter, Globe, Maximize2, Minus, Plus } from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import { formatCount } from '@/format'
import { areaCondition, type Area } from '../conditions'
import { WORLD_VIEW, areaOf, fitPoints, landPath, panBy, settle, viewBox, zoomAt, type View } from './view'

/**
 * W2 (2026-10-16): the places of one Schema field on an offline map (completion spec §2 W2.1):
 * Natural Earth's land drawn as SVG, the sampled places as dots, panned and zoomed by pointer,
 * wheel, buttons and keys. Masked fields never reach it: the server sends them without places.
 */
const props = defineProps<{
  path: string
  points: ReadonlyArray<readonly [number, number]>
  /** How many sampled values were places (more than the points kept). */
  count: number
  /** Which kind of value the area filter is written for; null when they are mixed. */
  kind: 'geojson' | 'legacy' | null
  /** Whether the area can be added to the Documents filter (the field has a query path). */
  canFilter: boolean
}>()
const emit = defineEmits<{ filter: [condition: unknown] }>()
const { t, locale } = useI18n()
const helpId = useId()

const fitted = computed(() => fitPoints(props.points))
const view = ref<View>(fitted.value)
const box = computed(() => viewBox(view.value))
const box4 = computed(() => `${box.value.x} ${box.value.y} ${box.value.width} ${box.value.height}`)
/** A dot of the same size on screen at every zoom. */
const radius = computed(() => 1.6 / view.value.zoom)
const stroke = computed(() => 0.35 / view.value.zoom)
const land = landPath()

const area = computed<Area>(() => areaOf(view.value))
const condition = computed(() => (props.kind ? areaCondition(area.value, props.kind) : null))
const filterNote = computed(() =>
  !props.canFilter
    ? null
    : props.kind === null
      ? t('schema.geo.mixed')
      : condition.value === null
        ? t('schema.geo.tooWide')
        : null,
)

const svg = ref<SVGSVGElement | null>(null)
/** Map units per screen pixel; unknown before layout (and in tests), then the drag does nothing. */
function unitsPerPixel(): number | null {
  const rect = svg.value?.getBoundingClientRect()
  if (!rect || rect.width === 0) return null
  // The map keeps its aspect: the tighter of the two scales is the one drawn.
  return Math.max(box.value.width / rect.width, box.value.height / rect.height)
}
let drag: { x: number; y: number; view: View; id: number } | null = null
/** Pointers down, for a pinch (review minor 5): two fingers moving apart zoom in. */
const pointers = new Map<number, { x: number; y: number }>()
let pinch: { distance: number; view: View; mid: { x: number; y: number } } | null = null
const spread = () => {
  const [a, b] = [...pointers.values()]
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
}
const midpoint = () => {
  const [a, b] = [...pointers.values()]
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 }
}
/** The map point under a point of the screen, in a view; null before layout. */
function mapPointAt(clientX: number, clientY: number, of: View): { x: number; y: number } | null {
  const rect = svg.value?.getBoundingClientRect()
  if (!rect || rect.width === 0) return null
  const b = viewBox(of)
  const k = Math.max(b.width / rect.width, b.height / rect.height)
  return {
    x: of.cx + (clientX - rect.left - rect.width / 2) * k,
    y: of.cy + (clientY - rect.top - rect.height / 2) * k,
  }
}
function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (pointers.size === 2) {
    drag = null
    pinch = { distance: spread(), view: view.value, mid: midpoint() }
  } else if (pointers.size === 1)
    drag = { x: event.clientX, y: event.clientY, view: view.value, id: event.pointerId }
  svg.value?.setPointerCapture?.(event.pointerId)
}
function onPointerMove(event: PointerEvent): void {
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (pinch && pointers.size === 2) {
    const distance = spread()
    if (!(pinch.distance > 0 && distance > 0)) return
    // Re-review (minor 6): around the fingers — the place under their first midpoint stays under
    // their midpoint now (a two-finger move pans too).
    const at = mapPointAt(pinch.mid.x, pinch.mid.y, pinch.view)
    const zoomed = zoomAt(pinch.view, distance / pinch.distance, at ?? undefined)
    const now = midpoint()
    const moved = at ? mapPointAt(now.x, now.y, zoomed) : null
    view.value =
      at && moved
        ? settle({ ...zoomed, cx: zoomed.cx + at.x - moved.x, cy: zoomed.cy + at.y - moved.y })
        : zoomed
    return
  }
  if (!drag || event.pointerId !== drag.id) return
  const k = unitsPerPixel()
  if (k === null) return
  view.value = settle({
    ...drag.view,
    cx: drag.view.cx - (event.clientX - drag.x) * k,
    cy: drag.view.cy - (event.clientY - drag.y) * k,
  })
}
function onPointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId)
  if (drag?.id === event.pointerId) drag = null
  if (pinch && pointers.size < 2) {
    pinch = null
    // Re-review (minor 6): the finger left on the map drags it on from here.
    const [left] = [...pointers.entries()]
    if (left) drag = { x: left[1].x, y: left[1].y, view: view.value, id: left[0] }
  }
}
/** The wheel zooms only with Ctrl (or ⌘) held: without it the page scrolls on (review minor 5). */
function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25
  const rect = svg.value?.getBoundingClientRect()
  const k = unitsPerPixel()
  if (!rect || k === null) {
    view.value = zoomAt(view.value, factor)
    return
  }
  // Around the pointer: the place under it stays under it.
  const at = {
    x: view.value.cx + (event.clientX - rect.left - rect.width / 2) * k,
    y: view.value.cy + (event.clientY - rect.top - rect.height / 2) * k,
  }
  view.value = zoomAt(view.value, factor, at)
}
function onKeydown(event: KeyboardEvent): void {
  const step = 0.15
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }
  const move = moves[event.key]
  if (move) view.value = panBy(view.value, move[0], move[1])
  else if (event.key === '+' || event.key === '=') zoomIn()
  else if (event.key === '-' || event.key === '_') zoomOut()
  else if (event.key === '0') fit()
  else return
  event.preventDefault()
}
const zoomIn = () => (view.value = zoomAt(view.value, 2))
const zoomOut = () => (view.value = zoomAt(view.value, 0.5))
const fit = () => (view.value = fitted.value)
const world = () => (view.value = WORLD_VIEW)
function filterArea(): void {
  if (condition.value !== null) emit('filter', condition.value)
}
const n = (v: number) => formatCount(v, locale.value)

// W2 review (minor 5): the places in words — where they lie, and the first of them as a table.
const TABLE_ROWS = 50
const deg = (v: number) => v.toLocaleString(locale.value, { maximumFractionDigits: 5 })
const boundsText = computed(() => {
  if (props.points.length === 0) return ''
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  for (const [lng, lat] of props.points) {
    west = Math.min(west, lng)
    east = Math.max(east, lng)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return t('schema.geo.bounds', { west: deg(west), east: deg(east), south: deg(south), north: deg(north) })
})
const boundsId = useId()
const tableRows = computed(() => props.points.slice(0, TABLE_ROWS))
</script>

<template>
  <figure class="flex flex-col gap-2" data-geo-map>
    <figcaption class="flex flex-wrap items-center gap-2 text-small">
      <span class="font-medium text-fg-muted">{{ t('schema.geo.title') }}</span>
      <span class="text-fg-subtle tabular-nums">{{
        points.length < count
          ? t('schema.geo.someShown', { shown: n(points.length), n: n(count) })
          : t('schema.geo.count', { n: n(count) }, count)
      }}</span>
      <span class="ml-auto flex items-center gap-0.5">
        <DsIconButton size="sm" :icon="Plus" :label="t('schema.geo.zoomIn')" @click="zoomIn" />
        <DsIconButton size="sm" :icon="Minus" :label="t('schema.geo.zoomOut')" @click="zoomOut" />
        <DsIconButton size="sm" :icon="Maximize2" :label="t('schema.geo.fit')" @click="fit" />
        <DsIconButton size="sm" :icon="Globe" :label="t('schema.geo.world')" @click="world" />
      </span>
    </figcaption>
    <svg
      ref="svg"
      role="application"
      :aria-roledescription="t('schema.geo.roledescription')"
      tabindex="0"
      :aria-label="t('schema.geo.label', { path, n: n(count) })"
      :aria-describedby="`${boundsId} ${helpId}`"
      :viewBox="box4"
      preserveAspectRatio="xMidYMid meet"
      class="aspect-[2/1] w-full cursor-grab touch-none rounded-lg border border-line bg-info-soft/40 select-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none active:cursor-grabbing"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel="onWheel"
      @keydown="onKeydown"
    >
      <path :d="land" class="fill-muted stroke-line-strong" :stroke-width="stroke" />
      <g class="fill-accent stroke-surface" :stroke-width="stroke" data-geo-points>
        <circle v-for="(p, i) in points" :key="i" :cx="p[0]" :cy="-p[1]" :r="radius" fill-opacity="0.75" />
      </g>
    </svg>
    <p :id="boundsId" class="text-small text-fg-muted">{{ boundsText }}</p>
    <p :id="helpId" class="text-caption text-fg-subtle">{{ t('schema.geo.help') }}</p>
    <details data-geo-table class="text-small">
      <summary class="cursor-pointer text-fg-muted hover:text-fg">
        {{ t('schema.geo.table', { shown: n(tableRows.length), n: n(points.length) }) }}
      </summary>
      <table class="mt-1.5 w-full max-w-sm tabular-nums">
        <caption class="sr-only">
          {{
            t('schema.geo.label', { path, n: n(count) })
          }}
        </caption>
        <thead>
          <tr class="text-left text-fg-subtle">
            <th scope="col" class="font-medium">{{ t('schema.geo.longitude') }}</th>
            <th scope="col" class="font-medium">{{ t('schema.geo.latitude') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) in tableRows" :key="i" class="text-fg">
            <td>{{ deg(p[0]) }}</td>
            <td>{{ deg(p[1]) }}</td>
          </tr>
        </tbody>
      </table>
    </details>
    <div v-if="canFilter" class="flex flex-wrap items-center gap-2">
      <DsButton size="sm" :icon="Filter" :disabled="condition === null" @click="filterArea">
        {{ t('schema.geo.filterArea') }}
      </DsButton>
      <span v-if="filterNote" class="text-small text-fg-subtle">{{ filterNote }}</span>
    </div>
    <p class="text-caption text-fg-subtle">{{ t('schema.geo.credit') }}</p>
  </figure>
</template>
