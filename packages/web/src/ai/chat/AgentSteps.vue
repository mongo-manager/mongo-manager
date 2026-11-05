<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  ExternalLink,
  Hand,
  CalendarClock,
  HardDrive,
  LogIn,
  ListChecks,
  LoaderCircle,
  Rows3,
} from 'lucide-vue-next'
import type { AiAgentPlace, AiAgentStep, AiAgentStepState } from '@mongo-manager/shared/browser'
import AgentProposalCard from './AgentProposalCard.vue'
import AgentStepResults from './AgentStepResults.vue'
import { useAgentWords } from './agentWords'
import { useTabsStore } from '@/stores/tabs'
import { useJobsStore } from '@/jobs/store'
import AgentJobFile from './AgentJobFile.vue'
import { useSessionStore } from '@/stores/session'
import { useOidcSignInStore } from '@/stores/oidcSignIn'
import { useQuery } from '@tanstack/vue-query'
import { connectionsApi, queryKeys } from '@/api/connections'
import { openDestinationsTab, openJobsTab, openSchedulesTab } from '@/workspace/openTabs'

/**
 * W6.3 §6: an agent turn's steps as they run — what each did and where, what it sent to the model,
 * a link to the collection it touched — and a change waiting for the person as its card.
 */
const props = defineProps<{
  steps: AiAgentStep[]
  /** The turn is live: a waiting change can be answered. */
  live: boolean
  /** Review of C4 (I1): the turn is still running (a plan's changes may yet come). */
  running?: boolean
  connectionName: (id: string) => string
  /**
   * A page of what happened (the AI history; review of its steps, M2, M3): nothing to act on — no
   * sign-in, job or destinations — and only a place a change left, that is still listed, opens.
   */
  record?: boolean
  /** Whether a place's connection is in the reader's list (a record's opens only then). */
  listed?: (connectionId: string) => boolean
}>()
const emit = defineEmits<{ open: [place: AiAgentPlace] }>()
const tabs = useTabsStore()
const jobs = useJobsStore()
// Review of A4 (I3): the destinations page is an administrator's.
const session = useSessionStore()
/** Design 2026-10-25 (B1): a step on a schedule opens the Schedules page. */
const SCHEDULE_TOOLS = new Set<string>([
  'list_schedules',
  'create_backup_schedule',
  'run_schedule',
  'pause_schedule',
  'resume_schedule',
  'update_schedule',
  'delete_schedule',
])
/**
 * A step's place to open: live, any step that reached it; on a record, a place a step that ended
 * well reached — a read's or a change's — not one it dropped, on a connection still listed.
 */
function opens(step: AiAgentStep): boolean {
  if (!step.place?.db || step.state === 'refused') return false
  if (!props.record) return true
  return (
    step.state === 'done' &&
    step.tool !== 'drop_collection' &&
    step.tool !== 'drop_database' &&
    (props.listed?.(step.place.connectionId) ?? false)
  )
}
// Design 2026-10-25 (A5): a connection that needs this person's sign-in offers it from the step.
const signIn = useOidcSignInStore()
// Review of A5 (M5): only where a person signs in — a workload's own identity has no one to.
const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const personSignsIn = (id: string) => {
  const auth = connections.value?.find((c) => c.id === id)?.settings.auth
  return auth?.mechanism === 'MONGODB-OIDC' && !auth.oidc?.environment
}
const needsSignIn = (s: AiAgentStep) =>
  !!s.place &&
  (s.summary?.problem === 'oidc' || s.reason === 'oidc_sign_in') &&
  personSignsIn(s.place.connectionId)
/**
 * Design 2026-10-25 (B5): a live read step's documents, shown on asking from the person's own read —
 * never on a record (a page of what happened reads nothing).
 */
const shown = reactive(new Set<string>())
/** Read once: hidden again, the documents stay (no second read). */
const opened = reactive(new Set<string>())
const showsResults = (s: AiAgentStep) => !props.record && s.state === 'done' && !!s.results && !!s.place?.coll
const resultsId = (s: AiAgentStep) => `agent-results-${s.id.replace(/[^\w-]/g, '-')}`
function toggleResults(s: AiAgentStep): void {
  if (shown.has(s.id)) shown.delete(s.id)
  else {
    shown.add(s.id)
    opened.add(s.id)
  }
}
/**
 * Design 2026-10-25 (C4): a plan's changes, each with how it went — the step of the turn that is
 * that change (after the plan, before another), or not reached: to come, or left once it stopped.
 */
