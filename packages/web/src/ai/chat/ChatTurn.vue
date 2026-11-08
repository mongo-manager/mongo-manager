<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCcw, Sparkles, TriangleAlert } from 'lucide-vue-next'
import type { AiAgentPlace, AiChatBlock, AiChatTarget, AiResult } from '@mongo-manager/shared/browser'

import DsCallout from '@/ds/DsCallout.vue'
import DsButton from '@/ds/DsButton.vue'
import SafeMarkdown from '../SafeMarkdown.vue'
import AgentSteps from './AgentSteps.vue'
import { useAiWords } from '../words'
import type { TurnView } from './store'

type Index = { keys: Record<string, unknown>; options: Record<string, unknown> }
const props = defineProps<{
  turn: TurnView
  last: boolean
  busy: boolean
  /** Whether indexes may be created where a block goes (its collection, else the turn's). */
  canIndex: (target: AiChatTarget | null) => boolean
  /** A connection's name, for the place a block names (review M4). */
  connectionName: (id: string) => string
  /** User report 2026-10-25: the person may hand a change to the agent. */
  canAskAgent?: boolean
}>()
const emit = defineEmits<{
  insert: [result: AiResult, block: AiChatBlock]
  run: [result: AiResult, block: AiChatBlock]
  export: [result: AiResult, block: AiChatBlock]
  index: [index: Index, block: AiChatBlock]
  retry: []
  /** User report 2026-10-25: the change asked, asked of the agent. */
  askAgent: []
  /** W6.3: open the place an agent's step touched. */
  open: [place: AiAgentPlace]
}>()
const { t } = useI18n()
const words = useAiWords()

// 4a-1 final review minor 6: a streaming answer is drawn at most once a frame.
const shown = ref(props.turn.answer ?? '')
let frame: number | null = null
watch(
  () => props.turn.answer,
  (text) => {
    if (props.turn.state !== 'streaming' || typeof requestAnimationFrame === 'undefined') {
      shown.value = text ?? ''
      return
    }
    frame ??= requestAnimationFrame(() => {
      frame = null
      shown.value = props.turn.answer ?? ''
    })
  },
)
watch(
  () => props.turn.state,
  () => void (shown.value = props.turn.answer ?? ''),
)
onBeforeUnmount(() => {
  if (frame !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame)
})

const blockAt = (index: number): AiChatBlock | undefined => props.turn.blocks.find((b) => b.index === index)
const indexName = (ix: Index) =>
  typeof ix.options.name === 'string'
    ? ix.options.name
    : Object.entries(ix.keys)
        .map(([k, v]) => `${k}_${typeof v === 'object' && v ? Object.values(v)[0] : v}`)
        .join('_')
