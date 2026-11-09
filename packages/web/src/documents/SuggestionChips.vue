<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { History, Plus, Sparkle } from 'lucide-vue-next'
import DsChip from '@/ds/DsChip.vue'
import { documentKeys, documentsApi, type CollectionTarget } from '@/api/documents'
import { libraryApi, libraryKeys } from '@/api/library'
import { useMaskedPath } from '@/masking/useMaskedPaths'
import { decodeValue } from './values'
import { filterSuggestions, recentSuggestions, type FilterSuggestion } from './suggestions'

/**
 * W1 (completion §2): conditions offered under the composer — those the user ran lately on the
 * collection (its query history) and those a small schema sample suggests (the Schema section's own
 * analysis, masked by the server: a hidden field comes without its values). Nothing is offered while
 * they load or when they fail: suggestions are a help, not a state.
 *
 * W1 review (minor 8): the sample takes a read slot and a $sample — on a view, its whole pipeline — so
 * it is never asked on a view, only once the browser is idle (or the bar is used), with a short time
 * limit.
 */
const SAMPLE = 100
const SAMPLE_MS = 5_000
const MAX = 6
const props = defineProps<{
  target: CollectionTarget
  filter: Record<string, unknown>
  isView: boolean
  /** The bar is being used: no need to wait for the browser to be idle. */
  wanted: boolean
}>()
const emit = defineEmits<{ add: [suggestion: FilterSuggestion] }>()
const { t } = useI18n()
const isMasked = useMaskedPath()

const asked = ref(false)
let idle: number | undefined
let timer: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  if (typeof requestIdleCallback === 'function')
    idle = requestIdleCallback(() => (asked.value = true), { timeout: 4_000 })
  else timer = setTimeout(() => (asked.value = true), 2_000)
})
onBeforeUnmount(() => {
  if (idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle)
  clearTimeout(timer)
})
watch(
  () => props.wanted,
  (wanted) => {
    if (wanted) asked.value = true
  },
  { immediate: true },
)
const enabled = computed(() => asked.value && !props.isView)

const sample = useQuery({
  queryKey: computed(() => documentKeys.schema(props.target, SAMPLE)),
  queryFn: ({ signal }) => documentsApi.schema(props.target, SAMPLE, signal, SAMPLE_MS),
  enabled,
  staleTime: 10 * 60_000,
  retry: false,
})
const where = computed(() => ({
  type: 'history' as const,
  db: props.target.db,
  coll: props.target.coll,
  limit: 20,
}))
const recent = useQuery({
  queryKey: computed(() => libraryKeys.search(props.target.connectionId, where.value)),
  queryFn: ({ signal }) => libraryApi.search(props.target.connectionId, where.value, signal),
  enabled,
  staleTime: 60_000,
  retry: false,
})
/** The fields the filter already names (at its top, and in a top-level $and). */
const named = computed(() => {
  const decoded = decodeValue(props.filter) as Record<string, unknown>
  const and = Array.isArray(decoded.$and) ? decoded.$and : []
  return [
    ...Object.keys(decoded),
    ...and.flatMap((m) => (m && typeof m === 'object' ? Object.keys(m as object) : [])),
  ]
})
const offered = computed(() => {
  const lately = recentSuggestions(recent.data.value?.items ?? [], isMasked.value, named.value).map((s) => ({
    ...s,
    recent: true,
  }))
  const sampled = sample.data.value ? filterSuggestions(sample.data.value, isMasked.value, named.value) : []
  const seen = new Set(lately.map((s) => s.label))
  return [
    ...lately,
    ...sampled.filter((s) => !seen.has(s.label)).map((s) => ({ ...s, recent: false })),
  ].slice(0, MAX)
})
</script>

<template>
  <!-- W1 review (minor 12): the chips wrap on a narrow screen rather than scroll out of sight. User
       report 2026-11-07: a long one is cut short (whole in its title), not given a line of its own. -->
  <div
    v-if="offered.length"
    data-suggestions
    role="group"
    :aria-label="t('explorer.suggest.label')"
    class="-mt-1 flex flex-wrap items-center gap-1.5 px-4 pb-2"
  >
    <Sparkle class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
    <DsChip
      v-for="s in offered"
      :key="s.label"
      :label="s.label"
      :icon="s.recent ? History : Plus"
      class="max-w-80! font-mono text-[12px]"
      :title="s.recent ? `${s.label} · ${t('explorer.suggest.recent')}` : s.label"
      :aria-label="t('explorer.suggest.add', { condition: s.label })"
      @click="emit('add', s)"
    />
  </div>
</template>
