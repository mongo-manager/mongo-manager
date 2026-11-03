<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Lightbulb, Plus, RotateCw, Sparkles } from 'lucide-vue-next'
import { objectKey } from '@mongo-manager/shared/browser'
import { serverApi, serverKeys, type IndexAdvice } from '@/api/server'
import type { CollectionTarget } from '@/api/documents'
import { describeError } from '@/api/errors'
import DsBadge from '@/ds/DsBadge.vue'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCard from '@/ds/DsCard.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsEmptyState from '@/ds/DsEmptyState.vue'
import NamespaceNameInput from '@/connections/NamespaceNameInput.vue'
import type { DsColumn } from '@/ds/table'
import { formatBytes } from '@/format'
const IndexCreateDialog = defineAsyncComponent(() => import('@/indexes/IndexCreateDialog.vue'))

/**
 * Phase 3b spec §6a: index suggestions from a database's slow queries (the ESR rule, not already
 * served by an index), and indexes that may be unneeded. "Create index" opens the usual dialog with
 * the key filled in; nothing is built until the user confirms there. UI redesign R3 §4: a card with
 * its form on the kit and both lists as data tables.
 */
const props = defineProps<{ connectionId: string; canCreate: boolean }>()
const { t, locale } = useI18n()
const dbInput = ref('')
const db = ref('')
const advice = useQuery({
  queryKey: computed(() => serverKeys.indexAdvice(props.connectionId, db.value)),
  queryFn: () => serverApi.indexAdvice(props.connectionId, db.value),
  enabled: computed(() => db.value !== ''),
  retry: false,
})
const refused = computed(() => Object.keys(advice.data.value?.refused ?? {}))
const creating = ref<{ target: CollectionTarget; key: string } | null>(null)

type Suggestion = IndexAdvice['suggestions'][number]
type Unneeded = IndexAdvice['unneeded'][number]

/** The key as the dialog's shell text: names that are not identifiers are quoted. */
const keyText = (key: Suggestion['key']) =>
  `{ ${key.map(([field, dir]) => `${objectKey(field)}: ${dir}`).join(', ')} }`

function create(s: Suggestion): void {
  const dot = s.ns.indexOf('.')
  creating.value = {
    target: { connectionId: props.connectionId, db: s.ns.slice(0, dot), coll: s.ns.slice(dot + 1) },
    key: keyText(s.key),
  }
}
const suggestionKey = (s: Suggestion) => `${s.ns} ${keyText(s.key)}`
const columns = computed<DsColumn[]>(() => [
  { key: 'ns', label: t('indexAdvice.collection'), mono: true, width: '26%' },
  { key: 'key', label: t('indexAdvice.key'), mono: true, width: '30%' },
  { key: 'stats', label: t('indexAdvice.why'), hideBelow: 560 },
])
const unneededColumns = computed<DsColumn[]>(() => [
  { key: 'ns', label: t('indexAdvice.collection'), mono: true, width: '26%' },
  { key: 'name', label: t('indexAdvice.index'), mono: true, width: '24%' },
  { key: 'reason', label: t('indexAdvice.reason') },
  // Index advice gaps (2026-10-27): what keeping it costs, and how much it is used.
  { key: 'size', label: t('indexAdvice.size'), align: 'right', width: '6.5rem', hideBelow: 560 },
  { key: 'ops', label: t('indexAdvice.ops'), align: 'right', width: '6.5rem', hideBelow: 700 },
])
const reasonText = (u: Unneeded) =>
  u.reason === 'prefix'
    ? t('indexAdvice.prefixOf', { of: u.of ?? '' })
    : u.reason === 'duplicate'
      ? t('indexAdvice.duplicateOf', { of: u.of ?? '' })
      : t('indexAdvice.unused')
const sizeText = (u: Unneeded) =>
  u.sizeBytes !== null
    ? formatBytes(u.sizeBytes, locale.value)
    : u.sizeHidden
      ? t('indexAdvice.sizeHidden')
      : '—'
const opsText = (u: Unneeded) => (u.ops === null ? '—' : new Intl.NumberFormat(locale.value).format(u.ops))
</script>

