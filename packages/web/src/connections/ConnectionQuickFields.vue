<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Star } from 'lucide-vue-next'
import { CONNECTION_COLORS } from '@mongo-manager/shared/browser'
import DsInput from '@/ds/DsInput.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import { COLOR_CLASSES } from './colors'
import { useConnectionForm } from './formContext'
import { formTarget } from './connectionString'
import ConnectionStringField from './ConnectionStringField.vue'

/**
 * User request 2026-10-16: "too many tabs; connecting to a database cannot take this long". What a
 * connection needs at the head of the form — its string, its name and its colour; the rest waits
 * under Advanced options.
 */
const { t } = useI18n()
const { form, errorFor, focusName, connectionString, openSection } = useConnectionForm()
// Where an edited or duplicated connection points, while no new string is typed (review M1).
const target = computed(() => (connectionString.text.value.trim() ? '' : formTarget(form, t)))
const colors = ['', ...CONNECTION_COLORS] as const
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1">
      <ConnectionStringField />
      <p v-if="target" data-connection-target class="text-small break-words text-fg-muted">
        {{ t('connection.target', { summary: target }) }}
      </p>
      <button
        type="button"
        data-host-instead
        class="self-start cursor-pointer rounded text-small text-accent-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        @click="openSection('server', 'host-0')"
      >
        {{ t('connection.hostInstead') }}
      </button>
    </div>
    <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div class="flex min-w-0 items-end gap-1">
        <DsInput
          v-model="form.name"
          :label="t('connection.name')"
          :error="errorFor('name')"
          data-connection-field="name"
          :autofocus="focusName || undefined"
          class="min-w-0 flex-1"
          autocomplete="off"
          required
        />
        <DsIconButton
          :icon="Star"
          :label="t('connection.favorite')"
          :active="form.favorite"
          :aria-pressed="form.favorite ? 'true' : 'false'"
          data-favorite-toggle
          class="mb-0"
          :class="form.favorite ? '[&_svg]:fill-current' : ''"
          @click="form.favorite = !form.favorite"
        />
      </div>
      <fieldset>
        <legend class="mb-1.5 text-small font-medium text-fg">{{ t('connection.color') }}</legend>
        <div class="flex min-h-8 flex-wrap items-center gap-1.5">
          <label
            v-for="c in colors"
            :key="c || 'none'"
            class="cursor-pointer"
            :title="t(`connection.colors.${c || 'none'}`)"
          >
            <input
              v-model="form.color"
              type="radio"
              name="connection-color"
              :value="c"
              class="peer sr-only"
            />
            <span
              class="block size-6 rounded-full sm:size-5 ring-2 ring-transparent ring-offset-2 ring-offset-raised transition-shadow duration-120 peer-checked:ring-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-focus"
              :class="c ? COLOR_CLASSES[c] : 'border border-dashed border-line-strong'"
              aria-hidden="true"
            />
            <span class="sr-only">{{ t(`connection.colors.${c || 'none'}`) }}</span>
          </label>
        </div>
      </fieldset>
    </div>
  </div>
</template>
