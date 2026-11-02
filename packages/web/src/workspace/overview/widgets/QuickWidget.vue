<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import DsKbd from '@/ds/DsKbd.vue'
import { useQuickLinks } from '../quickLinks'
import WidgetFrame from './WidgetFrame.vue'

/** The Overview's quick actions, as a widget (user review 2026-10-09). */
const { t } = useI18n()
const links = useQuickLinks()
</script>

<template>
  <WidgetFrame :title="t('home.actions')">
    <ul class="-mx-2 flex flex-col">
      <li v-for="l in links" :key="l.id">
        <button
          type="button"
          class="group flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-120 hover:bg-subtle"
          @click="l.run()"
        >
          <span
            class="grid size-7 shrink-0 place-items-center rounded-md bg-subtle text-fg-muted ring-1 ring-line ring-inset group-hover:text-accent-fg"
          >
            <component :is="l.icon" class="size-3.5" aria-hidden="true" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-ui font-medium text-fg">{{ l.title }}</span>
            <span class="block truncate text-small text-fg-subtle">{{ l.body }}</span>
          </span>
          <span v-if="l.keys.length" class="flex shrink-0 gap-0.5" aria-hidden="true">
            <DsKbd v-for="k in l.keys" :key="k">{{ k }}</DsKbd>
          </span>
        </button>
      </li>
    </ul>
  </WidgetFrame>
</template>
