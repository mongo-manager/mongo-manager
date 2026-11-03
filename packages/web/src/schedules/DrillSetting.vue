<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ShieldCheck } from 'lucide-vue-next'
import DsCheckbox from '@/ds/DsCheckbox.vue'
import DsInput from '@/ds/DsInput.vue'
import type { ScheduleDraft } from './useScheduleDraft'

/**
 * W4.4: a restore drill every N runs — the run's backup restored into a scratch database of the
 * connection, its counts and contents checked against the backup, the database dropped. Off by
 * default: it reads and writes as much as the backup holds.
 */
const draft = defineModel<ScheduleDraft>('draft', { required: true })
const { t } = useI18n()
const text = ref(String(draft.value.drillEvery))
const parsed = computed(() => {
  const n = Number(text.value)
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : null
})
watch(parsed, (n) => {
  if (n !== null) draft.value.drillEvery = n
})
watch(
  () => draft.value.drillEvery,
  (n) => {
    if (parsed.value !== n) text.value = String(n)
  },
)
defineExpose({ valid: computed(() => !draft.value.drillOn || parsed.value !== null) })
</script>

<template>
  <section class="flex flex-col gap-3 rounded-xl border border-line p-4" data-test="drill-setting">
    <h3 class="flex items-center gap-2 text-ui font-medium text-fg">
      <ShieldCheck class="size-4 text-accent-fg" aria-hidden="true" />{{ t('schedules.drill.title') }}
    </h3>
    <DsCheckbox
      v-model="draft.drillOn"
      :label="t('schedules.drill.toggle')"
      :hint="t('schedules.drill.help')"
    />
    <DsInput
      v-if="draft.drillOn"
      v-model="text"
      type="number"
      class="w-48"
      :label="t('schedules.drill.every')"
      :error="parsed === null ? t('schedules.drill.range') : undefined"
    />
  </section>
</template>
