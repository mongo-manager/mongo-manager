<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Maximize, Minus, Plus } from 'lucide-vue-next'
import type { DataModel, ModelCollection } from '@mongo-manager/shared/browser'
import DsIconButton from '@/ds/DsIconButton.vue'
import { HEADER_H, ROW_H, rowY, type ModelLayout, type NodeBox } from './layout'
import { MANY_PATH, MARK_TEXT, ONE_PATH, edgeEnds, fieldMark, hasMarks } from './marks'

/**
 * completion W6.4: the data model as an SVG diagram. Drag the canvas to pan; drag a box to move it
 * alone, its links following (2026-10-26 user report), or Alt + arrows on a focused box. Once it has the focus (a click
 * on it, or Tab), Ctrl/⌘ + wheel zooms at the pointer and the wheel pans; before, the wheel scrolls
 * the page — Shift + wheel pans it anyway (review minor 10). Focused, the arrows pan, + and − zoom and
 * 0 fits. Each box is a button (Tab reaches it, Enter or Space selects it) and a click selects it too;
 * its links then stand out. The List view shows the same model as a list, for the keyboard.
 */
const props = defineProps<{ model: DataModel; layout: ModelLayout; selected: string | null }>()
const emit = defineEmits<{
  select: [name: string | null]
  /** A box put at (x, y), by the pointer. */
  move: [name: string, x: number, y: number]
  /** A box moved by (dx, dy) from where it stands, by the keyboard: presses come faster than drawing. */
  nudge: [name: string, dx: number, dy: number]
}>()
const { t } = useI18n()
const hintId = useId()
// Its own marker id: two models may be on screen at once (split view).
const arrowId = `${useId()}-arrow`
// Plugins wave 3: a reference's ends, many and one.
const manyId = `${useId()}-many`
const oneId = `${useId()}-one`
const endMarkers = (e: ModelLayout['edges'][number]) => {
  if (e.kind !== 'reference') return { 'marker-end': `url(#${arrowId})` }
  const ends = edgeEnds(e.many)
  return {
    'marker-start': `url(#${manyId})`,
    'marker-end': `url(#${ends.end === 'many' ? manyId : oneId})`,
  }
}
/** Where a box's field names start: further in where its fields carry marks. */
const indent = (n: NodeBox) => (hasMarks(collection(n)) ? 30 : 12)
/** A box's header: its top corners rounded as the box's. */
const headerPath = (n: NodeBox) =>
  `M ${n.x} ${n.y + HEADER_H} V ${n.y + 10} A 10 10 0 0 1 ${n.x + 10} ${n.y} H ${n.x + n.w - 10} A 10 10 0 0 1 ${n.x + n.w} ${n.y + 10} V ${n.y + HEADER_H} Z`

const MIN_K = 0.2
const MAX_K = 3
const view = ref({ x: 0, y: 0, k: 1 })
const canvas = ref<HTMLElement | null>(null)
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k))
const transform = computed(
  () =>
    `translate(${Math.round(view.value.x)} ${Math.round(view.value.y)}) scale(${Math.round(view.value.k * 1000) / 1000})`,
)

