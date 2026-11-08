<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts" generic="S extends string">
import { useI18n } from 'vue-i18n'
import { Check } from 'lucide-vue-next'

/**
 * User request 2026-10-12: the SQL page's import and export as inner pages, one step at a time — a
 * file, its tables, the options, then the job followed on its own page — never one long page. The
 * steps passed can be gone back to; those ahead, or all once the job runs, cannot.
 */
const props = defineProps<{
  label: string
  steps: ReadonlyArray<{ id: S; label: string }>
  current: S
  /** The steps one may go to now (the ones passed, while the form may still change). */
  reachable: ReadonlyArray<S>
}>()
const emit = defineEmits<{ go: [step: S] }>()
const { t } = useI18n()
const index = (id: S) => props.steps.findIndex((s) => s.id === id)
</script>

<template>
  <nav :aria-label="label" data-transfer-steps>
    <ol class="flex flex-wrap items-center gap-x-2 gap-y-2">
      <li v-for="(step, i) in steps" :key="step.id" class="flex items-center gap-2">
        <span v-if="i > 0" class="h-px w-6 bg-line-strong max-sm:w-3" aria-hidden="true" />
        <!-- The step in sight is said as current, never as a button one cannot press (review M7). -->
        <component
          :is="step.id === current ? 'span' : 'button'"
          :type="step.id === current ? undefined : 'button'"
          class="group inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-small font-medium transition-colors duration-120 enabled:cursor-pointer enabled:hover:bg-subtle disabled:cursor-default"
          :class="
            step.id === current
              ? 'text-fg'
              : index(step.id) < index(current)
                ? 'text-fg-muted'
                : 'text-fg-subtle'
          "
          :aria-current="step.id === current ? 'step' : undefined"
          :disabled="step.id === current ? undefined : !reachable.includes(step.id)"
          :data-transfer-step="step.id"
          @click="step.id !== current && emit('go', step.id)"
        >
          <span
            class="grid size-6 shrink-0 place-items-center rounded-full text-caption font-semibold tabular-nums"
            :class="
              step.id === current
                ? 'bg-accent text-on-accent'
                : index(step.id) < index(current)
                  ? 'bg-accent-soft text-accent-fg'
                  : 'bg-subtle text-fg-subtle ring-1 ring-line ring-inset'
            "
            aria-hidden="true"
          >
            <Check v-if="index(step.id) < index(current)" class="size-3.5" />
            <template v-else>{{ i + 1 }}</template>
          </span>
          <span :class="step.id === current ? '' : 'max-sm:sr-only'">{{ step.label }}</span>
          <span class="sr-only"
            >, {{ t('sqlTransfer.steps.of', { n: i + 1, total: steps.length })
            }}<template v-if="index(step.id) < index(current)"
              >, {{ t('sqlTransfer.steps.done') }}</template
            ></span
          >
        </component>
      </li>
    </ol>
  </nav>
</template>
