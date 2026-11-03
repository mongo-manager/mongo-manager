<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { MessageSquare, RotateCw, Table, Trash2, Workflow } from 'lucide-vue-next'
import type { AiHistoryItem } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsSkeleton from '@/ds/DsSkeleton.vue'
import JobStatusIcon from '@/jobs/JobStatusIcon.vue'
import { aiHistoryApi, aiHistoryKeys } from '@/api/aiHistory'
import { describeError } from '@/api/errors'
import { useHistoryWords } from './historyWords'
import { useAssistantStore } from '@/ai/chat/store'
import RequestContent from './RequestContent.vue'
import RequestPlace from './RequestPlace.vue'
import ShareBar from './ShareBar.vue'
import { reopenableResult, useReopen, useRequestPlace } from './reopen'
import DsCallout from '@/ds/DsCallout.vue'

/**
 * User review 2026-10-09: a pipeline's first request and the changes asked of it after, as a page —
 * the chain's sums and its steps to choose from on one side, the chosen step (what was asked and
 * answered, its pipeline, tokens and cost) on the other; one scroll, nothing nested ("iç içe girdi").
 */
/** `shownId`: the step the URL names — marked at once, while it is read. */
const props = defineProps<{ item: AiHistoryItem; shownId?: string }>()
const emit = defineEmits<{
  removeStep: [step: AiHistoryItem]
  removeChain: [item: AiHistoryItem]
  /** A step chosen: the page (and its URL) shows that step. */
  choose: [id: string]
}>()
const w = useHistoryWords()
const reopenIn = useReopen()

/** A teammate's shared chain is read by its request (its chain id alone is not enough to know whose). */
const mine = computed(() => props.item.mine !== false)
const thread = useQuery({
  queryKey: computed(() =>
    mine.value ? aiHistoryKeys.thread(props.item.thread!) : aiHistoryKeys.chain(props.item.id),
  ),
  queryFn: () => (mine.value ? aiHistoryApi.thread(props.item.thread!) : aiHistoryApi.chain(props.item.id)),
})
const steps = computed(() => thread.data.value?.steps ?? [])
const chain = computed(() => props.item.chain)
/** The step shown: the one the page was opened on (its URL's), else the latest. */
const shownIndex = computed(() => {
  const at = steps.value.findIndex((s) => s.id === (props.shownId ?? props.item.id))
  return at === -1 ? steps.value.length - 1 : at
})
const shown = computed(() => steps.value[shownIndex.value] ?? null)
const shownSection = ref<HTMLElement | null>(null)
/** A step chosen far down the page: its words are brought into view, from their top. */
function choose(id: string): void {
  emit('choose', id)
  void nextTick(() => {
    const top = shownSection.value?.getBoundingClientRect().top
    if (top !== undefined && top < 0) shownSection.value!.scrollIntoView({ block: 'start' })
  })
}
// A step's pipeline opens only while its collection is there (user review 2026-10-09).
const place = useRequestPlace(() => props.item)
const shownResult = computed(() =>
  shown.value && place.openable.value ? reopenableResult(shown.value, shown.value.content) : null,
)
/** The latest step that wrote a pipeline (or a query), to open again. */
const latest = computed(() => {
  if (!place.openable.value) return null
  for (const s of [...steps.value].reverse()) {
    const result = reopenableResult(s, s.content)
    if (result) return { step: s, result }
  }
  return null
})
/**
 * User reports 2026-10-25: a chat is one entry — every turn of it shown at once, in order (its plain
 * turns and the agent's, the agent's steps with its), and the chat opened again in the assistant.
 */
const isChat = computed(() => props.item.action === 'chat')
// Review of the chat entry (nit): a page opened on a turn (a link, a search) brings it into view.
watch(
  () => [isChat.value, steps.value.length, props.shownId] as const,
  ([chat, n, id]) => {
    if (chat && n && id && id !== steps.value[0]?.id)
      void nextTick(() => document.getElementById(`chat-turn-${id}`)?.scrollIntoView({ block: 'start' }))
  },
  { immediate: true },
)
const assistant = useAssistantStore()
function openChat(): void {
  if (!props.item.chatId) return
  void assistant.openChat(props.item.chatId)
  assistant.show()
}
/** A turn chosen from the list: brought into view (the URL names it, as a step's does). */
function goTo(id: string): void {
  emit('choose', id)
  void nextTick(() => {
    document.getElementById(`chat-turn-${id}`)?.scrollIntoView({ block: 'start' })
    // Review of the chat entry (nit): the turn's heading takes the focus, as a page's does.
    document.getElementById(`chat-turn-${id}-title`)?.focus({ preventScroll: true })
  })
}
const label = (i: number) =>
  isChat.value
    ? w.t('aiHistory.chat.turn', { n: i + 1 })
    : i === 0
      ? w.t('aiHistory.chain.first')
      : w.t('aiHistory.chain.refinement', { n: i })
