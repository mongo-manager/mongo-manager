<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeftRight,
  CirclePause,
  CirclePlay,
  FileSearch,
  Flag,
  ListTree,
  ScanSearch,
  Square,
  Trash2,
} from 'lucide-vue-next'
import { RUNNING_STATES, type ConnectionColor, type LiveSyncView } from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsMenu from '@/ds/DsMenu.vue'
import type { DsMenuItem } from '@/ds/menu'
import DsProgress from '@/ds/DsProgress.vue'
import LagSparkline from './LagSparkline.vue'
import { COLOR_CLASSES } from '@/connections/colors'
import { formatCount, formatDuration, formatRelative } from '@/format'
import { STATE_ICON, STATE_TONE, TONE_CLASSES, useLiveSyncWords, type CardAction } from './words'

/** Spec §5: one live sync at a glance — both sides, the state, how far behind, counts, the reason and its action. */
const props = defineProps<{
  sync: LiveSyncView
  now: number
  administrator: boolean
  colors: Record<string, ConnectionColor | null | undefined>
  /** The initial copy's progress, from its job (copying only). */
  progress: { done: number; total: number } | null
  lag: Array<{ at: number; lag: number }>
}>()
const emit = defineEmits<{ act: [action: CardAction] }>()
const { t, locale } = useI18n()
const words = useLiveSyncWords()
const titleId = useId()
const s = computed(() => props.sync)
const n = (v: number) => formatCount(v, locale.value)
const compact = (v: number) => new Intl.NumberFormat(locale.value, { notation: 'compact' }).format(v)
const ns = (db: string, coll: string | null) => (coll ? `${db}.${coll}` : db)
/** A past moment from the server: never "in 3 seconds" while the page's clock lags it. */
const ago = (at: number) => formatRelative(Math.min(0, at - props.now), locale.value)
const running = computed(() => (RUNNING_STATES as readonly string[]).includes(s.value.state))
const final = computed(() => ['completed', 'failed', 'stopped'].includes(s.value.state))
const canAct = computed(() => s.value.mine || props.administrator)

const percent = computed(() =>
  props.progress && props.progress.total > 0
    ? Math.min(100, Math.round((props.progress.done / props.progress.total) * 100))
    : null,
)
const lagText = computed(() =>
  s.value.state === 'live'
    ? t('liveSync.card.live')
    : s.value.state === 'catching_up'
      ? t('liveSync.card.behind', { time: formatDuration(s.value.counters.lagMs / 1000, locale.value) })
      : null,
)
const lastChange = computed(() =>
  s.value.counters.lastEventAt === null ? null : ago(s.value.counters.lastEventAt),
)
const retryText = computed(() =>
  s.value.retryAt === null
    ? null
    : t('liveSync.card.retryIn', {
        when: formatRelative(Math.max(0, s.value.retryAt - props.now), locale.value),
      }),
)
// W4.6: a scheduled sync says when it starts.
const scheduled = computed(() => s.value.state === 'paused' && s.value.reason === 'scheduled')
const reasonText = computed(() =>
  scheduled.value && s.value.scheduledAt
    ? t('liveSync.card.scheduledFor', {
        when: new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
          s.value.scheduledAt,
        ),
      })
    : words.reason(s.value),
)
// Spec §2.3: a write error's document and code; a namespace for a schema change or a drop. Final
// review I8: why it retries, or the stream error, in words.
const detailText = computed(() => {
  const { state, detail, reason } = s.value
  if (!detail) return null
  if (state === 'retrying' || (state === 'attention' && reason === 'stream_error')) return null
  // W4.6: a scheduled start's refusals, in words. Sixth review of the open's stop (minor 1): one with
  // no words anywhere is said as a plan that failed, never as its code.
  if (state === 'attention' && reason === 'scheduled_refused')
    return [...new Set(detail.split(',').map((r) => words.refusal(r, t('liveSync.refusal.plan'))))].join(' ')
  return state === 'attention' && reason !== 'owner_access' ? detail : null
})
const causeText = computed(() => {
  const { state, detail, reason } = s.value
  return detail && (state === 'retrying' || (state === 'attention' && reason === 'stream_error'))
    ? words.cause(detail)
    : null
})
const adminPause = computed(
  () => s.value.state === 'paused' && s.value.reason === 'admin' && !props.administrator,
)
const verifyText = computed(() => {
  const v = s.value.verify
  if (!v) return null
  if (v.state === 'running') return t('liveSync.card.verifying')
  if (v.state === 'failed') return t('liveSync.card.verifyFailed')
  const sum = (k: 'same' | 'different' | 'onlySource' | 'onlyTarget') => v.pairs.reduce((x, p) => x + p[k], 0)
  return t('liveSync.card.verified', {
    when: new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' }).format(
      v.finishedAt ?? v.startedAt,
    ),
    same: n(sum('same')),
    different: n(sum('different') + sum('onlySource') + sum('onlyTarget')),
  })
})

