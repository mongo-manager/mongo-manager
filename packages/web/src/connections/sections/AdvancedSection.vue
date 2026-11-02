<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, X } from 'lucide-vue-next'
import { EXTRA_URI_OPTIONS, READ_PREFERENCES, type ExtraUriOption } from '@mongo-manager/shared/browser'
import DsInput from '@/ds/DsInput.vue'
import DsSelect from '@/ds/DsSelect.vue'
import DsButton from '@/ds/DsButton.vue'
import { useConnectionForm } from '../formContext'

const { t } = useI18n()
const { form, errorFor } = useConnectionForm()

const readPreferences = computed(() => [
  { value: '' as const, label: t('connection.readPreferenceDefault') },
  ...READ_PREFERENCES.map((p) => ({ value: p, label: p })),
])

/** Each extra URI option can be set once. */
function optionChoices(current: ExtraUriOption | ''): Array<{ value: ExtraUriOption | ''; label: string }> {
  const used = new Set(form.options.map((o) => o.key))
  return [
    { value: '', label: '—' },
    ...EXTRA_URI_OPTIONS.filter((k) => k === current || !used.has(k)).map((k) => ({ value: k, label: k })),
  ]
}
</script>

<template>
  <DsSelect
    v-model="form.readPreference"
    :label="t('connection.readPreference')"
    :options="readPreferences"
    :error="errorFor('readPreference')"
  />
  <DsInput
    v-model="form.appName"
    :label="t('connection.appName')"
    :error="errorFor('appName')"
    autocomplete="off"
  />
  <div class="grid gap-4 sm:grid-cols-2">
    <DsInput
      v-model="form.connectTimeoutMS"
      :label="t('connection.connectTimeoutMS')"
      :error="errorFor('connectTimeoutMS')"
      inputmode="numeric"
      autocomplete="off"
    />
    <DsInput
      v-model="form.serverSelectionTimeoutMS"
      :label="t('connection.serverSelectionTimeoutMS')"
      :error="errorFor('serverSelectionTimeoutMS')"
      inputmode="numeric"
      autocomplete="off"
    />
  </div>
  <fieldset class="flex flex-col gap-2">
    <legend class="mb-1.5 text-small font-medium text-fg">
      {{ t('connection.options') }}
    </legend>
    <div v-for="(o, i) in form.options" :key="i" class="flex items-start gap-2">
      <DsSelect
        v-model="o.key"
        class="w-56"
        :label="t('connection.optionKey')"
        :options="optionChoices(o.key)"
      />
      <DsInput
        v-model="o.value"
        class="flex-1"
        :label="t('connection.optionValue')"
        :error="o.key ? errorFor(`options.${o.key}`) : undefined"
        autocomplete="off"
        mono
      />
      <button
        type="button"
        class="mt-7 grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-fg-subtle transition-colors duration-120 hover:bg-subtle hover:text-fg"
        :aria-label="t('connection.removeOption', { name: o.key || i + 1 })"
        @click="form.options.splice(i, 1)"
      >
        <X class="size-4" aria-hidden="true" />
      </button>
    </div>
    <DsButton size="sm" variant="ghost" class="self-start" @click="form.options.push({ key: '', value: '' })">
      <Plus class="size-4" aria-hidden="true" />
      {{ t('connection.addOption') }}
    </DsButton>
  </fieldset>
</template>
