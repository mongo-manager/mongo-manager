<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  Copy,
  Download,
  FileCode,
  FileJson,
  Image,
  LayoutGrid,
  Lock,
  Network,
  RotateCw,
  Table,
  Waypoints,
} from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import type { DsMenuItem } from '@/ds/menu'
import { dataModelApi, dataModelKeys } from '@/api/dataModel'
import { describeError } from '@/api/errors'
import { formatCount } from '@/format'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { openCollectionTab } from '@/workspace/openTabs'
import ModelDiagram from './ModelDiagram.vue'
import ModelList from './ModelList.vue'
import { layoutModel, placeNodes } from './layout'
import { useModelPlacesStore } from './places'
import { exportJson, exportMermaid, exportPng, exportSvg, modelWords } from './exportModel'
import { modelMermaid } from './marks'
import { referenceWords } from './words'

/**
 * completion W6.4: a database's data model (its page's Model section) — the collections, their
 * fields from a sample, and the references inferred between them, as a diagram or a list. Read when
 * asked (it samples every collection), kept for the session; exported as PNG, SVG or JSON.
 */
const props = defineProps<{ connectionId: string; db: string }>()
const { t, locale } = useI18n()
const tabs = useTabsStore()
const toasts = useToastStore()

const SIZES = ['100', '200', '500', '1000'] as const
const size = ref<(typeof SIZES)[number]>('200')
const sizeOptions = computed(() =>
  SIZES.map((s) => ({
    value: s,
    label: t('model.sampleOption', { n: formatCount(Number(s), locale.value) }),
  })),
)
const requested = ref(false)
const asked = ref(200)
const query = useQuery({
  queryKey: computed(() => dataModelKeys.model(props.connectionId, props.db, asked.value)),
  queryFn: ({ signal }) => dataModelApi.get(props.connectionId, props.db, asked.value, signal),
  enabled: requested,
  staleTime: Infinity,
  retry: false,
})
function read(): void {
  const n = Number(size.value)
  if (requested.value && asked.value === n) void query.refetch()
  asked.value = n
  requested.value = true
}
const model = computed(() => query.data.value ?? null)
// 2026-10-26 (user report): boxes the user moved stay where they were put (kept by name for the
// session in a store, the section left or the model read again included), in the diagram and in
// what is exported. The layout is worked out once per model, the places put on it (review M4).
const placesStore = useModelPlacesStore()
const places = computed(() => placesStore.of(props.connectionId, props.db))
const laidOut = computed(() => (model.value ? layoutModel(model.value) : null))
const layout = computed(() => (laidOut.value ? placeNodes(laidOut.value, places.value) : null))
const moved = computed(() => !!model.value?.collections.some((c) => Object.hasOwn(places.value, c.name)))
function place(name: string, x: number, y: number): void {
  placesStore.put(props.connectionId, props.db, name, { x, y })
}
/** From where the box stands now, the presses before this one included. */
function nudge(name: string, dx: number, dy: number): void {
  const n = layout.value?.nodes.find((b) => b.name === name)
  if (n) place(name, n.x + dx, n.y + dy)
}
const mode = ref<'diagram' | 'list'>('diagram')
const modes = computed(() => [
  { value: 'diagram' as const, label: t('model.modes.diagram'), icon: Waypoints },
  { value: 'list' as const, label: t('model.modes.list'), icon: Table },
])
const selected = ref<string | null>(null)
const chosen = computed(() => model.value?.collections.find((c) => c.name === selected.value) ?? null)
const words = referenceWords(t)
const refused = computed(() => model.value?.collections.filter((c) => c.refused) ?? [])
const masked = computed(() => model.value?.collections.some((c) => c.fields.some((f) => f.masked)) ?? false)

