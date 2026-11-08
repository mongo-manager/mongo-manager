<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Filter } from 'lucide-vue-next'
import { OPERATION_KINDS, type OperationKind, type OperationsQuery } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsChip from '@/ds/DsChip.vue'
import DsInput from '@/ds/DsInput.vue'
import NamespaceNameInput from '@/connections/NamespaceNameInput.vue'
/**
 * Phase 3b spec §4: the operation list's filter. What the user types stays here until Apply;
 * the server validates the values and builds the MongoDB filter itself. UI redesign R3 §4: on the
 * kit — fields, the kinds as toggle chips, the flags as checkboxes.
 */
/** User report 2026-10-30: the connection whose names the namespace field offers. */
defineProps<{ connectionId?: string }>()
const model = defineModel<OperationsQuery>({ required: true })
const { t } = useI18n()
const kindsId = useId()

const ns = ref('')
const kinds = ref<OperationKind[]>([])
const minSecs = ref('')
const waitingForLock = ref(false)
const idle = ref(false)
const own = ref(false)
watch(
  model,
  (m) => {
    ns.value = m.ns ?? ''
    kinds.value = [...(m.op ?? [])]
    minSecs.value = m.minSecs === undefined ? '' : String(m.minSecs)
    waitingForLock.value = m.waitingForLock ?? false
    idle.value = m.idle ?? false
    own.value = m.own ?? false
  },
  { immediate: true },
)
const minimum = computed(() => (minSecs.value.trim() === '' ? NaN : Number(minSecs.value)))

function toggle(k: OperationKind): void {
  kinds.value = kinds.value.includes(k) ? kinds.value.filter((x) => x !== k) : [...kinds.value, k]
}

function apply(): void {
  const next: OperationsQuery = {}
  if (ns.value.trim()) next.ns = ns.value.trim()
  if (kinds.value.length > 0) next.op = OPERATION_KINDS.filter((k) => kinds.value.includes(k))
  if (Number.isFinite(minimum.value) && minimum.value > 0) next.minSecs = minimum.value
  if (waitingForLock.value) next.waitingForLock = true
  if (idle.value) next.idle = true
  if (own.value) next.own = true
  model.value = next
}
</script>

<template>
  <form class="flex flex-col gap-3 rounded-lg bg-subtle p-3" data-ops-filter @submit.prevent="apply">
    <div class="flex flex-wrap items-end gap-3">
      <NamespaceNameInput
        v-model="ns"
        kind="namespace"
        :connection-id="connectionId"
        class="w-full max-w-64 min-w-0 sm:w-64"
        size="sm"
        mono
        :label="t('operationsFilter.ns')"
        maxlength="255"
        autocomplete="off"
        spellcheck="false"
        data-ops-ns
      />
      <DsInput
        v-model="minSecs"
        class="w-28"
        size="sm"
        type="number"
        min="0"
        max="86400"
        inputmode="numeric"
        :label="t('operationsFilter.minSecs')"
        data-ops-min
      />
      <div class="flex min-w-0 flex-col gap-1.5">
        <span :id="kindsId" class="text-small font-medium text-fg-muted">{{
          t('operationsFilter.kinds')
        }}</span>
        <div role="group" :aria-labelledby="kindsId" class="flex flex-wrap gap-1.5">
          <DsChip
            v-for="k in OPERATION_KINDS"
            :key="k"
            :label="k"
            :pressed="kinds.includes(k)"
            :data-ops-kind="k"
            @click="toggle(k)"
          />
        </div>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
      <DsCheckbox v-model="waitingForLock" :label="t('operationsFilter.waitingForLock')" />
      <DsCheckbox v-model="idle" :label="t('operationsFilter.idle')" />
      <DsCheckbox v-model="own" :label="t('operationsFilter.own')" />
      <DsButton type="submit" size="sm" variant="secondary" :icon="Filter" class="ml-auto">
        {{ t('operationsFilter.apply') }}
      </DsButton>
    </div>
  </form>
</template>