/** The reason's own actions (spec §1.4, §1.7, §3.2). */
const reasonActions = computed<Array<{ id: CardAction; label: string; primary?: boolean }>>(() => {
  const mine = s.value.mine
  if (s.value.state === 'failed')
    return mine ? [{ id: 'startAgain', label: t('liveSync.action.startAgain'), primary: true }] : []
  if (s.value.state !== 'attention') return []
  switch (s.value.reason) {
    case 'write_error':
      return [
        ...(mine ? [{ id: 'skip' as const, label: t('liveSync.action.skip') }] : []),
        { id: 'resume', label: t('liveSync.action.tryAgain'), primary: true },
      ]
    case 'schema_changed':
      return mine
        ? [
            { id: 'applySchema', label: t('liveSync.action.applySchema'), primary: true },
            { id: 'ignoreSchema', label: t('liveSync.action.ignoreSchema') },
          ]
        : []
    case 'rules_changed':
    case 'connection_changed':
      return mine ? [{ id: 'review', label: t('liveSync.action.review'), primary: true }] : []
    // Final review: a target dropped behind the sync lacks what came before: start again. W4.6: so
    // does a scheduled sync whose plan no longer held at its time (it is planned anew).
    case 'source_gone':
    case 'target_gone':
    case 'copy_failed':
    case 'copy_interrupted':
    case 'scheduled_refused':
      return mine ? [{ id: 'startAgain', label: t('liveSync.action.startAgain'), primary: true }] : []
    default:
      return canAct.value ? [{ id: 'resume', label: t('liveSync.action.tryAgain'), primary: true }] : []
  }
})

const items = computed<DsMenuItem[]>(() => [
  { id: 'details', label: t('liveSync.action.details'), icon: ListTree },
  ...(canAct.value && !final.value
    ? [{ id: 'stop', label: t('liveSync.action.stopMenu'), icon: Square, danger: true }]
    : []),
  ...(canAct.value && !running.value
    ? [{ id: 'remove', label: t('liveSync.action.deleteMenu'), icon: Trash2, danger: true }]
    : []),
])
const select = (id: string) => emit('act', id as CardAction)
/** When the initial copy finished, or the sync did (spec §5: what the counters do not say). */
const milestone = computed(() =>
  s.value.finishedAt !== null
    ? t('liveSync.card.finished', { when: ago(s.value.finishedAt) })
    : s.value.copiedAt !== null
      ? t('liveSync.card.copied', { when: ago(s.value.copiedAt) })
      : null,
)
const dot = (id: string) => {
  const color = props.colors[id]
  return color ? COLOR_CLASSES[color] : 'bg-line-strong'
}
</script>

