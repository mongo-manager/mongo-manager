<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  Check,
  Database,
  LayoutGrid,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-vue-next'
import type { Widget } from '@mongo-manager/shared/browser'
import { connectionsApi, queryKeys } from '@/api/connections'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import DsButton from '@/ds/DsButton.vue'
import DsKbd from '@/ds/DsKbd.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import { useAiStatus } from '@/ai/useAi'
import { useDashboardStore } from '@/stores/dashboard'
import { useShortcutsStore } from '@/stores/shortcuts'
import { useDialogStore } from '@/stores/dialogs'
import { useToastStore } from '@/stores/toasts'
import WidgetSlot from './overview/widgets/WidgetSlot.vue'
import WidgetGallery from './overview/WidgetGallery.vue'
import WidgetSettings from './overview/WidgetSettings.vue'
import { WIDGETS, type WidgetDef } from './overview/widgets/registry'
import { useWidgetDrag } from './overview/widgets/drag'
import { clampColumn } from './overview/widgets/grid'
import { useQuickLinks } from './overview/quickLinks'
import { keyLabel } from './shortcuts'

/**
 * UI redesign R1 spec §3: home, shown when no tab is open — a search field, the connections as cards,
 * or a first-connection guide. Plan ruling 13: its action is "New connection", so "Add connection"
 * stays one button in the navigator.
 */
const emit = defineEmits<{ palette: [ask?: boolean] }>()
const { t } = useI18n()
const session = useSessionStore()
const dialogs = useWorkspaceDialogs()
const { data, isPending } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const all = computed(() => data.value ?? [])
const canManage = computed(() => session.can('connections:manage'))
const name = computed(() => session.me?.user.username ?? '')
// W5: as this user bound them.
const shortcuts = useShortcutsStore()
const paletteKeys = computed(() => (shortcuts.keysOf('palette')[0] ?? []).map(keyLabel))
const STEPS = ['add', 'browse', 'query'] as const
const links = useQuickLinks()

// User review 2026-10-09: the Overview as the user's dashboard of widgets (edit, add, move, resize).
const dashboard = useDashboardStore()
watch(
  () => session.me?.user.id,
  (id) => {
    if (id) void dashboard.load(id)
  },
  { immediate: true },
)
const confirms = useDialogStore()
const toasts = useToastStore()
const titleOf = (w: Widget) => {
  const def = WIDGETS[w.type]
  return def ? t(def.title) : w.type
}
const drag = useWidgetDrag(titleOf)
const editing = computed({
  get: () => dashboard.editing,
  set: (value: boolean) => {
    if (value) dashboard.beginEdit()
    else {
      drag.release()
      dashboard.endEdit()
    }
  },
})
/** The dashboard could not be loaded: try again (final review 7). */
function retryLoad(): void {
  const id = session.me?.user.id
  if (id) void dashboard.load(id)
}
/** Cancel: the layout as it was when editing began. */
function cancelEdit(): void {
  drag.release()
  dashboard.discardEdit()
}
/** Widgets of kinds this version knows (a newer layout's others are skipped, not shown broken). */
const shown = computed(() => dashboard.widgets.filter((w) => !!WIDGETS[w.type]))
const SPAN: Record<Widget['size'], string> = {
  s: 'sm:col-span-3 lg:col-span-3',
  m: 'sm:col-span-6 lg:col-span-6',
  l: 'sm:col-span-6 lg:col-span-9',
  xl: 'sm:col-span-6 lg:col-span-12',
}
/** Static, so the styles are generated: where a widget starts on the wide grid. */
const COL_START = [
  '',
  'lg:col-start-1',
  'lg:col-start-2',
  'lg:col-start-3',
  'lg:col-start-4',
  'lg:col-start-5',
  'lg:col-start-6',
  'lg:col-start-7',
  'lg:col-start-8',
  'lg:col-start-9',
  'lg:col-start-10',
  'lg:col-start-11',
  'lg:col-start-12',
]
/** Its start column, kept on the grid whatever its width (a wider one starts earlier). */
const colStart = (w: Widget) => (w.col === undefined ? '' : COL_START[clampColumn(w.col, w.size)])
const gallery = ref(false)
// A widget with settings asks them first: when added, and from its menu later.
const settingsFor = ref<{ def: WidgetDef; widget: Widget | null } | null>(null)
function add(def: WidgetDef): void {
  if (def.settings !== 'none') {
    gallery.value = false
    settingsFor.value = { def, widget: null }
    return
  }
  const id = dashboard.add(def.type, {}, def.size)
  if (id) gallery.value = false
}
function configure(widget: Widget): void {
  const def = WIDGETS[widget.type]
  if (def && def.settings !== 'none') settingsFor.value = { def, widget }
}
function saveSettings(settings: Record<string, unknown>): void {
  const target = settingsFor.value
  if (!target) return
  if (target.widget) dashboard.configure(target.widget.id, settings)
  else dashboard.add(target.def.type, settings, target.def.size)
  settingsFor.value = null
}
async function reset(): Promise<void> {
  const ok = await confirms.confirm({
    title: t('overview.dashboard.resetTitle'),
    message: t('overview.dashboard.resetMessage'),
    confirmLabel: t('overview.dashboard.resetConfirm'),
    danger: true,
  })
  if (!ok) return
  try {
    await dashboard.resetToDefault()
  } catch {
    toasts.push({ kind: 'error', message: t('overview.dashboard.saveFailed') })
  }
}
watch(
  () => dashboard.saveFailed,
  (failed) => {
    if (failed) toasts.push({ kind: 'error', message: t('overview.dashboard.saveFailed') })
  },
)

