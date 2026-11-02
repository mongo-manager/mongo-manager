<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { Preset, PresetInput } from '@mongo-manager/shared/browser'
import { transferApi, transferKeys } from '@/api/transfer'
import { describeError } from '@/api/errors'
import { useToastStore } from '@/stores/toasts'
import DsSelect from '@/ds/DsSelect.vue'
import DsInput from '@/ds/DsInput.vue'
import DsButton from '@/ds/DsButton.vue'

/** Phase 3d-1 spec §4.4: load, save and delete named settings (sealed on the server). */
const props = defineProps<{
  kind: 'import' | 'export' | 'copy'
  namespace: string
  /** The settings as they are now, to save. */
  current: () => PresetInput['body']
}>()
const emit = defineEmits<{ apply: [body: Preset['body']] }>()
const { t } = useI18n()
const toasts = useToastStore()
const queryClient = useQueryClient()
const presets = useQuery({
  queryKey: computed(() => transferKeys.presets(props.kind)),
  queryFn: () => transferApi.presets(props.kind),
})
// The ones saved for this collection come first; the others still apply here.
const list = computed(() =>
  [...(presets.data.value?.presets ?? [])].sort(
    (a, b) => Number(b.namespace === props.namespace) - Number(a.namespace === props.namespace),
  ),
)
const chosen = ref('')
const name = ref('')

function apply(): void {
  const preset = list.value.find((p) => p.id === chosen.value)
  if (preset) emit('apply', preset.body)
}

async function save(): Promise<void> {
  const trimmed = name.value.trim()
  if (!trimmed) return
  const existing = list.value.find((p) => p.name === trimmed)
  try {
    await transferApi.savePreset(
      { kind: props.kind, name: trimmed, namespace: props.namespace, body: props.current() },
      existing?.id,
    )
    name.value = ''
    await queryClient.invalidateQueries({ queryKey: transferKeys.presets(props.kind) })
    toasts.push({ kind: 'success', message: t('dataTransfer.presets.saved', { name: trimmed }) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

async function remove(): Promise<void> {
  const preset = list.value.find((p) => p.id === chosen.value)
  if (!preset) return
  try {
    await transferApi.deletePreset(preset.id)
    chosen.value = ''
    await queryClient.invalidateQueries({ queryKey: transferKeys.presets(props.kind) })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  }
}

const options = computed(() => [
  { value: '', label: t('dataTransfer.presets.choose') },
  ...list.value.map((p) => ({ value: p.id, label: p.name })),
])
</script>

<template>
  <fieldset class="flex flex-wrap items-end gap-2 rounded-lg border border-line p-2">
    <legend class="px-1 text-small text-fg-subtle">{{ t('dataTransfer.presets.title') }}</legend>
    <DsSelect
      v-model="chosen"
      :label="t('dataTransfer.presets.load')"
      hide-label
      :options="options"
      @update:model-value="apply"
    />
    <button
      v-if="chosen"
      type="button"
      class="cursor-pointer text-small text-danger hover:underline"
      @click="remove"
    >
      {{ t('dataTransfer.presets.delete') }}
    </button>
    <DsInput
      v-model="name"
      :label="t('dataTransfer.presets.name')"
      hide-label
      :placeholder="t('dataTransfer.presets.name')"
      maxlength="120"
    />
    <DsButton :disabled="!name.trim()" @click="save">{{ t('dataTransfer.presets.save') }}</DsButton>
  </fieldset>
</template>
