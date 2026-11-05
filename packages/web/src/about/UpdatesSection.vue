<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUpRight, Download, RefreshCw, TriangleAlert } from 'lucide-vue-next'
import { RELEASE_IMAGE, RELEASE_NPM_PACKAGE, RELEASE_REPO } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCodeBlock from '@/ds/DsCodeBlock.vue'
import DsProgress from '@/ds/DsProgress.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import { explainError } from '@/api/reasons'
import { formatRelative } from '@/format'
import { useUpdatesStore } from '@/stores/updates'
import UpdateDialog from './UpdateDialog.vue'

/**
 * The updater (2026-11-03), spec §6: the installed version for everyone; for an administrator the
 * check, its daily setting, the new version's notes and Update — or, where this install cannot
 * update itself, what to run instead.
 */
const { t, locale } = useI18n()
const store = useUpdatesStore()
const titleId = useId()
const dialogOpen = ref(false)
const error = ref<string | null>(null)

const status = computed(() => store.status)
const admin = computed(() => store.admin && !!status.value && !status.value.disabled)
const latest = computed(() => status.value?.latest ?? null)
/** Final review (minor): only the project's own release page is ever a link. */
const releaseUrl = computed(() => {
  const url = latest.value?.url ?? ''
  return url.startsWith(`https://github.com/${RELEASE_REPO}/releases/tag/v`) ? url : null
})
/** How the last update ended, in the reader's words (the launcher's own reason is English). */
const lastNote = computed(() => {
  const last = store.lastUpdateNote
  if (!last) return null
  if (last.outcome === 'updated') return t('about.updates.updated', { version: last.version })
  if (last.outcome === 'refused') return t('about.updates.refused', { version: last.version })
  const why = t(`about.updates.why.${last.code ?? 'exited'}`)
  return t('about.updates.rolledBack', { version: last.version, why })
})
const reasonKey = (reason: string | undefined, fallback: string) =>
  reason === 'node_old' ? 'nodeOld' : reason === 'launcher_old' ? 'launcherOld' : fallback
const lastCheck = computed(() => status.value?.lastCheck ?? null)

const date = (iso: string) => {
  const at = Date.parse(iso)
  return Number.isFinite(at) ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'long' }).format(at) : ''
}
const time = (at: number) => new Intl.DateTimeFormat(locale.value, { timeStyle: 'short' }).format(at)

const headline = computed(() => {
  const s = status.value
  if (!s) return ''
  if (!admin.value) return t('about.updates.installed', { version: s.installed })
  if (latest.value) return t('about.updates.available', { version: latest.value.version })
  if (lastCheck.value?.outcome === 'current') return t('about.updates.current', { version: s.installed })
  return t('about.updates.installed', { version: s.installed })
})
const failure = computed(() => {
  const c = lastCheck.value
  if (!c || c.outcome !== 'failed' || !c.reason) return null
  if (c.reason === 'rate_limited')
    return c.retryAt
      ? t('about.updates.failures.rateLimited', { time: time(c.retryAt) })
      : t('about.updates.failures.rateLimitedLater')
  return t(`about.updates.failures.${c.reason}`)
})
const checkedLine = computed(() =>
  lastCheck.value
    ? t('about.updates.lastChecked', { when: formatRelative(lastCheck.value.at - Date.now(), locale.value) })
    : t('about.updates.neverChecked'),
)
const progressText = computed(() => {
  const p = status.value?.progress
  if (!p) return null
  return p.phase === 'downloading'
    ? t('about.updates.progress.downloading', { percent: p.percent ?? 0 })
    : t(`about.updates.progress.${p.phase}`)
})
const pullCommands = computed(() =>
  latest.value
    ? [`docker pull ${RELEASE_IMAGE}:${latest.value.version}`, 'docker compose pull && docker compose up -d']
    : [],
)
const npmCommand = computed(() =>
  latest.value ? `npm i -g ${RELEASE_NPM_PACKAGE}@${latest.value.version}` : '',
)
const installFailure = computed(() => {
  const f = status.value?.installFailure
  if (!f) return null
  return f.reason === 'digest' || f.reason === 'signature'
    ? t('about.updates.installFailedSigned')
    : t('about.updates.installFailed')
})

async function check(): Promise<void> {
  error.value = null
  try {
    await store.check()
  } catch (e) {
    error.value = explainError(e, t)
  }
}

async function toggle(on: boolean): Promise<void> {
  error.value = null
  try {
    await store.setAuto(on)
  } catch (e) {
    error.value = explainError(e, t)
  }
}
const auto = computed({ get: () => status.value?.auto ?? false, set: (on: boolean) => void toggle(on) })
</script>