// Ask from Overview when the assistant is offered (§3.6).
const aiStatus = useAiStatus()
const askOffered = computed(() => !!aiStatus.data.value?.enabled)
const newConnection = () => dialogs.open({ kind: 'connection' })
const importConnections = () => dialogs.open({ kind: 'importConnections' })
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-8 py-9 max-md:px-4 max-md:py-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div class="min-w-0">
        <h1 class="text-title-l font-semibold text-fg">
          {{ name ? t('home.greeting', { name }) : t('home.greetingPlain') }}
        </h1>
        <p class="mt-1 text-ui text-fg-muted">{{ t('home.subtitle') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <template v-if="all.length > 0 && dashboard.status === 'ready'">
          <DsButton v-if="!editing" :icon="LayoutGrid" data-dashboard-edit @click="editing = true">{{
            t('overview.dashboard.customize')
          }}</DsButton>
          <template v-else>
            <DsButton variant="ghost" :icon="X" data-dashboard-cancel @click="cancelEdit">{{
              t('common.cancel')
            }}</DsButton>
            <DsButton variant="primary" :icon="Check" @click="editing = false">{{
              t('overview.dashboard.done')
            }}</DsButton>
          </template>
        </template>
        <template v-if="canManage && all.length > 0 && !editing">
          <DsButton :icon="Upload" @click="importConnections">{{ t('home.import') }}</DsButton>
          <DsButton variant="primary" :icon="Plus" @click="newConnection">{{
            t('home.newConnection')
          }}</DsButton>
        </template>
      </div>
    </header>

    <button
      type="button"
      data-test="home-search"
      class="group flex h-12 w-full cursor-pointer items-center gap-3 rounded-2xl border border-line bg-surface px-4 text-left shadow-xs transition-[border-color,box-shadow] duration-120 ease-out-soft hover:border-line-strong hover:shadow-float"
      @click="emit('palette', askOffered)"
    >
      <component
        :is="askOffered ? Sparkles : Search"
        class="size-4 shrink-0 text-fg-subtle group-hover:text-accent-fg"
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1 truncate text-ui text-fg-subtle">{{
        askOffered ? t('home.askPlaceholder') : t('home.searchPlaceholder')
      }}</span>
      <span class="flex shrink-0 gap-0.5" aria-hidden="true">
        <DsKbd v-for="k in paletteKeys" :key="k">{{ k }}</DsKbd>
      </span>
    </button>

    <div v-if="isPending" aria-hidden="true" class="grid gap-4 xl:grid-cols-2">
      <DsSkeleton v-for="i in 4" :key="i" class="h-40 rounded-card" />
    </div>

    <template v-else-if="all.length > 0">
      <DsCallout v-if="dashboard.status === 'unavailable'" data-dashboard-unavailable tone="warning">
        <span class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span class="min-w-0 flex-1">{{
            dashboard.newer ? t('overview.dashboard.newer') : t('overview.dashboard.unavailable')
          }}</span>
          <DsButton v-if="!dashboard.newer" size="sm" :icon="RotateCw" @click="retryLoad">{{
            t('common.retry')
          }}</DsButton>
        </span>
      </DsCallout>
      <div
        v-if="editing"
        data-dashboard-bar
        class="flex flex-wrap items-center gap-2 rounded-2xl border border-dashed border-line-strong bg-subtle px-4 py-3"
      >
        <p class="w-full min-w-0 text-small text-fg-muted sm:w-auto sm:flex-1">
          {{ t('overview.dashboard.hint') }}
        </p>
        <DsButton :icon="Plus" @click="gallery = true">{{ t('overview.dashboard.add') }}</DsButton>
        <DsButton variant="ghost" :icon="RotateCcw" @click="reset">{{
          t('overview.dashboard.reset')
        }}</DsButton>
      </div>
      <div class="relative">
        <!-- While a widget is dragged: the wide grid's columns, so a gap is seen where it is left. -->
        <div
          v-if="drag.dragging.value"
          aria-hidden="true"
          class="pointer-events-none absolute inset-0 hidden grid-cols-12 gap-4 lg:grid"
        >
          <div v-for="n in 12" :key="n" class="rounded-lg bg-subtle/70" />
        </div>
        <ul
          data-dashboard-grid
          role="list"
          :aria-label="t('overview.dashboard.label')"
          class="relative grid grid-cols-1 gap-4 sm:grid-cols-6 lg:grid-cols-12"
        >
          <li
            v-for="(w, i) in shown"
            :key="w.id"
            data-cell
            :data-cell-id="w.id"
            :data-dragging="drag.dragging.value === w.id ? 'true' : undefined"
            class="min-w-0 rounded-card has-[>[data-drag-body]:empty]:hidden data-[dragging=true]:bg-subtle/60 data-[dragging=true]:outline-2 data-[dragging=true]:outline-offset-0 data-[dragging=true]:outline-line-strong data-[dragging=true]:outline-dashed"
            :class="[SPAN[w.size], colStart(w)]"
          >
            <div
              data-drag-body
              class="h-full rounded-card"
              :class="
                drag.dragging.value === w.id && !drag.settling.value
                  ? 'shadow-2xl ring-1 ring-line'
                  : 'transition-shadow duration-200'
              "
              :style="drag.bodyStyle(w.id)"
            >
              <WidgetSlot
                :widget="w"
                :position="i"
                :count="shown.length"
                :editing="editing"
                :handle="editing ? drag.handleFor(w) : null"
                @configure="configure"
              />
            </div>
          </li>
        </ul>
      </div>
      <p
        v-if="!shown.length"
        class="rounded-card border border-dashed border-line p-8 text-center text-ui text-fg-muted"
      >
        {{ t('overview.dashboard.empty') }}
      </p>
      <p data-dashboard-live class="sr-only" aria-live="polite">{{ drag.announcement.value }}</p>
      <WidgetGallery :open="gallery" @close="gallery = false" @add="add" />
      <WidgetSettings
        :def="settingsFor?.def ?? null"
        :initial="(settingsFor?.widget?.settings as Record<string, unknown> | undefined) ?? null"
        :widget-id="settingsFor?.widget?.id ?? null"
        @close="settingsFor = null"
        @save="saveSettings"
      />
    </template>

    <template v-else>
      <section
        data-test="home-onboarding"
        aria-labelledby="home-start"
        class="rounded-card border border-line bg-surface p-8 shadow-xs max-md:p-5"
      >
        <span class="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent-fg">
          <Database class="size-5" aria-hidden="true" />
        </span>
        <h2 id="home-start" class="mt-4 text-title-m font-semibold text-fg">{{ t('home.startTitle') }}</h2>
        <p class="mt-1 max-w-xl text-ui text-fg-muted">{{ t('home.startBody') }}</p>
        <ol class="mt-6 grid gap-4 md:grid-cols-3">
          <li v-for="(step, i) in STEPS" :key="step" class="flex gap-3">
            <span
              class="grid size-6 shrink-0 place-items-center rounded-full bg-subtle text-caption font-semibold text-fg-muted ring-1 ring-line ring-inset tabular-nums"
              >{{ i + 1 }}</span
            >
            <div class="min-w-0">
              <p class="text-ui font-medium text-fg">{{ t(`home.steps.${step}.title`) }}</p>
              <p class="mt-0.5 text-small text-fg-subtle">{{ t(`home.steps.${step}.body`) }}</p>
            </div>
          </li>
        </ol>
        <div v-if="canManage" class="mt-7 flex flex-wrap gap-2">
          <DsButton variant="primary" size="lg" :icon="Plus" @click="newConnection">{{
            t('home.newConnection')
          }}</DsButton>
          <DsButton size="lg" :icon="Upload" @click="importConnections">{{ t('home.import') }}</DsButton>
        </div>
      </section>
      <ul class="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2" :aria-label="t('home.actions')">
        <li v-for="l in links" :key="l.id">
          <button
            type="button"
            class="group flex h-full w-full cursor-pointer items-center gap-3 rounded-xl border border-transparent p-2.5 text-left transition-colors duration-120 hover:border-line hover:bg-surface"
            @click="l.run()"
          >
            <span
              class="grid size-8 shrink-0 place-items-center rounded-md bg-subtle text-fg-muted ring-1 ring-line ring-inset group-hover:text-accent-fg"
            >
              <component :is="l.icon" class="size-4" aria-hidden="true" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-ui font-medium text-fg">{{ l.title }}</span>
              <span class="block line-clamp-2 text-small text-fg-subtle">{{ l.body }}</span>
            </span>
            <span v-if="l.keys.length" class="flex shrink-0 gap-0.5" aria-hidden="true">
              <DsKbd v-for="k in l.keys" :key="k">{{ k }}</DsKbd>
            </span>
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>