<template>
  <article
    :data-sync="s.id"
    :aria-labelledby="titleId"
    class="flex flex-col gap-4 rounded-card border border-line bg-surface p-5 transition-shadow duration-150 hover:shadow-sm motion-reduce:transition-none"
  >
    <header class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <h3 :id="titleId" class="line-clamp-2 font-semibold [overflow-wrap:anywhere] text-fg">
          {{ s.name }}
        </h3>
        <dl class="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-ui">
          <template v-for="side in ['source', 'target'] as const" :key="side">
            <dt class="text-small font-medium uppercase tracking-wide text-fg-subtle">
              {{ t(`liveSync.card.${side === 'source' ? 'from' : 'to'}`) }}
            </dt>
            <dd
              :data-from="side === 'source' ? '' : undefined"
              :data-to="side === 'target' ? '' : undefined"
              class="min-w-0 text-fg"
              :title="`${s[side].connectionName} · ${ns(s[side].db, s[side].coll)}`"
            >
              <span class="sr-only">{{ t(`liveSync.card.${side === 'source' ? 'from' : 'to'}`) }}</span>
              <span class="flex min-w-0 items-center gap-1.5">
                <span
                  class="size-2 shrink-0 rounded-full"
                  :class="dot(s[side].connectionId)"
                  aria-hidden="true"
                />
                <span class="truncate">{{ s[side].connectionName || t('liveSync.card.hidden') }}</span>
              </span>
              <span class="block truncate pl-3.5 font-mono text-small text-fg-subtle">{{
                ns(s[side].db, s[side].coll)
              }}</span>
            </dd>
          </template>
        </dl>
        <!-- W4.6: one direction of a two-way sync, and the conflicts it settled. -->
        <p
          v-if="s.twoWay"
          class="mt-1 flex items-center gap-1.5 text-small text-fg-muted"
          data-test="two-way"
        >
          <ArrowLeftRight class="size-3.5" aria-hidden="true" />{{
            t(s.twoWay.side === 'forward' ? 'liveSync.card.twoWayForward' : 'liveSync.card.twoWayBack')
          }}<template v-if="s.counters.conflicts">
            ·
            {{ t('liveSync.card.conflicts', { n: n(s.counters.conflicts) }, s.counters.conflicts) }}</template
          >
        </p>
        <p v-if="!s.mine" class="mt-1 text-small text-fg-subtle">
          {{ t('liveSync.card.owner', { name: s.owner }) }}
        </p>
      </div>
      <span
        :data-state="s.state"
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-small font-medium"
        :class="TONE_CLASSES[STATE_TONE[s.state]]"
      >
        <component
          :is="STATE_ICON[s.state]"
          class="size-3.5"
          :class="s.state === 'live' ? 'animate-pulse motion-reduce:animate-none' : ''"
          aria-hidden="true"
        />{{ words.state(s.state) }}
      </span>
    </header>

    <div v-if="s.state === 'copying'" class="flex flex-col gap-1.5">
      <DsProgress
        size="md"
        :label="t('liveSync.card.copyProgress')"
        :value="percent === null ? undefined : percent / 100"
        :value-text="percent === null ? t('liveSync.card.copyingUnknown') : undefined"
      />
      <p class="text-ui text-fg-muted">
        {{
          percent === null || !progress
            ? t('liveSync.card.copyingNoProgress')
            : t('liveSync.card.copying', {
                percent,
                done: compact(progress.done),
                total: compact(progress.total),
              })
        }}
      </p>
    </div>

    <div v-if="lagText" class="flex flex-col gap-2">
      <p class="text-ui text-fg">{{ lagText }}</p>
      <LagSparkline v-if="lag.length > 1" :points="lag" />
    </div>

    <dl class="grid grid-cols-4 gap-2 text-center">
      <div
        v-for="k in ['inserted', 'replaced', 'deleted', 'skipped'] as const"
        :key="k"
        class="flex flex-col-reverse rounded-lg bg-subtle px-2 py-1.5"
      >
        <!-- The term first for screen readers (m17); the value shows on top. -->
        <dt class="text-small text-fg-subtle">{{ t(`liveSync.card.counters.${k}`) }}</dt>
        <dd class="text-ui font-semibold tabular-nums text-fg">
          {{ n(s.counters[k]) }}
        </dd>
      </div>
    </dl>
    <p v-if="lastChange || milestone" class="-mt-2 flex flex-wrap gap-x-3 text-small text-fg-subtle">
      <span v-if="milestone">{{ milestone }}</span>
      <span v-if="lastChange">{{ t('liveSync.card.lastChange', { when: lastChange }) }}</span>
    </p>

    <div
      v-if="reasonText || retryText || causeText"
      class="flex flex-col gap-2 rounded-xl border px-4 py-3 text-ui"
      :class="
        s.state === 'failed'
          ? 'border-danger/25 bg-danger-soft text-danger'
          : s.state === 'attention' || s.state === 'retrying'
            ? 'border-warning/25 bg-warning-soft text-warning'
            : 'border-line bg-subtle text-fg'
      "
    >
      <p v-if="reasonText">
        {{ reasonText }}<template v-if="adminPause"> {{ t('liveSync.card.askAdmin') }}</template>
      </p>
      <p v-if="detailText" class="break-all font-mono text-small">{{ detailText }}</p>
      <p v-if="causeText">{{ causeText }}</p>
      <p v-if="retryText">{{ retryText }}</p>
      <div v-if="reasonActions.length" class="flex flex-wrap gap-2">
        <DsButton
          v-for="a in reasonActions"
          :key="a.id"
          size="sm"
          :variant="a.primary ? 'primary' : 'secondary'"
          @click="emit('act', a.id)"
          >{{ a.label }}</DsButton
        >
      </div>
    </div>

    <p v-if="verifyText" class="flex items-center gap-2 text-small text-fg-muted">
      <FileSearch class="size-4 shrink-0" aria-hidden="true" />{{ verifyText }}
    </p>

    <footer class="mt-auto flex flex-wrap items-center gap-2">
      <DsButton
        v-if="canAct && running && s.state !== 'copying' && s.state !== 'cutting_over'"
        size="sm"
        @click="emit('act', 'pause')"
        ><CirclePause class="size-4" aria-hidden="true" />{{ t('liveSync.action.pause') }}</DsButton
      >
      <DsButton
        v-if="canAct && s.state === 'paused' && !adminPause && (!scheduled || s.mine)"
        size="sm"
        variant="primary"
        @click="emit('act', 'resume')"
        ><CirclePlay class="size-4" aria-hidden="true" />{{
          t(scheduled ? 'liveSync.action.startNow' : 'liveSync.action.resume')
        }}</DsButton
      >
      <DsButton
        v-if="
          canAct &&
          !scheduled &&
          !['copying', 'cutting_over'].includes(s.state) &&
          s.verify?.state !== 'running'
        "
        size="sm"
        @click="emit('act', 'verify')"
        ><ScanSearch class="size-4" aria-hidden="true" />{{ t('liveSync.action.verify') }}</DsButton
      >
      <DsButton
        v-if="s.mine && !s.twoWay && (s.state === 'live' || s.state === 'catching_up')"
        size="sm"
        @click="emit('act', 'finish')"
        ><Flag class="size-4" aria-hidden="true" />{{ t('liveSync.action.finish') }}</DsButton
      >
      <span class="flex-1" />
      <DsMenu
        focusable
        touch
        :label="t('liveSync.card.more', { name: s.name })"
        :items="items"
        @select="select"
      />
    </footer>
  </article>
</template>
