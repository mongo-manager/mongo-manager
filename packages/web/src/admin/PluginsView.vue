<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ArrowUpCircle,
  BookOpen,
  Bot,
  Download,
  FilterX,
  FolderSearch,
  PackagePlus,
  Puzzle,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  Wrench,
} from 'lucide-vue-next'
import type { PluginAdminView, PluginSource } from '@mongo-manager/shared/browser'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import DsInput from '@/ds/DsInput.vue'
import DsSegmented from '@/ds/DsSegmented.vue'
import DsSelect from '@/ds/DsSelect.vue'
import { pluginKeys, pluginsApi } from '@/api/plugins'
import { describeError } from '@/api/errors'
import { formatBytes } from '@/format'
import { useTabsStore } from '@/stores/tabs'
import { useToastStore } from '@/stores/toasts'
import { openPluginDetailsTab } from '@/workspace/openTabs'
import { localized } from '@/plugins/store'
import { pluginIcon } from '@/plugins/icons'
import PluginSettingsDialog from './PluginSettingsDialog.vue'
import { AI_FILES, guidePath, saveAiFile, saveStarter } from './pluginBuild'
import { PLUGIN_STATUS_TONES, pluginStatus, scanTone, usePluginAdmin } from './usePluginAdmin'
import {
  inState,
  matchesSearch,
  PLUGIN_SOURCES,
  PLUGIN_STATE_FILTERS,
  type PluginStateFilter,
} from './pluginFilter'

/**
 * Phase 4b §2: the plugins, for administrators — what each is, adds and asks for; approved for the
 * files shown, disabled, set up, removed; a `.tgz` uploaded, the folders scanned again.
 */
const { t, locale } = useI18n()
const buildTitleId = useId()
const tabs = useTabsStore()
const list = useQuery({ queryKey: pluginKeys.manage, queryFn: pluginsApi.manage })
const plugins = computed(() => list.data.value?.plugins ?? [])
const input = ref<HTMLInputElement | null>(null)
const editing = ref<PluginAdminView | null>(null)
const {
  busy,
  run,
  nameOf,
  permission,
  contributions,
  scanBadge,
  approve,
  remove,
  disable,
  saveSettings,
  refusedAddresses,
} = usePluginAdmin()
const statusOf = pluginStatus
const TONES = PLUGIN_STATUS_TONES

/** User request 2026-10-28: the list narrowed by state, by source and by a search. */
const state = ref<PluginStateFilter>('all')
const source = ref<PluginSource | ''>('')
const search = ref('')
/** Those the source and the search leave: what each state counts (final review). */
const found = computed(() =>
  plugins.value.filter(
    (p) =>
      (!source.value || p.source === source.value) &&
      matchesSearch(p, search.value, locale.value, p.manifest?.permissions.map(permission)),
  ),
)
const states = computed(() =>
  PLUGIN_STATE_FILTERS.map((value) => ({
    value,
    label: `${t(`plugins.filter.${value}`)} (${found.value.filter((p) => inState(p, value)).length})`,
  })),
)
const sources = computed(() => [
  { value: '' as const, label: t('plugins.filter.anySource') },
  ...PLUGIN_SOURCES.map((value) => ({ value, label: t(`plugins.source.${value}`) })),
])
const shown = computed(() => found.value.filter((p) => inState(p, state.value)))
/** User request 2026-10-31: the plugins counted by state, above the list. */
const stats = computed(() => [
  { key: 'installed', label: t('plugins.stats.installed'), value: plugins.value.length, dot: 'bg-fg-subtle' },
  ...(['enabled', 'attention', 'disabled'] as const).map((key) => ({
    key,
    label: t(`plugins.filter.${key}`),
    value: plugins.value.filter((p) => inState(p, key)).length,
    dot: key === 'enabled' ? 'bg-success' : key === 'attention' ? 'bg-warning' : 'bg-line-strong',
  })),
])
const narrowed = computed(() => state.value !== 'all' || !!source.value || !!search.value.trim())
function clearFilters(): void {
  state.value = 'all'
  source.value = ''
  search.value = ''
}
const countText = computed(() =>
  narrowed.value
    ? t(
        'plugins.filter.countOf',
        { shown: shown.value.length, count: plugins.value.length },
        plugins.value.length,
      )
    : t('plugins.filter.count', { count: plugins.value.length }, plugins.value.length),
)

