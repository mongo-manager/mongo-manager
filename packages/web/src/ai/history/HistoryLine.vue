<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, GitCommitVertical, Users } from 'lucide-vue-next'
import type { AiHistoryItem } from '@mongo-manager/shared/browser'
import JobStatusIcon from '@/jobs/JobStatusIcon.vue'
import { clock } from '@/jobs/present'
import { ACTION_ICONS, useHistoryWords } from './historyWords'
import NamespaceChip from './NamespaceChip.vue'

/**
 * User review 2026-10-09: one AI request in a line — its outcome, what kind, the words asked, where,
 * which model, the tokens it spent, its cost and when.
 */
const props = defineProps<{ item: AiHistoryItem; now: number }>()
defineEmits<{ select: [item: AiHistoryItem] }>()
const w = useHistoryWords()
/** User review 2026-10-09: a chain's line says the chain — its latest outcome, its sums, its latest time. */
const shown = computed(() => {
  const c = props.item.chain
  return c
    ? {
        item: { ...props.item, outcome: c.outcome },
        usage: c.usage,
        at: c.at,
        cost: c.cost.length ? w.costs(c.cost) : null,
      }
    : {
        item: props.item,
        usage: props.item.usage,
        at: props.item.at,
        cost: props.item.cost ? w.money(props.item.cost) : null,
      }
})
</script>

<template>
  <li :data-request="item.id" :data-thread="item.thread ?? undefined">
    <button
      type="button"
      class="group flex w-full cursor-pointer items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-120 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus hover:bg-subtle"
      @click="$emit('select', item)"
    >
      <JobStatusIcon class="mt-0.5" :status="w.status(shown.item)" :label="w.outcome(shown.item)" />
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 items-center gap-2 text-ui text-fg">
          <component
            :is="ACTION_ICONS[item.action]"
            class="size-3.5 shrink-0 text-fg-subtle"
            aria-hidden="true"
          />
          <span v-if="item.preview" class="min-w-0 truncate" :title="item.preview">{{ item.preview }}</span>
          <span v-else class="min-w-0 truncate text-fg-subtle italic">{{ w.t('aiHistory.notKept') }}</span>
          <span
            v-if="item.chain"
            data-chain-badge
            class="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 py-px text-small font-medium text-accent-fg"
          >
            <GitCommitVertical class="size-3" aria-hidden="true" />
            {{
              item.action === 'chat'
                ? w.t('aiHistory.chat.turns', { n: item.chain.steps }, item.chain.steps)
                : w.t('aiHistory.refinements', { n: item.chain.steps - 1 }, item.chain.steps - 1)
            }}
          </span>
          <span
            v-if="item.shared || item.mine === false"
            data-shared-badge
            class="inline-flex shrink-0 items-center gap-1 rounded-full bg-info-soft px-1.5 py-px text-small font-medium text-info"
          >
            <Users class="size-3" aria-hidden="true" />
            {{
              item.mine === false
                ? w.t('aiHistory.share.byShort', { name: item.sharedBy ?? '' })
                : item.action === 'chat' && item.chain
                  ? w.t('aiHistory.chat.turnShared')
                  : w.t('aiHistory.share.badge')
            }}
          </span>
        </span>
        <span class="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-small text-fg-subtle">
          <NamespaceChip
            v-if="item.namespace"
            :connection-id="item.connectionId"
            :namespace="item.namespace"
          />
          <span>{{ w.action(item.action) }}</span>
          <span aria-hidden="true">·</span>
          <span class="truncate">{{ item.provider.model }}</span>
        </span>
        <span
          v-if="shown.item.outcome !== 'ok'"
          class="mt-0.5 block truncate text-small"
          :class="w.answered(shown.item) ? 'text-fg-muted' : 'text-danger'"
        >
          {{ w.outcome(shown.item) }}
        </span>
      </span>
      <span class="mt-0.5 flex shrink-0 flex-col items-end gap-0.5 text-small whitespace-nowrap tabular-nums">
        <span
          class="text-fg-muted"
          :title="
            w.t('aiHistory.tokensTitle', {
              input: w.exact(shown.usage.input),
              output: w.exact(shown.usage.output),
            })
          "
        >
          {{ w.tokens(shown.usage.input) }} → {{ w.tokens(shown.usage.output) }}
        </span>
        <span class="text-fg-subtle">
          <template v-if="shown.cost">{{ shown.cost }} · </template>{{ clock(shown.at, now, w.locale.value) }}
        </span>
      </span>
      <ChevronRight
        class="mt-1 size-4 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden="true"
      />
    </button>
  </li>
</template>