<template>
  <DsCard :title="t('indexAdvice.title')" data-index-advice>
    <div class="flex flex-col gap-3">
      <p class="max-w-3xl text-small text-fg-subtle">{{ t('indexAdvice.intro') }}</p>
      <form
        class="flex flex-wrap items-end gap-3 rounded-lg bg-subtle p-3"
        data-advice-form
        @submit.prevent="db = dbInput.trim()"
      >
        <!-- User report 2026-10-30: the connection's databases offered. -->
        <NamespaceNameInput
          v-model="dbInput"
          kind="database"
          :connection-id="connectionId"
          class="w-full max-w-56 min-w-0 sm:w-56"
          size="sm"
          mono
          maxlength="64"
          autocomplete="off"
          :label="t('indexAdvice.db')"
          data-advice-db
        />
        <DsButton
          type="submit"
          size="sm"
          :icon="Sparkles"
          :loading="advice.isFetching.value"
          :disabled="dbInput.trim() === ''"
        >
          {{ t('indexAdvice.analyse') }}
        </DsButton>
      </form>
      <DsCallout v-for="src in refused" :key="src" tone="warning" :data-advice-refused="src">
        {{ t(`indexAdvice.refused.${src}`) }}
      </DsCallout>
      <DsCallout v-if="advice.isError.value" tone="danger">
        {{ describeError(advice.error.value, t) }}
        <template #action>
          <DsButton size="sm" :icon="RotateCw" @click="advice.refetch()">{{ t('common.retry') }}</DsButton>
        </template>
      </DsCallout>
      <template v-else-if="advice.data.value">
        <DsCallout v-if="advice.data.value.skipped > 0" tone="info" data-advice-skipped>
          {{ t('indexAdvice.skipped', { count: advice.data.value.skipped }, advice.data.value.skipped) }}
        </DsCallout>
        <DsDataTable
          :label="t('indexAdvice.title')"
          :columns="columns"
          :rows="advice.data.value.suggestions"
          :row-key="suggestionKey"
          :actions-label="t('indexAdvice.create')"
          actions-width="9rem"
          actions-visible
        >
          <template #cell-ns="{ row: s }">
            <span :title="s.ns">{{ s.ns }}</span>
          </template>
          <template #cell-key="{ row: s }">
            <code class="text-fg" :title="keyText(s.key)">{{ keyText(s.key) }}</code>
          </template>
          <template #cell-stats="{ row: s }">
            <span
              class="text-small text-fg-muted"
              :title="t('indexAdvice.stats', { count: s.count, avg: s.avgMs, ratio: s.ratio ?? '?' })"
              >{{ t('indexAdvice.stats', { count: s.count, avg: s.avgMs, ratio: s.ratio ?? '?' }) }}</span
            >
          </template>
          <template v-if="canCreate" #actions="{ row: s }">
            <!-- Review of the Monitoring redesign (minor): the suggestion's own action, in words. -->
            <DsButton
              size="sm"
              variant="ghost"
              :icon="Plus"
              :aria-label="t('indexAdvice.createOn', { ns: s.ns })"
              data-advice-create
              @click="create(s)"
              >{{ t('indexAdvice.create') }}</DsButton
            >
          </template>
          <template #empty>
            <DsEmptyState :icon="Lightbulb" :title="t('indexAdvice.none')" />
          </template>
        </DsDataTable>
        <section v-if="advice.data.value.unneeded.length" class="flex min-w-0 flex-col gap-1.5">
          <h4 class="text-small font-semibold text-fg-muted">{{ t('indexAdvice.unneededTitle') }}</h4>
          <DsDataTable
            :label="t('indexAdvice.unneededTitle')"
            :columns="unneededColumns"
            :rows="advice.data.value.unneeded"
            :row-key="(u: Unneeded) => `${u.ns}.${u.name}`"
          >
            <template #cell-ns="{ row: u }">
              <span :title="u.ns">{{ u.ns }}</span>
            </template>
            <template #cell-name="{ row: u }">
              <span :title="u.name" :data-advice-unneeded="u.name">{{ u.name }}</span>
            </template>
            <template #cell-reason="{ row: u }">
              <DsBadge :tone="u.reason === 'unused' ? 'neutral' : 'info'">{{ reasonText(u) }}</DsBadge>
            </template>
            <template #cell-size="{ row: u }">
              <span class="tabular-nums" :class="u.sizeBytes === null ? 'text-fg-subtle' : ''">{{
                sizeText(u)
              }}</span>
            </template>
            <template #cell-ops="{ row: u }">
              <span class="tabular-nums">{{ opsText(u) }}</span>
            </template>
          </DsDataTable>
          <p v-if="advice.data.value.moreUnneeded" class="text-small text-fg-muted" data-advice-more>
            {{
              t(
                'indexAdvice.moreUnneeded',
                { count: advice.data.value.moreUnneeded },
                advice.data.value.moreUnneeded,
              )
            }}
          </p>
        </section>
      </template>
    </div>
    <IndexCreateDialog
      v-if="creating"
      :target="creating.target"
      :initial-key="creating.key"
      @close="creating = null"
    />
  </DsCard>
</template>