/** The whole model in sight (never larger than life). */
function fit(): void {
  const w = canvas.value?.clientWidth ?? 0
  const h = canvas.value?.clientHeight ?? 0
  if (!w || !h) return void (view.value = { x: 0, y: 0, k: 1 })
  const k = clampK(Math.min(1, w / props.layout.width, h / props.layout.height))
  view.value = { x: (w - props.layout.width * k) / 2, y: Math.max(0, (h - props.layout.height * k) / 2), k }
}
onMounted(fit)
/** Zooms by `factor`, keeping the point (px, py) of the canvas where it is. */
function zoom(factor: number, px?: number, py?: number): void {
  const { x, y, k } = view.value
  const next = clampK(k * factor)
  const cx = px ?? (canvas.value?.clientWidth ?? 0) / 2
  const cy = py ?? (canvas.value?.clientHeight ?? 0) / 2
  view.value = { k: next, x: cx - ((cx - x) * next) / k, y: cy - ((cy - y) * next) / k }
}
/** Re-review minor 4: a box the keyboard reaches is panned into sight (with a margin), if it is not. */
function reveal(n: NodeBox): void {
  const w = canvas.value?.clientWidth ?? 0
  const h = canvas.value?.clientHeight ?? 0
  if (!w || !h) return
  const { x, y, k } = view.value
  const M = 24
  const left = n.x * k + x
  const right = (n.x + n.w) * k + x
  const top = n.y * k + y
  const bottom = (n.y + n.h) * k + y
  let dx = 0
  let dy = 0
  if (left < M) dx = M - left
  else if (right > w - M) dx = Math.max(M - left, w - M - right)
  if (top < M) dy = M - top
  else if (bottom > h - M) dy = Math.max(M - top, h - M - bottom)
  if (dx || dy) view.value = { k, x: x + dx, y: y + dy }
}
const pan = (dx: number, dy: number) =>
  (view.value = { ...view.value, x: view.value.x + dx, y: view.value.y + dy })

function onKeydown(e: KeyboardEvent): void {
  const step = e.shiftKey ? 160 : 48
  if (e.key === '+' || e.key === '=') zoom(1.2)
  else if (e.key === '-' || e.key === '_') zoom(1 / 1.2)
  else if (e.key === '0') fit()
  else if (e.key === 'ArrowLeft') pan(step, 0)
  else if (e.key === 'ArrowRight') pan(-step, 0)
  else if (e.key === 'ArrowUp') pan(0, step)
  else if (e.key === 'ArrowDown') pan(0, -step)
  else if (e.key === 'Escape' && props.selected) emit('select', null)
  else return
  e.preventDefault()
}
function onWheel(e: WheelEvent): void {
  const focused = !!canvas.value?.contains(document.activeElement)
  if (!focused && !e.shiftKey) return
  e.preventDefault()
  if (focused && (e.ctrlKey || e.metaKey)) {
    const box = canvas.value?.getBoundingClientRect()
    zoom(
      e.deltaY < 0 ? 1.1 : 1 / 1.1,
      box ? e.clientX - box.left : undefined,
      box ? e.clientY - box.top : undefined,
    )
  } else if (e.shiftKey) pan(-(e.deltaX || e.deltaY), 0)
  else pan(-e.deltaX, -e.deltaY)
}
let drag: {
  x: number
  y: number
  sx: number
  sy: number
  moved: boolean
  /** The box held, where it stood when pressed: it moves, not the diagram. */
  box: { name: string; x: number; y: number } | null
} | null = null
function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  const name = (e.target as Element | null)?.closest?.('[data-node]')?.getAttribute('data-node')
  const n = name ? props.layout.nodes.find((b) => b.name === name) : undefined
  drag = {
    x: e.clientX,
    y: e.clientY,
    sx: e.clientX,
    sy: e.clientY,
    moved: false,
    box: n ? { name: n.name, x: n.x, y: n.y } : null,
  }
}
function onPointerMove(e: PointerEvent): void {
  if (!drag) return
  // A drag starts past a few pixels; only then is the pointer held, so a click still reaches a box.
  if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) {
    drag.moved = true
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  if (!drag.moved) return
  if (drag.box) {
    const k = view.value.k
    emit(
      'move',
      drag.box.name,
      drag.box.x + (e.clientX - drag.sx) / k,
      drag.box.y + (e.clientY - drag.sy) / k,
    )
    return
  }
  pan(e.clientX - drag.x, e.clientY - drag.y)
  drag.x = e.clientX
  drag.y = e.clientY
}
let justDragged = false
function onPointerUp(): void {
  justDragged = !!drag?.moved
  drag = null
}
const NUDGE: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}
/** Alt + an arrow moves the focused box (Shift: further); the diagram stays still. */
function onBoxKeydown(e: KeyboardEvent, n: NodeBox): void {
  const way = NUDGE[e.key]
  if (!e.altKey || !way) return
  e.preventDefault()
  e.stopPropagation()
  const step = e.shiftKey ? 64 : 16
  emit('nudge', n.name, way[0] * step, way[1] * step)
  void nextTick(() => {
    const now = props.layout.nodes.find((b) => b.name === n.name)
    if (now) reveal(now)
  })
}
function choose(name: string | null): void {
  if (justDragged) return void (justDragged = false)
  emit('select', name === props.selected ? null : name)
}