const exportItems = computed<DsMenuItem[]>(() => [
  { id: 'png', label: t('model.export.png'), icon: Image },
  { id: 'svg', label: t('model.export.svg'), icon: Image },
  { id: 'json', label: t('model.export.json'), icon: FileJson },
  // Plugins wave 3: Mermaid's erDiagram, to save or to paste where Markdown draws it.
  { id: 'mermaid', label: t('model.export.mermaid'), icon: FileCode },
  { id: 'copyMermaid', label: t('model.export.copyMermaid'), icon: Copy },
])
async function onExport(id: string): Promise<void> {
  const m = model.value
  const l = layout.value
  if (!m || !l) return
  try {
    if (id === 'json') exportJson(m)
    else if (id === 'mermaid') exportMermaid(m, modelWords(t))
    else if (id === 'copyMermaid') {
      await navigator.clipboard.writeText(modelMermaid(m, t('model.hidden')))
      toasts.push({ kind: 'success', message: t('model.export.copied') })
    } else if (id === 'svg') exportSvg(m, l, modelWords(t))
    else await exportPng(m, l, modelWords(t))
  } catch {
    toasts.push({ kind: 'error', message: t('model.export.failed') })
  }
}
</script>

<template>
  <section class="flex min-h-0 flex-col gap-4 p-4" data-model-view>
    <DsCard :title="t('model.title')" :count="model?.collections.length" actions-shown>
      <template #actions>
        <DsSelect
          v-model="size"
          class="w-56"
          size="sm"
          hide-label
          :label="t('model.sampleSize')"
          :options="sizeOptions"
        />
        <DsButton
          size="sm"
          variant="primary"
          :icon="Network"
          :loading="query.isFetching.value"
          @click="read()"
        >
          {{ t('model.read') }}
        </DsButton>
        <DsMenu
          v-if="model"
          text
          focusable
          :label="t('model.export.label')"
          :icon="Download"
          :items="exportItems"
          @select="onExport"
        />
      </template>
      <div class="flex flex-col gap-3">
        <DsCallout v-if="query.isError.value" tone="danger">
          {{ describeError(query.error.value, t) }}
          <template #action>
            <DsButton size="sm" :icon="RotateCw" @click="read()">{{ t('common.retry') }}</DsButton>
          </template>
        </DsCallout>
        <div v-if="!model && query.isFetching.value" class="grid grid-cols-3 gap-4" aria-hidden="true">
          <DsSkeleton v-for="i in 6" :key="i" class="h-32" />
        </div>
        <DsEmptyState
          v-else-if="!model && !query.isError.value"
          :icon="Waypoints"
          :title="t('model.emptyTitle', { db })"
          :description="t('model.intro')"
        />
        <template v-if="model && layout">
          <div class="flex flex-wrap items-center gap-3">
            <DsSegmented v-model="mode" size="sm" :label="t('model.modes.label')" :options="modes" />
            <DsButton
              v-if="moved && mode === 'diagram'"
              size="sm"
              variant="ghost"
              :icon="LayoutGrid"
              data-model-reset
              @click="placesStore.clear(connectionId, db)"
            >
              {{ t('model.resetLayout') }}
            </DsButton>
            <p class="text-small text-fg-subtle">
              {{
                t('model.summary', {
                  collections: t('model.counts.collections', model.collections.length),
                  references: t('model.counts.references', model.references.length),
                  size: formatCount(model.sampleSize, locale),
                })
              }}
            </p>
            <!-- What the lines mean. -->
            <ul
              class="ml-auto flex flex-wrap gap-3 text-small text-fg-subtle"
              :aria-label="t('model.legend.label')"
            >
              <li class="flex items-center gap-1.5">
                <svg width="24" height="6" aria-hidden="true">
                  <line x1="0" y1="3" x2="24" y2="3" class="stroke-accent" stroke-width="1.5" />
                </svg>
                {{ t('model.legend.inferred') }}
              </li>
              <li class="flex items-center gap-1.5">
                <svg width="24" height="6" aria-hidden="true">
                  <line
                    x1="0"
                    y1="3"
                    x2="24"
                    y2="3"
                    class="stroke-accent"
                    stroke-width="1.5"
                    stroke-dasharray="6 4"
                  />
                </svg>
                {{ t('model.legend.lookup') }}
              </li>
              <li class="flex items-center gap-1.5">
                <svg width="24" height="6" aria-hidden="true">
                  <line
                    x1="0"
                    y1="3"
                    x2="24"
                    y2="3"
                    class="stroke-accent"
                    stroke-width="1.5"
                    stroke-dasharray="2 4"
                  />
                </svg>
                {{ t('model.legend.view') }}
              </li>
              <!-- Plugins wave 3: a reference's ends, and the fields' marks. -->
              <li class="flex items-center gap-1.5">
                <svg width="24" height="12" aria-hidden="true">
                  <line x1="0" y1="6" x2="24" y2="6" class="stroke-accent" stroke-width="1.5" />
                  <path :d="'M 14 6 L 24 1 M 14 6 L 24 11 M 14 6 L 24 6'" fill="none" class="stroke-accent" />
                </svg>
                {{ t('model.legend.many') }}
              </li>
              <li class="flex items-center gap-1.5">
                <svg width="24" height="12" aria-hidden="true">
                  <line x1="0" y1="6" x2="24" y2="6" class="stroke-accent" stroke-width="1.5" />
                  <path :d="'M 20 1 L 20 11'" fill="none" class="stroke-accent" stroke-width="1.5" />
                </svg>
                {{ t('model.legend.one') }}
              </li>
              <li class="flex items-center gap-1.5">{{ t('model.legend.marks') }}</li>
            </ul>
          </div>
          <DsCallout v-if="model.skipped > 0" tone="info">
            {{ t('model.skipped', { n: model.skipped }, model.skipped) }}
          </DsCallout>
          <!-- Review minor 13: the server's cap on documents sampled in all made each sample smaller. -->
          <DsCallout v-if="model.capped" tone="info" data-model-capped>
            {{ t('model.capped', { n: formatCount(model.sampleSize, locale) }) }}
          </DsCallout>
          <DsCallout v-if="refused.length" tone="warning">
            {{ t('model.refusedSome', { names: refused.map((c) => c.name).join(', ') }) }}
          </DsCallout>
          <DsCallout v-if="masked" tone="info">
            <span class="inline-flex items-center gap-1.5"
              ><Lock class="size-3.5" aria-hidden="true" />{{ t('model.maskedNote') }}</span
            >
          </DsCallout>
          <div v-if="mode === 'diagram'" class="flex h-[min(70vh,720px)] min-h-0 flex-col">
            <ModelDiagram
              :model="model"
              :layout="layout"
              :selected="selected"
              @select="selected = $event"
              @move="place"
              @nudge="nudge"
            />
          </div>
          <ModelList v-else :model="model" :selected="selected" @select="selected = $event" />
          <!-- The selected collection: its links, and a way into it. -->
          <div
            v-if="chosen && mode === 'diagram'"
            data-model-details
            class="rounded-lg border border-line bg-surface p-3"
          >
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="min-w-0 flex-1 truncate text-ui font-semibold text-fg">{{ chosen.name }}</h3>
              <DsButton
                size="sm"
                :icon="Table"
                @click="openCollectionTab(tabs, connectionId, db, chosen.name)"
              >
                {{ t('model.openCollection') }}
              </DsButton>
            </div>
            <ul class="mt-2 flex flex-col gap-1 text-small">
              <li
                v-for="r in model.references.filter((x) => x.from === chosen!.name || x.to === chosen!.name)"
                :key="`${r.from}${r.field}${r.to}${r.toField}`"
              >
                <button
                  type="button"
                  class="cursor-pointer rounded text-accent-fg hover:underline"
                  @click="selected = r.from === chosen!.name ? r.to : r.from"
                >
                  <code>{{ r.from }}.{{ r.field }} → {{ r.to }}.{{ r.toField }}</code>
                </button>
                <span class="ml-2 text-fg-subtle">{{ words(r) }}</span>
              </li>
              <li
                v-if="!model.references.some((x) => x.from === chosen!.name || x.to === chosen!.name)"
                class="text-fg-subtle"
              >
                {{ t('model.noLinks') }}
              </li>
            </ul>
          </div>
        </template>
      </div>
    </DsCard>
  </section>
</template>