const pending = computed(() => props.turn.state === 'sending' || props.turn.state === 'streaming')
/** W6.3: a change waits for the person: not "thinking". */
const waiting = computed(() => !!props.turn.agent?.steps.some((s) => s.state === 'awaiting'))
const place = computed(() =>
  props.turn.local === true ? t('ai.sheet.local') : props.turn.local === false ? t('ai.sheet.cloud') : null,
)
/** W6.3: what an agent turn sent: the words and the connections' names; each step says its own. */
const agentWords = computed(() => {
  const a = props.turn.agent
  if (!a) return null
  const n = typeof a.connections === 'number' ? a.connections : (a.connections?.length ?? 0)
  const base = t('ai.agent.sentTurn', { n }, n)
  return a.documents ? `${base} ${t('ai.agent.documentsAllowed')}` : base
})
const partsWords = computed(() => {
  // An agent turn answered as the plain assistant (its model cannot call tools) sent what a general
  // turn sends: said as such (third review of the connection names, M-1).
  if (agentWords.value && props.turn.catalogue == null) return agentWords.value
  const s = props.turn.sent
  const p =
    props.turn.record?.parts ??
    (s
      ? {
          schema: true,
          current: !!s.current,
          indexes: s.indexes != null,
          validator: s.validator != null,
          samples: s.samples.length,
        }
      : null)
  if (!p?.schema) {
    // Review of fa862922 (I1): connection names go too, collections or not — said as sent.
    const collections = props.turn.catalogue ?? 0
    const connections = props.turn.connectionNames ?? 0
    if (collections && connections) return t('ai.chat.turn.partsNamesBoth', { connections, collections })
    if (connections) return t('ai.chat.turn.partsConnections', { n: connections }, connections)
    return collections
      ? t('ai.chat.turn.partsNames', { n: collections }, collections)
      : t('ai.chat.turn.partsNone')
  }
  const list = [
    t('ai.chat.context.schema'),
    ...(p.current ? [t('ai.chat.context.current')] : []),
    ...(p.indexes ? [t('ai.chat.context.indexes')] : []),
    ...(p.validator ? [t('ai.chat.context.validator')] : []),
    ...(p.samples ? [t('ai.chat.turn.samples', { n: p.samples }, p.samples)] : []),
    // Fifth review of the connection names (M5): the connections went by name too.
    ...(props.turn.connectionNames
      ? [t('ai.chat.turn.connectionNames', { n: props.turn.connectionNames }, props.turn.connectionNames)]
      : []),
  ]
  return t('ai.chat.turn.parts', { list: list.join(' · ') })
})
const leftOut = computed(() => {
  const l = props.turn.history?.leftOut ?? []
  if (!l.length) return ''
  const list = l.map((entry) => {
    const [, cause, n] = entry.split(':')
    const count = Number(n)
    return t(`ai.chat.turn.left.${cause}`, { n: count }, count)
  })
  return t('ai.chat.turn.leftOut', { list: list.join(', ') })
})
const sentText = computed(() => {
  const a = props.turn.agent
  // W6.3: an agent turn's "What was sent": the connections as named to the model, and per step what went.
  if (a && Array.isArray(a.connections))
    return JSON.stringify(
      {
        connections: a.connections,
        documents: a.documents,
        steps: a.steps.map((s) => ({
          tool: s.tool,
          sent: s.sent ?? 'nothing',
          ...(s.documents ? { documents: s.documents } : {}),
        })),
      },
      null,
      2,
    )
  return props.turn.sent ? JSON.stringify(props.turn.sent, null, 2) : ''
})
</script>