function planItems(plan: AiAgentStep): Array<{ tool: string; about: string; state: string }> {
  const at = props.steps.indexOf(plan)
  const after = props.steps.slice(at + 1)
  const next = after.findIndex((s) => s.tool === 'plan_changes' && s.state === 'done')
  const own = next < 0 ? after : after.slice(0, next)
  let stopped = false
  return (plan.plan?.changes ?? []).map((change, i) => {
    const step = own.find((s) => s.planItem === i)
    // Review of C4 (I1): a turn that ended before a change was reached leaves it unreached.
    const state: string = step ? step.state : stopped ? 'skipped' : props.running ? 'todo' : 'unreached'
    if (step && step.state !== 'done' && step.state !== 'awaiting' && step.state !== 'running') stopped = true
    return { tool: change.tool, about: change.about, state }
  })
}
const PLAN_TONES: Record<string, string> = {
  done: 'bg-success text-on-accent',
  awaiting: 'bg-accent text-on-accent',
  running: 'bg-accent-soft text-accent-fg',
  todo: 'bg-subtle text-fg-muted',
  skipped: 'bg-subtle text-fg-subtle',
  unreached: 'bg-subtle text-fg-subtle',
}
const planTone = (state: string) => PLAN_TONES[state] ?? 'bg-warning-soft text-warning'
const planState = (state: string) =>
  state === 'todo' || state === 'skipped' || state === 'unreached'
    ? t(`ai.agent.plan.${state}`)
    : words.state(state as AiAgentStepState)
/** Whether a step offers anything to do (its row of actions under its words). */
function offers(s: AiAgentStep): boolean {
  return (
    (!props.record &&
      ((needsSignIn(s) && !!s.place) ||
        (s.reason === 'no_destination' && session.can('settings:manage')) ||
        (SCHEDULE_TOOLS.has(s.tool) && s.state !== 'awaiting') ||
        typeof s.summary?.job === 'string' ||
        typeof s.backup?.job === 'string')) ||
    showsResults(s)
  )
}
/** Review of A3 (I6): the job itself, opened with its details on the jobs page. */
function openJob(id: string): void {
  jobs.focus(id)
  openJobsTab(tabs)
}
const { t } = useI18n()
const words = useAgentWords()
/**
 * User report 2026-10-30: steps refused one after another for one reason on one connection (the
 * model asked several at once) read as one row naming each tool, the reason said once.
 */
const rows = computed(() => {
  const out: Array<{ step: AiAgentStep; tools: string[] }> = []
  for (const step of props.steps) {
    const last = out.at(-1)
    if (
      last &&
      step.state === 'refused' &&
      last.step.state === 'refused' &&
      step.reason === last.step.reason &&
      step.place?.connectionId === last.step.place?.connectionId
    ) {
      if (!last.tools.includes(step.tool)) last.tools.push(step.tool)
      continue
    }
    out.push({ step, tools: [step.tool] })
  }
  return out
})
const ICONS = {
  running: LoaderCircle,
  awaiting: Hand,
  done: CircleCheck,
  error: CircleX,
  refused: Ban,
  declined: Ban,
  cancelled: Ban,
  expired: Clock,
} as const
const TONES: Record<string, string> = {
  running: 'text-fg-subtle',
  awaiting: 'text-accent-fg',
  done: 'text-success',
  error: 'text-danger',
  refused: 'text-warning',
  declined: 'text-fg-subtle',
  cancelled: 'text-fg-subtle',
  expired: 'text-fg-subtle',
}
</script>

