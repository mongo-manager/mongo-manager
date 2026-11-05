<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { deserializeValue, type FieldChange } from '@mongo-manager/shared/browser'
import DiffList from '@/documents/DiffList.vue'
import { toShell } from '@/documents/values'
import { samplesOf, type SampleGroup, type SampleSet } from './compareSamples'

/**
 * Phase 3d-2 spec §3.2 (W4.6: shared with a live sync's verification): one group's samples — a
 * document on one side, or the field changes from the target to the source — as the compare view
 * shows them.
 */
const props = defineProps<{ sets: SampleSet[]; group: SampleGroup; showColl?: boolean }>()
const { t } = useI18n()

/** Final review I4: a value that does not decode is shown as its EJSON text, never breaks the tab. */
const decode = (v: unknown) => {
  try {
    return deserializeValue(v)
  } catch {
    return JSON.stringify(v)
  }
}
const changes = (list: Array<{ path: string; before?: unknown; after?: unknown }>): FieldChange[] =>
  list.map((c) => ({
    path: c.path,
    ...('before' in c ? { before: decode(c.before) } : {}),
    ...('after' in c ? { after: decode(c.after) } : {}),
  }))
const shown = computed(() => samplesOf(props.sets, props.group))
</script>

<template>
  <p v-if="!shown.length" class="text-ui text-fg-subtle">
    {{ t('dataTransfer.compare.noSamples') }}
  </p>
  <ul v-else class="flex flex-col gap-3">
    <li
      v-for="(s, i) in shown"
      :key="i"
      class="flex flex-col gap-1.5 rounded-md border border-line bg-subtle/40 p-3"
      data-sample
    >
      <p class="font-mono text-small text-fg-subtle">
        <template v-if="showColl">{{ s.coll }} · </template>
        {{ `_id: ${toShell(decode(s.id), 0)}` }}
      </p>
      <template v-if="s.kind === 'diff'">
        <p v-if="s.sample.orderOnly" class="text-small text-fg-muted">
          {{ t('dataTransfer.compare.orderOnly') }}
        </p>
        <DiffList v-else :changes="changes(s.sample.changes)" />
        <p v-if="s.sample.more" class="text-small text-fg-subtle">
          {{ t('dataTransfer.compare.more') }}
        </p>
      </template>
      <pre v-else class="max-h-48 overflow-auto font-mono text-small text-fg">{{
        toShell(decode(s.sample.doc), 2)
      }}</pre>
    </li>
  </ul>
</template>