<template>
  <article class="flex flex-col gap-2.5" :data-turn="turn.key">
    <div
      class="ml-10 max-w-full self-end rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-ui break-words whitespace-pre-wrap text-fg"
    >
      <span class="sr-only">{{ t('ai.chat.turn.you') }}: </span>
      <template v-if="turn.message !== null">{{ turn.message }}</template>
      <em v-else class="text-fg-subtle">{{ t('ai.chat.turn.unreadable') }}</em>
    </div>
    <div class="flex gap-2.5">
      <span
        class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent/10 text-accent-fg"
        aria-hidden="true"
        ><Sparkles class="size-3.5"
      /></span>
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <span class="sr-only">{{ t('ai.chat.turn.assistant') }}:</span>
        <template v-if="turn.agent">
          <DsCallout v-for="note in turn.agent.notes" :key="note" tone="info" data-agent-note>
            {{ t(`ai.agent.note.${note}`) }}
          </DsCallout>
          <AgentSteps
            v-if="turn.agent.steps.length"
            :steps="turn.agent.steps"
            :live="turn.live"
            :running="turn.live && (turn.state === 'sending' || turn.state === 'streaming')"
            :connection-name="connectionName"
            @open="(p) => emit('open', p)"
          />
        </template>
        <p v-if="turn.answer === null" class="text-ui text-fg-subtle italic">
          {{ t('ai.chat.turn.unreadable') }}
        </p>
        <p v-else-if="!shown && pending && !waiting" class="flex items-center gap-2 text-ui text-fg-subtle">
          <span class="size-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
          {{ t('ai.chat.turn.thinking') }}
        </p>
        <SafeMarkdown v-if="shown" :source="shown">
          <template #block="{ index }">
            <div v-if="blockAt(index)" class="flex flex-wrap items-center gap-2" data-block-actions>
              <p
                v-if="blockAt(index)!.reason === 'server_js'"
                class="flex items-center gap-1.5 text-small text-warning"
              >
                <TriangleAlert class="size-3.5" aria-hidden="true" />{{ t('ai.chat.block.serverJs') }}
              </p>
              <template v-else-if="blockAt(index)!.result">
                <span
                  v-for="w in blockAt(index)!.warnings"
                  :key="w"
                  class="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-small text-warning"
                  ><TriangleAlert class="size-3" aria-hidden="true" />{{ words.warning(w) }}</span
                >
                <span
                  v-if="blockAt(index)!.target"
                  data-block-target
                  class="font-mono text-small text-fg-subtle"
                  >{{
                    t('ai.chat.block.in', {
                      ns: `${connectionName(blockAt(index)!.target!.connectionId)} · ${blockAt(index)!.target!.db}.${blockAt(index)!.target!.coll}`,
                    })
                  }}</span
                >
                <template v-if="blockAt(index)!.result!.kind === 'optimise'">
                  <template v-if="canIndex(blockAt(index)!.target ?? null)">
                    <DsButton
                      v-for="(ix, i) in (blockAt(index)!.result as Extract<AiResult, { kind: 'optimise' }>)
                        .indexes"
                      :key="i"
                      size="sm"
                      @click="emit('index', ix, blockAt(index)!)"
                      >{{ t('ai.chat.block.optimise', { name: indexName(ix) }) }}</DsButton
                    >
                  </template>
                </template>
                <!-- User report 2026-10-13: one action under a block. A file asked for is exported. -->
                <DsButton
                  v-else-if="blockAt(index)!.export"
                  size="sm"
                  variant="primary"
                  :disabled="busy"
                  data-block-export
                  @click="emit('export', blockAt(index)!.result!, blockAt(index)!)"
                  >{{ t(`ai.chat.block.export.${blockAt(index)!.export}`) }}</DsButton
                >
                <!-- A query or a pipeline runs where it belongs, from anywhere (user request 2026-10-10). -->
                <DsButton
                  v-else-if="
                    blockAt(index)!.result!.kind === 'query' || blockAt(index)!.result!.kind === 'pipeline'
                  "
                  size="sm"
                  variant="primary"
                  :disabled="busy"
                  @click="emit('run', blockAt(index)!.result!, blockAt(index)!)"
                  >{{ t('ai.chat.block.run') }}</DsButton
                >
                <DsButton
                  v-else
                  size="sm"
                  :disabled="busy"
                  @click="emit('insert', blockAt(index)!.result!, blockAt(index)!)"
                  >{{ t('ai.chat.block.validation') }}</DsButton
                >
              </template>
            </div>
          </template>
        </SafeMarkdown>
        <p v-if="turn.state === 'stopped'" class="text-small text-fg-subtle">
          {{ t('ai.chat.turn.stopped') }}
        </p>
        <DsCallout v-if="turn.state === 'error' && turn.error" tone="danger">
          <p>{{ words.reason(turn.error.reason, turn.error.retryAfterMs) }}</p>
          <p v-if="turn.error.nothingSent" class="mt-0.5 text-small opacity-80">
            {{ t('ai.sheet.notSent') }}
          </p>
        </DsCallout>
        <div
          v-if="
            turn.agentAsked && turn.state === 'done' && !turn.agent && canAskAgent && !busy && turn.message
          "
          data-ask-agent
        >
          <DsButton size="sm" variant="primary" @click="emit('askAgent')"
            ><Sparkles class="size-3.5" aria-hidden="true" />{{ t('ai.chat.turn.askAgent') }}</DsButton
          >
        </div>
        <div v-if="last && !busy && (turn.state === 'error' || turn.state === 'stopped')">
          <DsButton size="sm" variant="ghost" @click="emit('retry')"
            ><RotateCcw class="size-3.5" aria-hidden="true" />{{ t('ai.chat.turn.retry') }}</DsButton
          >
        </div>
        <p v-if="turn.record?.cut" class="text-small text-fg-subtle">
          {{ t('ai.chat.turn.cut') }}
        </p>
        <p v-if="leftOut" class="text-small text-fg-subtle">{{ leftOut }}</p>
        <p
          v-if="turn.provider && !pending"
          class="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-subtle"
        >
          <span>{{ turn.provider.name }} · {{ turn.provider.model }}</span>
          <span v-if="place" class="rounded-full border border-line px-1.5">{{ place }}</span>
          <span v-if="!turn.error?.nothingSent">{{ partsWords }}</span>
        </p>
        <details v-if="turn.sent" class="text-small">
          <summary class="cursor-pointer text-fg-muted hover:text-fg">
            {{ t('ai.chat.turn.sentTitle') }}
          </summary>
          <pre class="mt-1 max-h-64 overflow-auto rounded-lg bg-subtle p-2 font-mono">{{ sentText }}</pre>
        </details>
      </div>
    </div>
  </article>
</template>