/**
 * Final review: a plugin the server adds (an upload, an install, a scan, another administrator) is
 * never hidden by the filters: they are cleared when they would hide it.
 */
watch(plugins, (now, before) => {
  const known = new Set(before.map((p) => p.id))
  const added = now.filter((p) => !known.has(p.id))
  if (added.some((p) => !shown.value.includes(p))) clearFilters()
})

/**
 * Final review: a card that leaves the list with the focus in it (approved under "Needs attention",
 * disabled under "Enabled", removed) hands the focus to the card now in its place, or to the way back to
 * every plugin.
 */
const listEl = ref<HTMLElement | null>(null)
const noMatchEl = ref<HTMLElement | null>(null)
watch(
  shown,
  async (now, before) => {
    const active = document.activeElement
    const card = active instanceof HTMLElement ? active.closest<HTMLElement>('[data-plugin]') : null
    if (!card || !listEl.value?.contains(card)) return
    const id = card.dataset.plugin
    if (now.some((p) => p.id === id)) return
    const at = before.findIndex((p) => p.id === id)
    const next = now[Math.min(at, now.length - 1)]
    await nextTick()
    const target = next
      ? [...(listEl.value?.querySelectorAll<HTMLElement>('[data-plugin]') ?? [])]
          .find((c) => c.dataset.plugin === next.id)
          ?.querySelector<HTMLElement>('[data-plugin-name]')
      : noMatchEl.value?.querySelector<HTMLElement>('button')
    target?.focus()
  },
  { flush: 'pre' },
)

/** Final review: the count said to a screen reader once the typing stops, not at every key. */
const announced = ref('')
let announcing: ReturnType<typeof setTimeout> | undefined
watch([countText, narrowed], () => {
  clearTimeout(announcing)
  announcing = setTimeout(() => (announced.value = narrowed.value ? countText.value : ''), 500)
})
onBeforeUnmount(() => clearTimeout(announcing))

async function upload(files: FileList | null): Promise<void> {
  const file = files?.[0]
  if (input.value) input.value.value = ''
  if (!file) return
  await run('upload', () => pluginsApi.upload(file), t('plugins.uploaded', { name: file.name }))
}
/** User request 2026-10-11: a plugin from a public GitHub repository's release, installed off. */
const toasts = useToastStore()
const githubUrl = ref('')
async function installGithub(): Promise<void> {
  const url = githubUrl.value.trim()
  if (!url || busy.value) return
  let installed = null as PluginAdminView | null
  if (await run('github', async () => (installed = await pluginsApi.installGithub(url)))) {
    githubUrl.value = ''
    toasts.push({
      kind: 'success',
      message: t('plugins.github.installed', { name: installed ? nameOf(installed) : url }),
    })
  }
}
const card = 'rounded-xl border border-line bg-surface p-4 shadow-xs'
/** Saves a file of the kit, saying when it could not (review 2026-10-11). */
async function save(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (e) {
    toasts.push({ kind: 'error', message: t('plugins.build.failed', { reason: (e as Error).message }) })
  }
}

async function onSettings(values: Record<string, string | boolean>): Promise<void> {
  const p = editing.value
  editing.value = null
  if (p) await saveSettings(p, values)
}
</script>