<template>
  <section
    v-if="status"
    class="min-w-0 rounded-card border border-line bg-surface p-5 shadow-xs"
    :aria-labelledby="titleId"
    data-about-updates
  >
    <div class="mb-3 flex flex-wrap items-start gap-3">
      <span
        class="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg"
        aria-hidden="true"
        ><RefreshCw class="size-[18px]"
      /></span>
      <div class="min-w-0 flex-1 basis-60">
        <h3 :id="titleId" class="text-ui font-semibold text-fg">{{ t('about.updates.title') }}</h3>
        <p class="text-ui text-fg" data-updates-headline>{{ headline }}</p>
        <p v-if="admin" class="text-small text-fg-subtle">{{ checkedLine }}</p>
      </div>
      <DsButton v-if="admin" :icon="RefreshCw" :loading="store.checking" @click="check">{{
        t('about.updates.checkNow')
      }}</DsButton>
    </div>

    <p v-if="status.disabled" class="text-small text-fg-muted" data-updates-off>
      {{ t('about.updates.off') }}
    </p>

    <div class="flex flex-col gap-3">
      <DsCallout v-if="store.justUpdated" tone="success" data-updates-note>{{
        t('about.updates.updated', { version: store.justUpdated })
      }}</DsCallout>
      <DsCallout
        v-else-if="admin && store.lastUpdateNote"
        :tone="store.lastUpdateNote.outcome === 'updated' ? 'success' : 'danger'"
        data-updates-note
      >
        {{ lastNote }}
        <button
          type="button"
          class="ml-2 cursor-pointer text-small text-fg-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
          @click="store.dismissLastUpdate()"
        >
          {{ t('about.updates.dismiss') }}
        </button>
      </DsCallout>
      <DsCallout v-if="failure && admin" tone="warning" data-updates-failure>{{ failure }}</DsCallout>
      <DsCallout v-if="installFailure && admin" tone="danger">{{ installFailure }}</DsCallout>
      <DsCallout v-if="error" tone="danger">{{ error }}</DsCallout>
      <DsCallout v-if="admin && status.image?.old" tone="warning">{{
        t('about.updates.imageOld')
      }}</DsCallout>

      <template v-if="admin && latest">
        <p class="text-small text-fg-muted">
          {{ t('about.updates.published', { date: date(latest.publishedAt) }) }}
        </p>
        <div v-if="latest.notes" class="rounded-xl border border-line bg-canvas p-3.5">
          <p class="mb-1 text-small font-semibold text-fg">{{ t('about.updates.notes') }}</p>
          <pre class="max-h-64 overflow-auto font-sans text-small whitespace-pre-wrap text-fg-muted">{{
            latest.notes
          }}</pre>
        </div>
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
          <a
            v-if="releaseUrl"
            :href="releaseUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex min-w-0 items-center gap-1 rounded-sm text-ui text-accent-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
            >{{ t('about.updates.releasePage')
            }}<ArrowUpRight class="size-3.5 shrink-0" aria-hidden="true" /><span class="sr-only">
              {{ t('about.newTab') }}</span
            ></a
          >
        </div>

        <div v-if="progressText" class="flex flex-col gap-1.5" data-updates-progress>
          <p class="text-small text-fg">{{ progressText }}</p>
          <DsProgress
            v-if="status.progress?.phase === 'downloading'"
            :value="(status.progress.percent ?? 0) / 100"
            :label="progressText"
          />
        </div>
        <div v-else-if="status.offer === 'install'">
          <DsButton variant="primary" :icon="Download" @click="dialogOpen = true">{{
            t('about.updates.update')
          }}</DsButton>
        </div>
        <div v-else-if="status.offer === 'pull_image'" class="flex flex-col gap-2">
          <p class="text-small text-fg">
            <TriangleAlert class="mr-1 inline size-4 align-text-bottom text-warning" aria-hidden="true" />{{
              t(`about.updates.pull.${reasonKey(status.offerReason, 'imageOld')}`)
            }}
          </p>
          <DsCodeBlock :code="pullCommands.join('\n')" :copy-label="t('about.updates.copy')" />
        </div>
        <div v-else-if="status.offer === 'reinstall'" class="flex flex-col gap-2">
          <p class="text-small text-fg">
            {{
              status.distribution === 'standalone'
                ? t('about.updates.reinstall.standalone')
                : t(`about.updates.reinstall.${reasonKey(status.offerReason, 'noLauncher')}`)
            }}
          </p>
          <DsCodeBlock
            v-if="status.distribution !== 'standalone'"
            :code="npmCommand"
            :copy-label="t('about.updates.copy')"
          />
        </div>
        <p v-else-if="status.offer === 'notice'" class="text-small text-fg-muted">
          {{ t('about.updates.notice') }}
        </p>
      </template>

      <DsSwitch
        v-if="admin"
        v-model="auto"
        :label="t('about.updates.auto')"
        :hint="t('about.updates.autoHint')"
        data-updates-auto
      />
    </div>

    <UpdateDialog v-if="latest" :open="dialogOpen" :version="latest.version" @close="dialogOpen = false" />
  </section>
</template>