const day = (d: Date) => d.toLocaleDateString(w.locale.value, { dateStyle: 'medium' })
const time = (d: Date) => d.toLocaleTimeString(w.locale.value, { timeStyle: 'medium' })
/** From the first step to the latest: the day once when both fall on it, with seconds. */
const span = computed(() => {
  const from = new Date(steps.value[0]?.at ?? props.item.at)
  const to = new Date(chain.value?.at ?? props.item.at)
  return day(from) === day(to)
    ? w.t('aiHistory.chain.spanDay', { day: day(from), from: time(from), to: time(to) })
    : w.t('aiHistory.chain.span', { from: `${day(from)} ${time(from)}`, to: `${day(to)} ${time(to)}` })
})
const when = (ms: number) => `${day(new Date(ms))} ${time(new Date(ms))}`
const status = computed(() => ({ ...props.item, outcome: chain.value?.outcome ?? props.item.outcome }))
</script>

<template>
  <div class="flex flex-col gap-5" data-chain-details>
    <header class="flex flex-wrap items-start gap-3">
      <JobStatusIcon class="mt-1" :status="w.status(status)" :label="w.outcome(status)" />
      <div class="min-w-0 flex-1">
        <h2 tabindex="-1" class="flex items-center gap-2 text-title-l font-semibold text-fg outline-none">
          <component
            :is="isChat ? MessageSquare : Workflow"
            class="size-5 text-fg-subtle"
            aria-hidden="true"
          />
          {{ isChat ? w.t('aiHistory.chat.title') : w.t('aiHistory.chain.title') }}
        </h2>
        <p class="text-ui text-fg-muted">
          {{
            w.t(
              isChat ? 'aiHistory.chat.turns' : 'aiHistory.chain.steps',
              { n: chain?.steps ?? steps.length },
              chain?.steps ?? steps.length,
            )
          }}
        </p>
        <RequestPlace
          v-if="item.namespace && !isChat"
          class="mt-2"
          :connection-id="item.connectionId"
          :namespace="item.namespace"
        />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <DsButton
          v-if="isChat && mine && item.chatId"
          size="sm"
          variant="primary"
          :icon="MessageSquare"
          @click="openChat"
        >
          {{ w.t('aiHistory.openChat') }}
        </DsButton>
        <DsButton
          v-if="latest && !isChat"
          size="sm"
          variant="primary"
          :icon="Table"
          @click="reopenIn(latest.step, latest.result)"
        >
          {{ w.t('aiHistory.chain.reopenLatest') }}
        </DsButton>
        <DsButton v-if="mine" size="sm" variant="ghost" :icon="Trash2" @click="emit('removeChain', item)">
          {{ isChat ? w.t('aiHistory.chat.remove') : w.t('aiHistory.chain.remove') }}
        </DsButton>
      </div>
    </header>
    <ShareBar v-if="!isChat" :item="item" />

    <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside class="flex flex-col gap-4 lg:sticky lg:top-0">
        <dl v-if="chain" class="grid gap-y-3 rounded-xl border border-line bg-surface p-4 text-ui shadow-xs">
          <div>
            <dt class="text-small text-fg-subtle">{{ w.t('aiHistory.when') }}</dt>
            <dd data-chain-when class="text-fg tabular-nums">{{ span }} · {{ w.ms(chain.ms) }}</dd>
          </div>
          <div>
            <dt class="text-small text-fg-subtle">{{ w.t('aiHistory.tokens') }}</dt>
            <dd data-chain-tokens class="text-fg tabular-nums">
              {{
                w.t('aiHistory.tokensLine', {
                  input: w.exact(chain.usage.input),
                  output: w.exact(chain.usage.output),
                  total: w.exact(chain.usage.input + chain.usage.output),
                })
              }}
            </dd>
          </div>
          <div>
            <dt class="text-small text-fg-subtle">{{ w.t('aiHistory.cost') }}</dt>
            <dd data-chain-cost class="text-fg tabular-nums">{{ w.costs(chain.cost) }}</dd>
          </div>
        </dl>
        <nav :aria-label="w.t('aiHistory.chain.stepsLabel')">
          <ol role="list" class="flex flex-col gap-1.5">
            <li v-for="(s, i) in steps" :key="s.id">
              <button
                type="button"
                data-chain-step
                class="flex w-full cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors duration-120 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                :class="
                  i === shownIndex
                    ? 'border-accent bg-accent-soft'
                    : 'border-line bg-surface hover:border-line-strong hover:bg-subtle'
                "
                :aria-current="i === shownIndex ? 'step' : undefined"
                @click="isChat ? goTo(s.id) : choose(s.id)"
              >
                <span
                  class="grid size-6 shrink-0 place-items-center rounded-full text-small font-semibold tabular-nums"
                  :class="i === shownIndex ? 'bg-accent text-on-accent' : 'bg-subtle text-fg-muted'"
                  aria-hidden="true"
                  >{{ i + 1 }}</span
                >
                <span class="min-w-0 flex-1">
                  <span class="block text-small font-semibold text-fg-muted">{{ label(i) }}</span>
                  <span class="block truncate text-ui text-fg">{{
                    s.preview ?? w.t('aiHistory.notKept')
                  }}</span>
                  <span class="mt-0.5 block text-small text-fg-subtle tabular-nums">
                    {{ w.tokens(s.usage.input) }} → {{ w.tokens(s.usage.output) }}
                    <template v-if="s.cost"> · {{ w.money(s.cost) }}</template>
                  </span>
                </span>
                <JobStatusIcon
                  v-if="!w.answered(s)"
                  class="shrink-0"
                  :status="w.status(s)"
                  :label="w.outcome(s)"
                />
              </button>
            </li>
          </ol>
        </nav>
      </aside>

      <div
        v-if="thread.isPending.value"
        class="flex flex-col gap-2 py-2"
        role="status"
        :aria-label="w.t('aiHistory.loading')"
      >
        <DsSkeleton v-for="n in 3" :key="n" class="h-5" />
      </div>
      <DsCallout v-else-if="thread.isError.value" tone="danger">
        {{ describeError(thread.error.value, w.t) }}
        <template #action>
          <DsButton size="sm" :icon="RotateCw" @click="thread.refetch()">{{ w.t('common.retry') }}</DsButton>
        </template>
      </DsCallout>
      <div v-else-if="isChat" class="flex min-w-0 flex-col gap-8" data-chat-turns>
        <section
          v-for="(s, i) in steps"
          :id="`chat-turn-${s.id}`"
          :key="s.id"
          data-chat-turn
          :aria-labelledby="`chat-turn-${s.id}-title`"
          class="flex scroll-mt-4 flex-col gap-5"
        >
          <div class="flex flex-wrap items-start gap-3 border-b border-line pb-3">
            <div class="min-w-0 flex-1">
              <h3
                :id="`chat-turn-${s.id}-title`"
                tabindex="-1"
                class="text-title-s font-semibold text-fg outline-none"
              >
                {{ label(i) }}
              </h3>
              <RequestPlace
                v-if="s.namespace"
                class="mt-1"
                :connection-id="s.connectionId"
                :namespace="s.namespace"
              />
              <p class="text-small text-fg-subtle tabular-nums">
                {{ when(s.at) }} · {{ w.ms(s.ms) }} · {{ w.tokens(s.usage.input) }} →
                {{ w.tokens(s.usage.output) }}
                <template v-if="s.cost"> · {{ w.money(s.cost) }}</template>
              </p>
              <p v-if="!w.answered(s)" class="mt-1 text-small text-danger">{{ w.outcome(s) }}</p>
            </div>
            <DsButton v-if="mine" size="sm" variant="ghost" :icon="Trash2" @click="emit('removeStep', s)">
              {{ w.t('aiHistory.chat.removeTurn') }}
            </DsButton>
          </div>
          <!-- Review of the chat entry (I2): a turn is shared on its own, never the whole chat. -->
          <ShareBar :item="s" />
          <p v-if="!s.content" class="rounded-lg bg-subtle px-3 py-2 text-ui text-fg-muted">
            {{ w.t('aiHistory.notKeptLong') }}
          </p>
          <RequestContent v-else :content="s.content" />
        </section>
      </div>
      <section
        v-else-if="shown"
        ref="shownSection"
        data-chain-shown
        :aria-label="label(shownIndex)"
        class="flex min-w-0 flex-col gap-5"
      >
        <div class="flex flex-wrap items-start gap-3 border-b border-line pb-4">
          <div class="min-w-0 flex-1">
            <h3 class="text-title-s font-semibold text-fg">{{ label(shownIndex) }}</h3>
            <p class="text-small text-fg-subtle tabular-nums">
              {{ when(shown.at) }} · {{ w.ms(shown.ms) }} ·
              {{
                w.t('aiHistory.tokensLine', {
                  input: w.exact(shown.usage.input),
                  output: w.exact(shown.usage.output),
                  total: w.exact(shown.usage.input + shown.usage.output),
                })
              }}
              · {{ shown.cost ? w.money(shown.cost) : w.t('aiHistory.noPrice') }}
            </p>
            <p v-if="!w.answered(shown)" class="mt-1 text-small text-danger">{{ w.outcome(shown) }}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <DsButton v-if="shownResult" size="sm" :icon="Table" @click="reopenIn(shown, shownResult)">
              {{ w.t('aiHistory.chain.reopenStep') }}
            </DsButton>
            <DsButton v-if="mine" size="sm" variant="ghost" :icon="Trash2" @click="emit('removeStep', shown)">
              {{ w.t('aiHistory.chain.removeStep') }}
            </DsButton>
          </div>
        </div>
        <p v-if="!shown.content" class="rounded-lg bg-subtle px-3 py-2 text-ui text-fg-muted">
          {{ w.t('aiHistory.notKeptLong') }}
        </p>
        <RequestContent v-else :content="shown.content" />
      </section>
    </div>
  </div>
</template>