<template>
  <section data-plugins class="flex h-full min-h-0 flex-col">
    <DsPageHeader :title="t('plugins.title')" :icon="Puzzle" :description="t('plugins.subtitle')">
      <template #actions>
        <template v-if="list.data.value?.enabled">
          <DsButton
            size="sm"
            :icon="FolderSearch"
            :loading="busy === 'scan'"
            @click="run('scan', pluginsApi.scan, t('plugins.scanned'))"
            >{{ t('plugins.scan') }}</DsButton
          >
          <input
            ref="input"
            type="file"
            accept=".tgz,.tar.gz,application/gzip"
            class="sr-only"
            tabindex="-1"
            data-plugin-upload
            :aria-label="t('plugins.upload')"
            @change="upload(($event.target as HTMLInputElement).files)"
          />
          <DsButton
            size="sm"
            variant="primary"
            :icon="Upload"
            :loading="busy === 'upload'"
            @click="input?.click()"
            >{{ t('plugins.upload') }}</DsButton
          >
        </template>
      </template>
    </DsPageHeader>
    <div class="min-h-0 flex-1 overflow-auto">
      <!-- User request 2026-10-31: the page uses its width — the plugins as a grid of cards, and installing,
           building and how plugins run in a column beside them. -->
      <div
        class="mx-auto grid w-full max-w-[100rem] items-start gap-5 px-6 py-5 xl:grid-cols-[minmax(0,1fr)_22rem]"
      >
        <div class="@container flex min-w-0 flex-col gap-4">
          <div
            v-if="list.isPending.value"
            aria-busy="true"
            class="grid gap-3 @2xl:grid-cols-2 @6xl:grid-cols-3"
          >
            <span class="sr-only" role="status">{{ t('app.loading') }}</span
            ><DsSkeleton v-for="i in 3" :key="i" class="h-48 rounded-xl" />
          </div>
          <DsCallout v-else-if="list.isError.value" tone="danger"
            >{{ describeError(list.error.value, t)
            }}<template #action
              ><DsButton size="sm" @click="list.refetch()">{{ t('common.retry') }}</DsButton></template
            ></DsCallout
          >
          <DsCallout v-else-if="!list.data.value?.enabled" data-plugins-off tone="warning">{{
            t('plugins.off')
          }}</DsCallout>
          <DsEmptyState
            v-else-if="!plugins.length"
            :icon="Puzzle"
            :title="t('plugins.empty')"
            :description="t('plugins.emptyHint')"
          />
          <template v-else>
            <dl class="grid grid-cols-2 gap-3 sm:grid-cols-4" data-plugin-stats>
              <div
                v-for="s in stats"
                :key="s.key"
                class="flex flex-col gap-0.5 rounded-xl border border-line bg-surface px-4 py-3 shadow-xs"
                :data-stat="s.key"
              >
                <dt class="flex items-center gap-1.5 text-small text-fg-subtle">
                  <span class="size-2 rounded-full" :class="s.dot" aria-hidden="true" />{{ s.label }}
                </dt>
                <dd class="text-lg font-semibold text-fg tabular-nums">{{ s.value }}</dd>
              </div>
            </dl>
            <div data-plugin-filters class="flex flex-wrap items-center gap-2">
              <DsSegmented
                v-model="state"
                size="sm"
                data-plugin-status-filter
                :label="t('plugins.filter.state')"
                :options="states"
              />
              <!-- A width of its own: a select sized by its parent shrinks to nothing in a wrapping row. -->
              <div class="w-52" data-plugin-source-filter>
                <DsSelect
                  v-model="source"
                  size="sm"
                  hide-label
                  :label="t('plugins.filter.source')"
                  :options="sources"
                />
              </div>
              <div class="max-w-80 min-w-44 flex-1" data-plugin-search>
                <DsInput
                  v-model="search"
                  size="sm"
                  :icon="Search"
                  :label="t('plugins.filter.search')"
                  hide-label
                  clearable
                  autocomplete="off"
                  spellcheck="false"
                  :placeholder="t('plugins.filter.search')"
                />
              </div>
              <div class="ml-auto flex items-center gap-2">
                <span data-plugin-count class="text-small text-fg-subtle">{{ countText }}</span>
                <span data-plugin-announce role="status" class="sr-only">{{ announced }}</span>
                <DsButton v-if="narrowed" size="sm" variant="ghost" :icon="FilterX" @click="clearFilters">{{
                  t('plugins.filter.clear')
                }}</DsButton>
              </div>
            </div>
            <div v-if="!shown.length" ref="noMatchEl" data-plugins-no-match>
              <DsEmptyState :icon="FilterX" :title="t('plugins.filter.noMatch')">
                <template #actions>
                  <DsButton size="sm" :icon="FilterX" @click="clearFilters">{{
                    t('plugins.filter.clear')
                  }}</DsButton>
                </template>
              </DsEmptyState>
            </div>
            <ul
              v-else
              ref="listEl"
              data-plugin-grid
              class="grid gap-3 @2xl:grid-cols-2 @6xl:grid-cols-3"
              :aria-label="t('plugins.title')"
            >
              <li
                v-for="p in shown"
                :key="p.id"
                :data-plugin="p.id"
                class="flex min-w-0 flex-col rounded-xl border border-line bg-surface shadow-xs transition-[border-color,box-shadow] duration-160 hover:border-line-strong hover:shadow-sm"
              >
                <div class="flex flex-1 flex-col gap-3 p-4">
                  <div class="flex items-start gap-3">
                    <span
                      class="grid size-10 shrink-0 place-items-center rounded-lg"
                      :class="p.enabled ? 'bg-accent-soft text-accent-fg' : 'bg-subtle text-fg-muted'"
                      aria-hidden="true"
                    >
                      <component
                        :is="pluginIcon(p.manifest?.contributes.collectionTabs[0]?.icon)"
                        class="size-5"
                      />
                    </span>
                    <div class="min-w-0 flex-1">
                      <h3 class="flex min-w-0 items-baseline gap-2 text-ui font-semibold text-fg">
                        <button
                          type="button"
                          data-plugin-name
                          class="min-w-0 cursor-pointer truncate rounded-sm text-left hover:text-accent-fg hover:underline"
                          :title="nameOf(p)"
                          @click="openPluginDetailsTab(tabs, p.id)"
                        >
                          {{ nameOf(p) }}
                        </button>
                        <span
                          v-if="p.manifest"
                          class="shrink-0 font-mono text-small font-normal text-fg-subtle"
                          >{{ p.manifest.version }}</span
                        >
                      </h3>
                      <p class="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <DsBadge :tone="TONES[statusOf(p)]" data-plugin-status>{{
                          t(`plugins.status.${statusOf(p)}`)
                        }}</DsBadge>
                        <DsBadge>{{ t(`plugins.source.${p.source}`) }}</DsBadge>
                        <!-- User request 2026-10-11: what its security scan found, at a glance. -->
                        <DsBadge v-if="scanTone(p)" :tone="scanTone(p)!" data-plugin-scan>{{
                          scanBadge(p)
                        }}</DsBadge>
                      </p>
                    </div>
                    <!-- Review of R3–R5 (I-4): removing is in the card's "…", in danger colour; still confirmed. -->
                    <DsMenu
                      v-if="p.source !== 'bundled'"
                      focusable
                      size="header"
                      :label="t('plugins.details.more', { name: nameOf(p) })"
                      :items="[{ id: 'remove', label: t('plugins.remove'), icon: Trash2, danger: true }]"
                      @select="(id: string) => id === 'remove' && remove(p)"
                    />
                  </div>
                  <!-- User request 2026-10-10: an update says what it came from. -->
                  <p
                    v-if="p.updatedFrom && p.manifest"
                    class="flex items-center gap-1.5 text-small text-accent-fg"
                    data-plugin-updated
                  >
                    <ArrowUpCircle class="size-3.5" aria-hidden="true" />
                    {{ t('plugins.details.updated', { from: p.updatedFrom, to: p.manifest.version }) }}
                  </p>
                  <p
                    v-if="p.manifest?.description"
                    class="line-clamp-3 text-small text-fg-muted"
                    :title="localized(p.manifest.description, locale)"
                  >
                    {{ localized(p.manifest.description, locale) }}
                  </p>
                  <p v-if="contributions(p).length" class="flex flex-wrap gap-1.5">
                    <span
                      v-for="c in contributions(p)"
                      :key="c"
                      class="rounded-md bg-subtle px-1.5 py-0.5 text-caption text-fg-muted"
                      >{{ c }}</span
                    >
                  </p>
                  <!-- What it asks for, one line each (a long one wraps under its own shield). -->
                  <ul
                    v-if="p.manifest"
                    class="flex flex-col gap-1 text-small text-fg-muted"
                    data-plugin-permissions
                  >
                    <li v-for="perm in p.manifest.permissions" :key="perm" class="flex items-start gap-1.5">
                      <ShieldCheck class="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
                      <span class="min-w-0 flex-1">{{ permission(perm) }}</span>
                      <DsBadge v-if="p.newPermissions.includes(perm)" tone="warning">{{
                        t('plugins.new')
                      }}</DsBadge>
                    </li>
                    <li v-if="!p.manifest.permissions.length" class="flex items-center gap-1.5">
                      <ShieldCheck class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />{{
                        t('plugins.permission.none')
                      }}
                    </li>
                  </ul>
                  <DsCallout v-if="p.error" tone="danger" data-plugin-error>{{ p.error }}</DsCallout>
                  <DsCallout v-if="refusedAddresses(p).length" tone="warning" data-plugin-address-refused>{{
                    t('plugins.urlRefused', { settings: refusedAddresses(p).join(', ') })
                  }}</DsCallout>
                  <p v-if="p.digest" class="mt-auto truncate text-caption text-fg-subtle">
                    {{
                      t(
                        'plugins.files',
                        { count: p.fileCount, size: formatBytes(p.bytes, locale) },
                        p.fileCount,
                      )
                    }}
                    ·
                    <span class="font-mono" :title="p.digest">{{
                      t('plugins.digest', { digest: p.digest.slice(0, 16) })
                    }}</span>
                  </p>
                </div>
                <div
                  data-plugin-actions
                  class="flex flex-wrap items-center gap-2 rounded-b-xl border-t border-line bg-subtle/40 px-4 py-2.5"
                >
                  <DsButton
                    v-if="statusOf(p) !== 'enabled' && statusOf(p) !== 'broken'"
                    variant="primary"
                    size="sm"
                    :loading="busy === p.id"
                    @click="approve(p)"
                    >{{ t('plugins.approve') }}</DsButton
                  >
                  <DsButton v-if="p.enabled" size="sm" :loading="busy === p.id" @click="disable(p)">{{
                    t('plugins.disable')
                  }}</DsButton>
                  <DsButton
                    v-if="p.enabled && p.manifest && Object.keys(p.manifest.settings).length"
                    size="sm"
                    variant="ghost"
                    @click="editing = p"
                    >{{ t('plugins.settings') }}</DsButton
                  >
                  <DsButton
                    size="sm"
                    variant="ghost"
                    class="ml-auto"
                    @click="openPluginDetailsTab(tabs, p.id)"
                    >{{ t('plugins.details.open') }}</DsButton
                  >
                </div>
              </li>
            </ul>
          </template>
        </div>

        <aside data-plugin-aside class="flex min-w-0 flex-col gap-4">
          <DsCallout tone="info" :title="t('plugins.safetyTitle')">{{ t('plugins.safety') }}</DsCallout>
          <form
            v-if="list.data.value?.enabled && list.data.value.github"
            data-plugin-github
            :class="card"
            novalidate
            @submit.prevent="installGithub"
          >
            <h3 class="flex items-center gap-2 text-ui font-semibold text-fg">
              <PackagePlus class="size-4 text-fg-subtle" aria-hidden="true" />{{ t('plugins.github.title') }}
            </h3>
            <p class="mt-1 text-small text-fg-subtle">{{ t('plugins.github.hint') }}</p>
            <div class="mt-3 flex flex-col gap-2">
              <DsInput
                v-model="githubUrl"
                type="url"
                mono
                :label="t('plugins.github.label')"
                :placeholder="t('plugins.github.placeholder')"
                autocomplete="off"
                spellcheck="false"
              />
              <DsButton
                type="submit"
                variant="primary"
                class="self-start"
                :icon="PackagePlus"
                :loading="busy === 'github'"
                :disabled="!githubUrl.trim()"
                >{{ t('plugins.github.install') }}</DsButton
              >
            </div>
          </form>

          <!-- User request 2026-10-11: how to build a plugin, with what to start from. -->
          <section data-plugin-build :class="card" :aria-labelledby="buildTitleId">
            <h3 :id="buildTitleId" class="flex items-center gap-2 text-ui font-semibold text-fg">
              <Wrench class="size-4 text-fg-subtle" aria-hidden="true" />{{ t('plugins.build.title') }}
            </h3>
            <p class="mt-1 text-small text-fg-subtle">{{ t('plugins.build.hint') }}</p>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <a
                data-plugin-guide
                :href="guidePath(locale)"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-ui font-medium whitespace-nowrap text-on-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] transition-colors duration-120 hover:bg-accent-hover"
              >
                <BookOpen class="size-4" aria-hidden="true" />{{ t('plugins.build.guide') }}
              </a>
              <DsButton :icon="Download" @click="save(saveStarter)">{{
                t('plugins.build.starter')
              }}</DsButton>
            </div>
            <h4 class="mt-4 flex items-center gap-2 text-small font-semibold text-fg">
              <Bot class="size-4 text-fg-subtle" aria-hidden="true" />{{ t('plugins.build.aiTitle') }}
            </h4>
            <p class="mt-0.5 text-small text-fg-subtle">{{ t('plugins.build.aiHint') }}</p>
            <div class="mt-2 flex flex-col items-start gap-1.5">
              <DsButton
                v-for="f in AI_FILES"
                :key="f.name"
                size="sm"
                variant="ghost"
                :icon="Download"
                @click="save(() => saveAiFile(f))"
                >{{ t('plugins.build.aiFile', { tool: f.tool, name: f.name }) }}</DsButton
              >
            </div>
          </section>
        </aside>
      </div>
    </div>
    <PluginSettingsDialog :plugin="editing" @close="editing = null" @save="onSettings" />
  </section>
</template>