const byName = computed(() => new Map(props.model.collections.map((c) => [c.name, c])))
const collection = (n: NodeBox) => byName.value.get(n.name) as ModelCollection
const fieldOf = (n: NodeBox, path: string) => collection(n).fields.find((f) => f.path === path)
/** The links of the selected box. */
const touching = computed(() =>
  props.selected
    ? new Set(
        props.layout.edges
          .filter((e) => e.from === props.selected || e.to === props.selected)
          .map((e) => e.key),
      )
    : null,
)
const fit_ = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const label = computed(() =>
  t('model.diagramLabel', {
    db: props.model.db,
    collections: t('model.counts.collections', props.model.collections.length),
    links: t('model.counts.links', props.layout.edges.length),
  }),
)
/** A box as a screen reader names it: its collection and how many fields it has. */
function boxLabel(n: NodeBox): string {
  const c = collection(n)
  if (c.type === 'view') return `${n.name}, ${t('model.viewOn', { coll: c.viewOn ?? '?' })}`
  if (c.refused) return `${n.name}, ${t(`model.refused.${c.refused}`)}`
  const count = c.fields.length + c.moreFields
  return `${n.name}, ${t('model.fieldsCount', { n: count }, count)}`
}
defineExpose({ fit })
</script>

<template>
  <div class="relative min-h-[420px] flex-1 overflow-hidden rounded-lg border border-line bg-canvas">
    <div
      ref="canvas"
      data-model-canvas
      tabindex="0"
      role="group"
      :aria-roledescription="t('model.roleDiagram')"
      :aria-label="label"
      :aria-describedby="hintId"
      aria-keyshortcuts="Plus Minus 0 ArrowLeft ArrowRight ArrowUp ArrowDown Escape"
      class="absolute inset-0 cursor-grab touch-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus active:cursor-grabbing"
      @keydown="onKeydown"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @click.self="choose(null)"
    >
      <svg data-model-diagram class="size-full select-none" @click.self="choose(null)">
        <defs>
          <marker
            :id="arrowId"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M0 0 L8 4 L0 8 z" class="fill-accent" />
          </marker>
          <marker
            :id="manyId"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="10"
            markerHeight="10"
            orient="auto-start-reverse"
          >
            <path :d="MANY_PATH" fill="none" stroke-width="1.2" class="stroke-accent" />
          </marker>
          <marker
            :id="oneId"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="10"
            markerHeight="10"
            orient="auto-start-reverse"
          >
            <path :d="ONE_PATH" fill="none" stroke-width="1.2" class="stroke-accent" />
          </marker>
        </defs>
        <g data-model-scene :transform="transform">
          <path
            v-for="e in layout.edges"
            :key="e.key"
            data-edge
            :data-kind="e.kind"
            :d="e.d"
            fill="none"
            stroke-width="1.5"
            v-bind="endMarkers(e)"
            :stroke-dasharray="
              e.kind === 'view'
                ? '2 4'
                : e.sources.includes('name') || e.sources.includes('values')
                  ? undefined
                  : '6 4'
            "
            class="stroke-accent transition-opacity duration-120"
            :class="touching && !touching.has(e.key) ? 'opacity-15' : 'opacity-80'"
          />
          <g
            v-for="n in layout.nodes"
            :key="n.name"
            :data-node="n.name"
            role="button"
            tabindex="0"
            :aria-label="boxLabel(n)"
            :aria-pressed="selected === n.name"
            class="cursor-move outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
            :class="
              touching &&
              selected !== n.name &&
              !layout.edges.some((e) => touching!.has(e.key) && (e.from === n.name || e.to === n.name))
                ? 'opacity-50'
                : ''
            "
            @click.stop="choose(n.name)"
            @keydown.enter.prevent.stop="choose(n.name)"
            @keydown.space.prevent.stop="choose(n.name)"
            @keydown="onBoxKeydown($event, n)"
            @focus="reveal(n)"
          >
            <rect
              :x="n.x"
              :y="n.y"
              :width="n.w"
              :height="n.h"
              rx="10"
              class="fill-surface"
              :class="selected === n.name ? 'stroke-accent' : 'stroke-line-strong'"
              :stroke-width="selected === n.name ? 2 : 1"
            />
            <path :d="headerPath(n)" class="fill-subtle" />
            <line :x1="n.x" :y1="n.y + HEADER_H" :x2="n.x + n.w" :y2="n.y + HEADER_H" class="stroke-line" />
            <text :x="n.x + 12" :y="n.y + HEADER_H / 2 + 5" class="fill-fg text-[13px] font-semibold">
              {{ fit_(n.name, 26) }}
            </text>
            <text
              v-if="n.type !== 'collection'"
              :x="n.x + n.w - 12"
              :y="n.y + HEADER_H / 2 + 4"
              text-anchor="end"
              class="fill-fg-subtle text-[10px]"
            >
              {{ t(`model.types.${n.type}`) }}
            </text>
            <template v-if="collection(n).type === 'view'">
              <text :x="n.x + 12" :y="rowY(n, 0) + 4" class="fill-fg-muted text-[11px]">
                {{ t('model.viewOn', { coll: collection(n).viewOn ?? '?' }) }}
              </text>
            </template>
            <template v-else-if="collection(n).refused">
              <text :x="n.x + 12" :y="rowY(n, 0) + 4" class="fill-warning text-[11px]">
                {{ t(`model.refused.${collection(n).refused}`) }}
              </text>
            </template>
            <template v-else>
              <g v-for="(path, i) in n.rows" :key="path" :data-field="path">
                <text
                  v-if="fieldMark(collection(n), path)"
                  :data-mark="fieldMark(collection(n), path)"
                  :x="n.x + 10"
                  :y="rowY(n, i) + 4"
                  class="fill-accent-fg text-[8.5px] font-bold"
                >
                  <title>{{ t(`model.marks.${fieldMark(collection(n), path)}`) }}</title>
                  {{ MARK_TEXT[fieldMark(collection(n), path)!] }}
                </text>
                <text
                  :x="n.x + indent(n)"
                  :y="rowY(n, i) + 4"
                  class="font-mono text-[11px]"
                  :class="fieldOf(n, path)?.masked ? 'fill-fg-muted' : 'fill-fg'"
                >
                  {{ fit_(path, indent(n) > 12 ? 24 : 26) }}
                </text>
                <text
                  :x="n.x + n.w - 12"
                  :y="rowY(n, i) + 4"
                  text-anchor="end"
                  class="fill-fg-subtle text-[10px]"
                >
                  {{ fieldOf(n, path)?.masked ? t('model.hidden') : (fieldOf(n, path)?.types[0] ?? '') }}
                </text>
              </g>
              <text
                v-if="n.more > 0"
                :x="n.x + 12"
                :y="n.y + HEADER_H + n.rows.length * ROW_H + ROW_H / 2 + 4"
                class="fill-fg-subtle text-[10px]"
              >
                {{ t('model.more', { n: n.more }) }}
              </text>
            </template>
          </g>
        </g>
      </svg>
    </div>
    <p :id="hintId" class="sr-only">{{ t('model.canvasHint') }}</p>
    <div
      class="absolute right-[max(0.5rem,var(--mm-launcher-clearance,0px))] bottom-2 flex gap-1 rounded-lg border border-line bg-surface p-1 shadow-xs"
    >
      <DsIconButton :icon="Plus" size="sm" :label="t('model.zoomIn')" @click="zoom(1.2)" />
      <DsIconButton :icon="Minus" size="sm" :label="t('model.zoomOut')" @click="zoom(1 / 1.2)" />
      <DsIconButton :icon="Maximize" size="sm" :label="t('model.fit')" @click="fit" />
    </div>
  </div>
</template>
