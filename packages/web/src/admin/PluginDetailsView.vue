<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ArrowLeft,
  ArrowUpCircle,
  BookOpen,
  ExternalLink,
  FileText,
  History,
  Puzzle,
  ScanSearch,
  ShieldCheck,
  Trash2,
} from 'lucide-vue-next'
import { isHiddenAt, type PluginAdminView } from '@mongo-manager/shared/browser'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import DsBadge from '@/ds/DsBadge.vue'
import DsMenu from '@/ds/DsMenu.vue'
import DsPageHeader from '@/ds/DsPageHeader.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import SafeMarkdown from '@/ai/SafeMarkdown.vue'
import { pluginKeys, pluginsApi } from '@/api/plugins'
import { describeError } from '@/api/errors'
import { formatBytes } from '@/format'
import { useTabsStore } from '@/stores/tabs'
import { openPluginsTab } from '@/workspace/openTabs'
import { localized } from '@/plugins/store'
import { pluginIcon } from '@/plugins/icons'
import PluginSettingsDialog from './PluginSettingsDialog.vue'
import { PLUGIN_STATUS_TONES, pluginStatus, scanTone, usePluginAdmin } from './usePluginAdmin'
import { compareVersions } from './pluginVersions'

/**
 * User request 2026-10-10: a plugin's own page — who made it and when, its license and addresses,
 * what each release changed (those since an update marked new), its README, what it asks for and
 * adds, its files; approved, disabled, set up or removed here as on the Plugins page.
 */
const props = defineProps<{ pluginId: string }>()
const { t, locale } = useI18n()
const tabs = useTabsStore()
const list = useQuery({ queryKey: pluginKeys.manage, queryFn: pluginsApi.manage })
const plugin = computed<PluginAdminView | undefined>(() =>
  list.data.value?.plugins.find((p) => p.id === props.pluginId),
)
const manifest = computed(() => plugin.value?.manifest ?? null)
// User request 2026-10-11: the README in the reader's language when the plugin has one.
const readme = useQuery({
  queryKey: computed(() => [...pluginKeys.manage, props.pluginId, 'readme', locale.value]),
  queryFn: () => pluginsApi.readme(props.pluginId, locale.value),
  enabled: computed(() => !!plugin.value?.readme),
})
const {
  busy,
  nameOf,
  permission,
  contributions,
  ruleText,
  scanBadge,
  approve,
  remove,
  disable,
  saveSettings,
} = usePluginAdmin()
const SEVERITY_TONES = { high: 'danger', medium: 'warning', low: 'info', info: 'neutral' } as const
const editing = ref(false)
const status = computed(() => (plugin.value ? pluginStatus(plugin.value) : 'broken'))

/** The release notes, newest first; those after the version it was updated from are new. */
const releases = computed(() =>
  [...(manifest.value?.changelog ?? [])]
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((r) => ({
      ...r,
      fresh:
        !!plugin.value?.updatedFrom &&
        compareVersions(r.version, plugin.value.updatedFrom) > 0 &&
        compareVersions(r.version, manifest.value!.version) <= 0,
    })),
)
const day = (iso: string) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  )
const when = (ms: number) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(ms))

/** Removed: back to the list, this page closed (review M12) — only when it worked. */
async function onRemove(p: PluginAdminView): Promise<void> {
  if (!(await remove(p))) return
  const own = tabs.tabs.find((t) => t.kind === 'pluginDetails' && t.params.pluginId === props.pluginId)
  openPluginsTab(tabs)
  if (own) tabs.close(own.id)
}
/**
 * Review M11: what could hide or reverse a README's text is shown as its \u code — and what shows
 * as nothing (security audit 2026-10-16, M2).
 */
