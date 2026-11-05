<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  ChevronDown,
  Code,
  Copy,
  Gauge,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Star,
} from 'lucide-vue-next'
import DsButton from '@/ds/DsButton.vue'
import DsCodeBlock from '@/ds/DsCodeBlock.vue'
import DsTooltip from '@/ds/DsTooltip.vue'
import type { FindQuery } from './queryBuild'
import { findCommand, queryParts } from './shellCommand'

/**
 * UI redesign R1 revision 2 §4.3: the structured query panel — the query the results come from, part
 * by part, with the words it was asked in when the assistant wrote it.
 */
const props = defineProps<{ query: FindQuery; coll: string; intent: string | null }>()
const emit = defineEmits<{
  edit: []
  explain: []
  code: []
  askAgain: [prompt: string]
  /** W1 (completion §2): run the query in use again, or save it as a favourite. */
  run: []
  save: []
}>()
const { t } = useI18n()

const parts = computed(() => queryParts(props.query))
const detailed = ref(false)
const detailParts = computed(() => queryParts(props.query, 2))
const copied = ref(false)
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(findCommand(props.coll, props.query))
    copied.value = true
    setTimeout(() => (copied.value = false), 1200)
  } catch {
    // the clipboard was refused; the parts stay selectable
  }
}
const iconButton =
  'grid size-7 cursor-pointer place-items-center rounded-md text-fg-subtle transition-colors duration-120 hover:bg-muted hover:text-fg'
</script>

<template>
  <section
    data-query-panel
    :aria-label="t('query.panel.label')"
    class="mx-4 mb-2 rounded-xl border border-line bg-subtle/50 text-small"
  >
    <!-- W1 review (minor 12): on a phone the actions go under the query, which keeps the width. -->
    <div
      data-query-panel-row
      class="flex gap-2 px-3 py-1.5 max-sm:flex-col max-sm:items-stretch"
      :class="detailed || intent ? 'items-start' : 'items-center'"
    >
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <p v-if="intent" class="flex min-w-0 items-center gap-1.5 text-fg">
          <Sparkles class="size-3.5 shrink-0 text-accent-fg" aria-hidden="true" />
          <span class="sr-only">{{ t('query.panel.intent') }}</span>
          <span class="line-clamp-2 font-medium">{{ intent }}</span>
        </p>
        <dl v-if="!detailed" class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <div
            v-for="p in parts"
            :key="p.part"
            :data-query-part="p.part"
            class="flex min-w-0 items-baseline gap-1.5"
          >
            <dt class="shrink-0 text-caption font-semibold tracking-wide text-fg-subtle uppercase">
              {{ t(`query.panel.parts.${p.part}`) }}
            </dt>
            <dd class="max-w-[28rem] truncate font-mono text-[12px] text-fg" :title="p.text">{{ p.text }}</dd>
          </div>
        </dl>
        <div v-else class="grid gap-2 sm:grid-cols-2">
          <div
            v-for="p in detailParts"
            :key="p.part"
            :data-query-part="p.part"
            class="flex min-w-0 flex-col gap-1"
          >
            <span class="text-caption font-semibold tracking-wide text-fg-subtle uppercase">{{
              t(`query.panel.parts.${p.part}`)
            }}</span>
            <DsCodeBlock
              :code="p.text"
              :label="t(`query.panel.parts.${p.part}`)"
              :copy-label="t('query.panel.copyPart', { part: t(`query.panel.parts.${p.part}`) })"
            />
          </div>
        </div>
      </div>
      <div data-query-panel-actions class="flex shrink-0 flex-wrap items-center gap-0.5 max-sm:justify-end">
        <DsTooltip v-if="intent" :text="t('query.panel.askAgain')">
          <button
            type="button"
            :class="iconButton"
            :aria-label="t('query.panel.askAgain')"
            @click="emit('askAgain', intent)"
          >
            <RefreshCw class="size-3.5" aria-hidden="true" />
          </button>
        </DsTooltip>
        <DsTooltip :text="t('query.panel.edit')">
          <button type="button" :class="iconButton" :aria-label="t('query.panel.edit')" @click="emit('edit')">
            <Pencil class="size-3.5" aria-hidden="true" />
          </button>
        </DsTooltip>
        <DsTooltip :text="t('explain.whySlow')">
          <button
            type="button"
            :class="iconButton"
            :aria-label="t('explain.whySlow')"
            @click="emit('explain')"
          >
            <Gauge class="size-3.5" aria-hidden="true" />
          </button>
        </DsTooltip>
        <DsTooltip :text="t('aggregation.export.title')">
          <button
            type="button"
            :class="iconButton"
            :aria-label="t('aggregation.export.title')"
            data-query-code
            @click="emit('code')"
          >
            <Code class="size-3.5" aria-hidden="true" />
          </button>
        </DsTooltip>
        <DsTooltip :text="t('query.panel.copy')">
          <button type="button" :class="iconButton" :aria-label="t('query.panel.copy')" @click="copy">
            <component :is="copied ? Check : Copy" class="size-3.5" aria-hidden="true" />
          </button>
        </DsTooltip>
        <DsTooltip :text="t('explorer.panel.save')">
          <button
            type="button"
            :class="iconButton"
            :aria-label="t('explorer.panel.save')"
            @click="emit('save')"
          >
            <Star class="size-3.5" aria-hidden="true" />
          </button>
        </DsTooltip>
        <DsTooltip :text="detailed ? t('query.panel.less') : t('query.panel.more')">
          <button
            type="button"
            :class="iconButton"
            :aria-label="detailed ? t('query.panel.less') : t('query.panel.more')"
            :aria-expanded="detailed"
            @click="detailed = !detailed"
          >
            <ChevronDown
              class="size-3.5 transition-transform duration-160"
              :class="detailed ? 'rotate-180' : ''"
              aria-hidden="true"
            />
          </button>
        </DsTooltip>
        <DsButton
          size="sm"
          :icon="Play"
          class="ml-1"
          :title="t('explorer.panel.runHint')"
          @click="emit('run')"
        >
          {{ t('explorer.panel.run') }}
        </DsButton>
      </div>
    </div>
  </section>
</template>