<template>
  <ol class="flex flex-col gap-2" :aria-label="t('ai.agent.steps')" data-agent-steps>
    <li
      v-for="{ step, tools } in rows"
      :key="step.id"
      class="flex flex-col gap-2"
      :data-agent-step="step.tool"
    >
      <AgentProposalCard
        v-if="live && step.state === 'awaiting' && step.proposal"
        :step="step"
        :connection-name="connectionName"
      />
      <div v-else class="flex items-start gap-2 rounded-lg border border-line px-2.5 py-2">
        <component
          :is="ICONS[step.state]"
          class="mt-0.5 size-4 shrink-0"
          :class="[
            TONES[step.state],
            step.state === 'running' ? 'animate-spin motion-reduce:animate-none' : '',
          ]"
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <p class="flex flex-wrap items-baseline gap-x-2 text-ui text-fg">
            <span class="font-medium">{{ tools.map((tool) => words.tool(tool)).join(', ') }}</span>
            <span class="text-small text-fg-subtle">{{ words.state(step.state) }}</span>
          </p>
          <p
            v-if="words.place(step.place, connectionName)"
            class="truncate font-mono text-small text-fg-muted"
          >
            {{ words.place(step.place, connectionName) }}
          </p>
          <p v-if="words.summary(step)" class="text-small text-fg">{{ words.summary(step) }}</p>
          <p v-if="step.reason" class="text-small text-fg-muted">
            {{ words.reason(step.reason) }}
            <template v-if="!record && step.reason === 'no_destination'">
              {{
                session.can('settings:manage') ? t('ai.agent.addDestination') : t('ai.agent.askAdministrator')
              }}
            </template>
          </p>
          <!-- Design 2026-10-25 (C4): the plan's changes, in its order, each with how it went. -->
          <!-- Review of C4 (nit): the title above the list, not one of its items. -->
          <p v-if="step.plan" class="mt-1 text-small font-medium text-fg" aria-hidden="true">
            {{ step.plan.title }}
          </p>
          <ol
            v-if="step.plan"
            class="flex flex-col gap-1.5"
            :aria-label="t('ai.agent.plan.label', { title: step.plan.title })"
            data-agent-plan
          >
            <li
              v-for="(item, i) in planItems(step)"
              :key="i"
              class="flex items-start gap-2 text-small"
              :data-agent-plan-item="item.state"
            >
              <span
                class="mt-px grid size-4.5 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold tabular-nums"
                :class="planTone(item.state)"
                aria-hidden="true"
                >{{ i + 1 }}</span
              >
              <span class="flex min-w-0 flex-col">
                <span class="text-fg">{{ item.about }}</span>
                <span class="text-fg-subtle">{{ words.tool(item.tool) }} · {{ planState(item.state) }}</span>
              </span>
            </li>
          </ol>
          <!-- C4: the backup made first, before the change. -->
          <p v-if="step.backup" class="text-small text-fg-muted" data-agent-step-backup>
            {{ t(`ai.agent.backup.${step.backup.state}`) }}
          </p>
          <p v-if="words.sent(step)" class="text-small text-fg-subtle">
            {{ t('ai.agent.sentStep', { what: words.sent(step) }) }}
          </p>
          <!-- UI review of wave B: what a step offers, under its words (they keep the card's width). -->
          <div v-if="offers(step)" class="mt-1 -ml-2 flex flex-wrap gap-1">
            <button
              v-if="!record && needsSignIn(step) && step.place"
              type="button"
              class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              data-agent-sign-in
              @click="signIn.request(step.place.connectionId)"
            >
              <LogIn class="size-3.5" aria-hidden="true" />{{ t('ai.agent.signIn') }}
            </button>
            <button
              v-if="!record && step.reason === 'no_destination' && session.can('settings:manage')"
              type="button"
              class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              data-agent-destinations
              @click="openDestinationsTab(tabs)"
            >
              <HardDrive class="size-3.5" aria-hidden="true" />{{ t('ai.agent.openDestinations') }}
            </button>
            <button
              v-if="!record && SCHEDULE_TOOLS.has(step.tool) && step.state !== 'awaiting'"
              type="button"
              class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              data-agent-schedules
              @click="openSchedulesTab(tabs)"
            >
              <CalendarClock class="size-3.5" aria-hidden="true" />{{ t('ai.agent.openSchedules') }}
            </button>
            <button
              v-if="!record && typeof step.summary?.job === 'string'"
              type="button"
              class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              data-agent-job
              @click="openJob(String(step.summary!.job))"
            >
              <ListChecks class="size-3.5" aria-hidden="true" />{{ t('ai.agent.openJob') }}
            </button>
            <!-- User request 2026-10-26: the file its job made, downloaded here once it is done. -->
            <AgentJobFile v-if="!record && typeof step.summary?.job === 'string'" :job="step.summary.job" />
            <button
              v-if="!record && typeof step.backup?.job === 'string'"
              type="button"
              class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              data-agent-backup-job
              @click="openJob(String(step.backup!.job))"
            >
              <ListChecks class="size-3.5" aria-hidden="true" />{{ t('ai.agent.backup.openJob') }}
            </button>
            <AgentJobFile v-if="!record && typeof step.backup?.job === 'string'" :job="step.backup.job" />
            <button
              v-if="showsResults(step)"
              type="button"
              class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              :aria-expanded="shown.has(step.id)"
              :aria-controls="resultsId(step)"
              data-agent-results
              @click="toggleResults(step)"
            >
              <Rows3 class="size-3.5" aria-hidden="true" />{{
                shown.has(step.id) ? t('ai.agent.results.hide') : t('ai.agent.results.show')
              }}
            </button>
          </div>
        </div>
        <button
          v-if="step.place && opens(step)"
          type="button"
          class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          :aria-label="t('ai.agent.open', { place: words.place(step.place, connectionName) })"
          :title="t('ai.agent.open', { place: words.place(step.place, connectionName) })"
          data-agent-open
          @click="emit('open', step.place)"
        >
          <ExternalLink class="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <!-- Review of B5 (nit): the place the button controls is there before it opens. -->
      <div
        v-if="showsResults(step)"
        :id="resultsId(step)"
        :aria-label="opened.has(step.id) ? t('ai.agent.results.label') : undefined"
        :role="opened.has(step.id) ? 'group' : undefined"
      >
        <AgentStepResults
          v-if="opened.has(step.id) && step.results && step.place?.db && step.place.coll"
          v-show="shown.has(step.id)"
          :results="step.results"
          :connection-id="step.place.connectionId"
          :db="step.place.db"
          :coll="step.place.coll"
        />
      </div>
    </li>
  </ol>
</template>