const readmeText = computed(() =>
  [...(readme.data.value?.text ?? '')]
    // An emoji's own joiner and selector hide nothing (review of the security pass).
    .map((c, i, all) =>
      isHiddenAt(all, i) && c !== '\n' && c !== '\t' && c !== '\r'
        ? `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`
        : c,
    )
    .join(''),
)
/** Review M8: an address as it goes — host and path, the whole of it in its title. */
const shown = (url: string) => url.replace(/^https:\/\//, '').replace(/\/$/, '')
async function onSettings(values: Record<string, string | boolean>): Promise<void> {
  editing.value = false
  if (plugin.value) await saveSettings(plugin.value, values)
}

const card = 'rounded-xl border border-line bg-surface p-4 shadow-xs'
const term = 'text-small text-fg-subtle'
const value = 'min-w-0 text-ui text-fg'
const link =
  'inline-flex min-w-0 items-center gap-1 text-ui text-accent-fg underline-offset-2 hover:underline focus-visible:underline'
</script>

<template>
  <section data-plugin-details class="flex h-full min-h-0 flex-col">
    <DsPageHeader
      :title="plugin ? nameOf(plugin) : t('plugins.title')"
      :context="manifest?.version"
      :description="manifest?.description ? localized(manifest.description, locale) : undefined"
    >
      <template #crumbs>
        <button
          type="button"
          class="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"
          @click="openPluginsTab(tabs)"
        >
          <ArrowLeft class="size-3.5" aria-hidden="true" />{{ t('plugins.details.back') }}
        </button>
      </template>
      <template #icon>
        <span
          class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg"
          aria-hidden="true"
        >
          <component :is="pluginIcon(manifest?.contributes.collectionTabs[0]?.icon)" class="size-[18px]" />
        </span>
      </template>
      <!-- The name alone in the heading (review 2026-10-10); its state and source beside the facts. -->
      <template v-if="plugin" #facts>
        <DsBadge :tone="PLUGIN_STATUS_TONES[status]">{{ t(`plugins.status.${status}`) }}</DsBadge>
        <DsBadge>{{ t(`plugins.source.${plugin.source}`) }}</DsBadge>
      </template>
      <template v-if="plugin" #actions>
        <DsButton
          v-if="status !== 'enabled' && status !== 'broken'"
          variant="primary"
          size="sm"
          :loading="busy === plugin.id"
          @click="approve(plugin)"
          >{{ t('plugins.approve') }}</DsButton
        >
        <DsButton v-if="plugin.enabled" size="sm" :loading="busy === plugin.id" @click="disable(plugin)">{{
          t('plugins.disable')
        }}</DsButton>
        <DsButton
          v-if="plugin.enabled && manifest && Object.keys(manifest.settings).length"
          size="sm"
          variant="ghost"
          @click="editing = true"
          >{{ t('plugins.settings') }}</DsButton
        >
        <!-- UI redesign §0 decision 3: removing is in the "…" menu, in danger colour, confirmed. -->
        <DsMenu
          v-if="plugin.source !== 'bundled'"
          focusable
          :label="t('plugins.details.more', { name: nameOf(plugin) })"
          size="header"
          :items="[{ id: 'remove', label: t('plugins.remove'), icon: Trash2, danger: true }]"
          @select="(id: string) => id === 'remove' && plugin && onRemove(plugin)"
        />
      </template>
    </DsPageHeader>
    <div class="min-h-0 flex-1 overflow-auto">
      <!-- User request 2026-10-31: wider, as the Plugins page; a reading width still (its readme). -->
      <div class="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-5">
        <div v-if="list.isPending.value" aria-busy="true" class="flex flex-col gap-3">
          <span class="sr-only" role="status">{{ t('app.loading') }}</span
          ><DsSkeleton v-for="i in 3" :key="i" class="h-20 rounded-card" />
        </div>
        <DsCallout v-else-if="list.isError.value" tone="danger"
          >{{ describeError(list.error.value, t)
          }}<template #action
            ><DsButton size="sm" @click="list.refetch()">{{ t('common.retry') }}</DsButton></template
          ></DsCallout
        >
        <DsEmptyState
          v-else-if="!plugin"
          :icon="Puzzle"
          :title="t('plugins.details.missing')"
          :description="t('plugins.details.missingHint')"
        />

        <template v-else>
          <DsCallout
            v-if="plugin.updatedFrom && manifest"
            :tone="plugin.enabled && plugin.approvedCurrent ? 'info' : 'warning'"
            data-plugin-updated
          >
            <span class="inline-flex items-center gap-1.5">
              <ArrowUpCircle class="size-4" aria-hidden="true" />
              {{
                t(
                  // Kept only when it moved on its own (review 2026-10-11); else an administrator approved it.
                  !plugin.enabled || !plugin.approvedCurrent
                    ? 'plugins.details.updatedWaiting'
                    : plugin.approvalCarried
                      ? 'plugins.details.updatedLong'
                      : 'plugins.details.updatedApproved',
                  { from: plugin.updatedFrom, to: manifest.version },
                )
              }}
            </span>
          </DsCallout>
          <DsCallout v-if="plugin.error" tone="danger">{{ plugin.error }}</DsCallout>

          <div class="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div class="flex min-w-0 flex-col gap-5">
              <!-- User request 2026-10-11: what its files were found to try, before anyone approves it. -->
              <section :class="card" :aria-labelledby="`${pluginId}-scan`" data-plugin-scan-findings>
                <h3
                  :id="`${pluginId}-scan`"
                  class="mb-2 flex flex-wrap items-center gap-2 text-ui font-semibold text-fg"
                >
                  <ScanSearch class="size-4 text-fg-subtle" aria-hidden="true" />{{
                    t('plugins.security.title')
                  }}
                  <DsBadge v-if="scanTone(plugin)" :tone="scanTone(plugin)!">{{ scanBadge(plugin) }}</DsBadge>
                </h3>
                <p class="mb-3 max-w-2xl text-small text-fg-subtle">{{ t('plugins.security.intro') }}</p>
                <p v-if="!plugin.scan" class="text-ui text-fg-muted">{{ t('plugins.security.notRead') }}</p>
                <p v-else-if="!plugin.scan.findings.length" class="text-ui text-fg-muted">
                  {{ t('plugins.security.none') }}
                </p>
                <template v-else>
                  <p class="mb-3 text-small text-fg-muted">
                    {{ t('plugins.security.summary', plugin.scan.counts) }}
                  </p>
                  <ul class="flex flex-col divide-y divide-line">
                    <li
                      v-for="(f, i) in plugin.scan.findings"
                      :key="i"
                      data-finding
                      class="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0"
                    >
                      <p class="flex flex-wrap items-center gap-2">
                        <DsBadge :tone="SEVERITY_TONES[f.severity]">{{
                          t(`plugins.security.severity.${f.severity}`)
                        }}</DsBadge>
                        <span class="text-ui text-fg">{{ ruleText(f) }}</span>
                      </p>
                      <p class="font-mono text-caption break-all text-fg-subtle">
                        {{ t('plugins.security.where', { file: f.file, line: f.line }) }}
                      </p>
                      <code
                        v-if="f.excerpt"
                        class="block rounded-md bg-subtle px-2 py-1 font-mono text-caption break-all whitespace-pre-wrap text-fg-muted"
                        >{{ f.excerpt }}</code
                      >
                    </li>
                  </ul>
                  <p v-if="plugin.scan.truncated" class="mt-3 text-small text-fg-subtle">
                    {{ t('plugins.security.truncated') }}
                  </p>
                </template>
              </section>

              <section :class="card" :aria-labelledby="`${pluginId}-releases`">
                <h3
                  :id="`${pluginId}-releases`"
                  class="mb-3 flex items-center gap-2 text-ui font-semibold text-fg"
                >
                  <History class="size-4 text-fg-subtle" aria-hidden="true" />{{
                    t('plugins.details.releases')
                  }}
                </h3>
                <p v-if="!releases.length" class="text-small text-fg-subtle">
                  {{ t('plugins.details.noReleases') }}
                </p>
                <ol v-else class="flex flex-col">
                  <li
                    v-for="r in releases"
                    :key="r.version"
                    :data-release="r.version"
                    class="relative border-l border-line pb-4 pl-4 last:pb-0"
                  >
                    <span
                      class="absolute top-1.5 -left-[5px] size-2.5 rounded-full border-2 border-surface"
                      :class="r.fresh ? 'bg-accent' : 'bg-line-strong'"
                      aria-hidden="true"
                    />
                    <p class="flex flex-wrap items-center gap-2">
                      <span class="font-mono text-ui font-semibold text-fg">{{ r.version }}</span>
                      <span class="text-small text-fg-subtle">{{ day(r.date) }}</span>
                      <DsBadge v-if="r.fresh" tone="accent">{{ t('plugins.details.new') }}</DsBadge>
                      <DsBadge v-if="r.version === manifest?.version">{{
                        t('plugins.details.installed')
                      }}</DsBadge>
                    </p>
                    <p class="mt-1 text-ui whitespace-pre-line text-fg-muted">
                      {{ localized(r.notes, locale) }}
                    </p>
                  </li>
                </ol>
              </section>

              <section :class="card" :aria-labelledby="`${pluginId}-readme`">
                <h3
                  :id="`${pluginId}-readme`"
                  class="mb-3 flex items-center gap-2 text-ui font-semibold text-fg"
                >
                  <BookOpen class="size-4 text-fg-subtle" aria-hidden="true" />{{
                    t('plugins.details.readme')
                  }}
                </h3>
                <p v-if="!plugin.readme" class="text-small text-fg-subtle">
                  {{ t('plugins.details.noReadme') }}
                </p>
                <div v-else-if="readme.isPending.value" aria-busy="true" class="flex flex-col gap-3">
                  <span class="sr-only" role="status">{{ t('app.loading') }}</span
                  ><DsSkeleton v-for="i in 3" :key="i" class="h-4 w-full" />
                </div>
                <DsCallout v-else-if="readme.isError.value" tone="danger"
                  >{{ describeError(readme.error.value, t)
                  }}<template #action
                    ><DsButton size="sm" @click="readme.refetch()">{{
                      t('common.retry')
                    }}</DsButton></template
                  ></DsCallout
                >
                <template v-else-if="readme.data.value?.text">
                  <div data-plugin-readme class="text-ui text-fg">
                    <SafeMarkdown :source="readmeText" heading-tag="h4" />
                  </div>
                  <p v-if="readme.data.value.truncated" class="mt-3 text-small text-fg-subtle">
                    {{ t('plugins.details.readmeTruncated') }}
                  </p>
                </template>
                <p v-else class="text-small text-fg-subtle">{{ t('plugins.details.noReadme') }}</p>
              </section>
            </div>

            <aside class="flex min-w-0 flex-col gap-5">
              <div :class="card">
                <h3 class="mb-3 text-ui font-semibold text-fg">{{ t('plugins.details.about') }}</h3>
                <dl class="flex flex-col gap-2.5">
                  <div v-if="manifest?.author">
                    <dt :class="term">{{ t('plugins.details.author') }}</dt>
                    <dd :class="value">
                      <a
                        v-if="manifest.author.url"
                        :href="manifest.author.url"
                        :title="manifest.author.url"
                        target="_blank"
                        rel="noopener noreferrer"
                        :class="link"
                        >{{ manifest.author.name }}<ExternalLink class="size-3 shrink-0" aria-hidden="true"
                      /></a>
                      <span v-else>{{ manifest.author.name }}</span>
                    </dd>
                  </div>
                  <div v-if="manifest?.publishedAt">
                    <dt :class="term">{{ t('plugins.details.published') }}</dt>
                    <dd :class="value">{{ day(manifest.publishedAt) }}</dd>
                  </div>
                  <div v-if="manifest?.license">
                    <dt :class="term">{{ t('plugins.details.license') }}</dt>
                    <dd :class="value" class="font-mono">{{ manifest.license }}</dd>
                  </div>
                  <div v-if="manifest?.homepage">
                    <dt :class="term">{{ t('plugins.details.homepage') }}</dt>
                    <dd :class="value">
                      <a
                        :href="manifest.homepage"
                        :title="manifest.homepage"
                        target="_blank"
                        rel="noopener noreferrer"
                        :class="link"
                        ><span class="truncate">{{ shown(manifest.homepage) }}</span
                        ><ExternalLink class="size-3 shrink-0" aria-hidden="true"
                      /></a>
                    </dd>
                  </div>
                  <div v-if="manifest?.repository">
                    <dt :class="term">{{ t('plugins.details.repository') }}</dt>
                    <dd :class="value">
                      <a
                        :href="manifest.repository"
                        :title="manifest.repository"
                        target="_blank"
                        rel="noopener noreferrer"
                        :class="link"
                        ><span class="truncate">{{ shown(manifest.repository) }}</span
                        ><ExternalLink class="size-3 shrink-0" aria-hidden="true"
                      /></a>
                    </dd>
                  </div>
                  <!-- User request 2026-10-11: the GitHub release it was installed from. -->
                  <div v-if="plugin.origin" data-plugin-origin>
                    <dt :class="term">{{ t('plugins.github.from') }}</dt>
                    <dd :class="value">
                      <a
                        v-if="plugin.origin.url.startsWith('https://github.com/')"
                        :href="plugin.origin.url"
                        :title="plugin.origin.url"
                        target="_blank"
                        rel="noopener noreferrer"
                        :class="link"
                        ><span class="truncate">{{
                          t('plugins.github.release', {
                            repository: plugin.origin.repository,
                            release: plugin.origin.release,
                          })
                        }}</span
                        ><ExternalLink class="size-3 shrink-0" aria-hidden="true"
                      /></a>
                    </dd>
                  </div>
                  <div>
                    <dt :class="term">{{ t('plugins.details.installedOn') }}</dt>
                    <dd :class="value">{{ when(plugin.installedAt) }}</dd>
                  </div>
                  <div>
                    <dt :class="term">{{ t('plugins.details.lastChanged') }}</dt>
                    <dd :class="value">{{ when(plugin.updatedAt) }}</dd>
                  </div>
                </dl>
              </div>

              <div :class="card">
                <h3 class="mb-3 flex items-center gap-2 text-ui font-semibold text-fg">
                  <ShieldCheck class="size-4 text-fg-subtle" aria-hidden="true" />{{
                    t('plugins.details.permissions')
                  }}
                </h3>
                <ul v-if="manifest?.permissions.length" class="flex flex-col gap-1.5">
                  <li
                    v-for="perm in manifest.permissions"
                    :key="perm"
                    class="flex items-center gap-2 text-ui text-fg"
                  >
                    {{ permission(perm) }}
                    <DsBadge v-if="plugin.newPermissions.includes(perm)" tone="warning">{{
                      t('plugins.new')
                    }}</DsBadge>
                    <DsBadge v-else-if="plugin.approvedCurrent" tone="accent">{{
                      t('plugins.details.approved')
                    }}</DsBadge>
                  </li>
                </ul>
                <p v-else class="text-small text-fg-subtle">{{ t('plugins.permission.none') }}</p>
              </div>

              <div v-if="contributions(plugin).length" :class="card">
                <h3 class="mb-3 text-ui font-semibold text-fg">{{ t('plugins.details.adds') }}</h3>
                <ul class="flex flex-col gap-1.5">
                  <li v-for="c in contributions(plugin)" :key="c" class="text-ui text-fg-muted">{{ c }}</li>
                </ul>
              </div>

              <div v-if="plugin.digest" :class="card">
                <h3 class="mb-3 flex items-center gap-2 text-ui font-semibold text-fg">
                  <FileText class="size-4 text-fg-subtle" aria-hidden="true" />{{
                    t('plugins.details.files')
                  }}
                </h3>
                <p class="text-ui text-fg-muted">
                  {{
                    t(
                      'plugins.files',
                      { count: plugin.fileCount, size: formatBytes(plugin.bytes, locale) },
                      plugin.fileCount,
                    )
                  }}
                </p>
                <p class="mt-1 font-mono text-caption break-all text-fg-subtle">{{ plugin.digest }}</p>
              </div>
            </aside>
          </div>
        </template>
      </div>
    </div>
    <PluginSettingsDialog
      :plugin="editing ? (plugin ?? null) : null"
      @close="editing = false"
      @save="onSettings"
    />
  </section>
</template>
