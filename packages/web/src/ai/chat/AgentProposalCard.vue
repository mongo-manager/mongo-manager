<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { DatabaseBackup, ListChecks, Lock, ShieldCheck, TriangleAlert } from 'lucide-vue-next'
import {
  MAX_DB_PASSWORD,
  MIN_BACKUP_PASSWORD,
  MIN_DB_PASSWORD,
  type AiAgentStep,
} from '@mongo-manager/shared/browser'
import DsButton from '@/ds/DsButton.vue'
import DsCallout from '@/ds/DsCallout.vue'
import DsCodeView from '@/ds/DsCodeView.vue'
import DsInput from '@/ds/DsInput.vue'
import PasswordField from '@/backup/PasswordField.vue'
import DsChoiceCard from '@/ds/DsChoiceCard.vue'
import DbPasswordField from '@/dbaccess/PasswordField.vue'
import { confirmGuard } from '@/ds/confirmGuard'
import { useConfirmArming } from '@/ds/useConfirmArming'
import { ApiError } from '@/api/client'
import { formatCount } from '@/format'
import { useAssistantStore } from './store'
import { useAgentWords } from './agentWords'
import { useTabsStore } from '@/stores/tabs'
import { useJobsStore } from '@/jobs/store'
import { openJobsTab } from '@/workspace/openTabs'

/**
 * W6.3 §3: a change the agent proposes, shown before anything is written — where it acts, exactly
 * what will be sent, what the app's own preview found — with Confirm and Decline. Confirm follows the
 * app's confirmation rules (a moment before it may be pressed, no double click); a destructive change
 * is marked so, and one the app's dialogs ask a name for takes it typed. Nothing is written without
 * this click.
 */
const props = defineProps<{ step: AiAgentStep; connectionName: (id: string) => string }>()
const { t, te, locale } = useI18n()
const words = useAgentWords()
const store = useAssistantStore()
const id = useId()
const typed = ref('')
const password = ref('')
const repeat = ref('')
/**
 * User request 2026-10-26: a backup made without a password instead (a compressed archive), where
 * the card offers it — the person's choice, never the model's; encrypted unless they pick it.
 */
const format = ref<'mmbak' | 'gzip'>('mmbak')
const plain = computed(() => !!proposal.value.plain && format.value === 'gzip')
const deciding = ref(false)
const error = ref<string | null>(null)
const proposal = computed(() => props.step.proposal!)
const payloadText = computed(() => {
  const payload = proposal.value.payload
  // What goes, as chosen: the format the person picked.
  const shown =
    plain.value && payload && typeof payload === 'object'
      ? { ...(payload as object), format: 'gzip' }
      : payload
  return JSON.stringify(shown, null, 2)
})
/** Re-review of C3 (minor 6): the rules a validator replaces, beside what is sent. */
const replacedText = computed(() => {
  const rules = proposal.value.preview?.currentRules
  return rules ? JSON.stringify(rules, null, 2) : null
})
const count = (n: number) => formatCount(n, locale.value)
/** Review of C1 (nit 8): a file format, and a SQL dialect, by the names people know them by. */
const FORMAT_NAMES: Record<string, string> = {
  csv: 'CSV',
  json: 'JSON',
  ndjson: 'NDJSON',
  xlsx: 'Excel',
  sql: 'SQL',
}
const DIALECT_NAMES: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' }
const ready = computed(
  () =>
    (!proposal.value.typed || typed.value === proposal.value.typed) &&
    // Design 2026-10-25 (A3): asked twice, as the app's backup dialog asks — a typo would leave the
    // backup unreadable.
    (!proposal.value.password ||
      plain.value ||
      // Design 2026-10-25 (B2): a backup made before opens with its password as it was made.
      (proposal.value.opening
        ? password.value.length > 0
        : // Review of B4 (I2): a new MongoDB user's, as Database Access takes one (shown, not repeated).
          proposal.value.passwordFor === 'user'
          ? password.value.length >= MIN_DB_PASSWORD && password.value.length <= MAX_DB_PASSWORD
          : password.value.length >= MIN_BACKUP_PASSWORD && repeat.value === password.value)),
)
/**
 * Design 2026-10-25 (C4): the backup the card offers before a change that loses data — encrypted with
 * a password asked twice, as the app's backup dialog asks; the change waits until it is made.
 */
const backupPassword = ref('')
const backupRepeat = ref('')
const startingBackup = ref(false)
const backupError = ref<string | null>(null)
const backup = computed(() => props.step.backup ?? null)
/**
 * Review of C4 (M5): asked and started, the backup is running until the stream says how it went —
 * Confirm stays held even if the answer comes before the step's own line.
 */
const startedJob = ref<string | null>(null)
const backingUp = computed(
  () =>
    startingBackup.value ||
    backup.value?.state === 'running' ||
    (startedJob.value !== null && (!backup.value || backup.value.job !== startedJob.value)),
)
const backupReady = computed(
  () => backupPassword.value.length >= MIN_BACKUP_PASSWORD && backupRepeat.value === backupPassword.value,
)
const backupWhat = computed(() => {
  const b = proposal.value.backup
  return b ? (b.coll ? `${b.db}.${b.coll}` : b.db) : ''
})
const tabs = useTabsStore()
const jobs = useJobsStore()
function openBackupJob(id: string): void {
  jobs.focus(id)
  openJobsTab(tabs)
}
/** Review of C4 (nit): Enter in the backup's password fields starts it, never from their own buttons. */
function backupEnter(event: KeyboardEvent): void {
  if (!(event.target instanceof HTMLInputElement)) return
  event.preventDefault()
  void backUp()
}
async function backUp(): Promise<void> {
  if (!backupReady.value || backingUp.value || deciding.value) return
  startingBackup.value = true
  backupError.value = null
  try {
    const result = await store.decide(props.step, {
      decision: 'backup',
      backupPassword: backupPassword.value,
    })
    if (result.state === 'error') backupError.value = words.reason(result.reason)
    else {
      if (result.state === 'backing_up') startedJob.value = result.job
      backupPassword.value = ''
      backupRepeat.value = ''
    }
  } catch (e) {
    const reason =
      e instanceof ApiError
        ? ((e.details as { reason?: string } | undefined)?.reason ?? e.code)
        : 'unreachable'
    backupError.value = words.reason(reason)
  } finally {
    startingBackup.value = false
  }
}

const guard = useConfirmArming({ active: () => !deciding.value, submit: () => void answer('confirm') })
const { armed, arming, pointerOnto, confirmClick } = guard
onMounted(() => guard.reset())
// Review of C4 (M4): once the backup ends, Confirm waits its moment again (the card moved under it).
watch(backingUp, (now, before) => {
  if (before && !now) guard.reset()
})
/**
 * Second re-review (minor 2): Enter in a password field confirms, as in the typed field — never
 * from the field's own buttons (show, copy, generate), which keep their Enter.
 */
function passwordEnter(event: KeyboardEvent): void {
  if (!(event.target instanceof HTMLInputElement)) return
  event.preventDefault()
  guard.formSubmit()
}

/** A schedule's next runs, in its own zone where it has one, the zone named. */
function runFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  const plain = { dateStyle: 'medium', timeStyle: 'short' } as const
  if (!timeZone) return new Intl.DateTimeFormat(locale.value, plain)
  try {
    return new Intl.DateTimeFormat(locale.value, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    })
  } catch {
    // A zone this browser does not know: its own, named (third review of A4, minor 3).
    return new Intl.DateTimeFormat(locale.value, { ...plain, timeStyle: 'long' })
  }
}
/** What the app's preview found, in words. */
const previewLines = computed(() => {
  const p = proposal.value.preview ?? {}
  const tool = props.step.tool
  const out: string[] = []
  if (p.databaseExists === false && props.step.place?.db)
    out.push(t('ai.agent.preview.newDatabase', { db: props.step.place.db }))
  if (tool === 'insert_documents') {
    if (p.documents !== undefined)
      out.push(t('ai.agent.preview.insert', { n: count(p.documents) }, p.documents))
    if (p.exists === false) out.push(t('ai.agent.preview.newCollection'))
  }
  if (p.matched !== undefined)
    out.push(t('ai.agent.preview.matched', { n: count(p.matched), total: count(p.total ?? 0) }, p.matched))
  if (tool === 'drop_collection' && p.documents !== undefined)
    out.push(t('ai.agent.preview.lost', { n: count(p.documents) }, p.documents))
  if (tool === 'drop_database')
    out.push(
      t('ai.agent.preview.lostDatabase', {
        collections: count(p.collections ?? 0),
        documents: count(p.documents ?? 0),
      }),
    )
  // Security review of W6.3 (I3): a TTL index deletes what is already past its age within a minute.
  if (p.expiring !== undefined) out.push(t('ai.agent.preview.expiring', { n: count(p.expiring) }, p.expiring))
  // Design 2026-10-25 (B1): the backups a schedule's change removes now, confirmed with it.
  if (p.removals) out.push(t('ai.agent.preview.removals', { n: count(p.removals) }, p.removals))
  // B4: a user dropped holds roles that go with it.
  if (tool === 'drop_user' && p.roles)
    out.push(t('ai.agent.preview.userRoles', { n: count(p.roles) }, p.roles))
  // Design 2026-10-25 (C3): validation rules — what they would refuse now, what they replace.
  if (tool === 'set_validator') {
    if (p.removes) out.push(t('ai.agent.preview.removesRules'))
    else {
      if (p.failing !== undefined)
        out.push(
          p.failingAtLeast
            ? t('ai.agent.preview.failingAtLeast', { n: count(p.failing) }, p.failing)
            : t('ai.agent.preview.failing', { n: count(p.failing) }, p.failing),
        )
      if (p.replaces) out.push(t('ai.agent.preview.replacesRules'))
      if (p.failingUnknown) out.push(t('ai.agent.preview.failingUnknown'))
    }
  }
  // Review of C3 (M8): a level or an action other than the rules had.
  if (tool === 'set_validator') {
    if (typeof p.level === 'string')
      out.push(
        t('ai.agent.preview.levelChange', {
          level: t(`ai.agent.preview.levels.${p.level}`),
          was: t(`ai.agent.preview.levels.${p.levelWas ?? 'strict'}`),
        }),
      )
    if (typeof p.action === 'string')
      out.push(
        t('ai.agent.preview.actionChange', {
          action: t(`ai.agent.preview.actions.${p.action}`),
          was: t(`ai.agent.preview.actions.${p.actionWas ?? 'error'}`),
        }),
      )
  }
  // Review of C3b (nit): the views a rename leaves reading nothing.
  if (tool === 'rename_collection' && p.viewsLeft)
    out.push(t('ai.agent.preview.viewsLeft', { n: count(p.viewsLeft) }, p.viewsLeft))
  // Design 2026-10-25 (C3): a copy — how many go, into what, as the person sees it.
  if (tool === 'copy_collection') {
    if (p.documents !== undefined)
      out.push(
        p.documentsAtLeast
          ? t('ai.agent.preview.copiedAtLeast', { n: count(p.documents) }, p.documents)
          : p.documentsAbout
            ? t('ai.agent.preview.copied', { n: count(p.documents) }, p.documents)
            : t('ai.agent.preview.copiedExactly', { n: count(p.documents) }, p.documents),
      )
    out.push(
      p.targetExists
        ? t(
            'ai.agent.preview.copyInto',
            {
              n: count(p.targetDocuments ?? 0),
              mode: t(`ai.agent.preview.copyMode.${p.mode ?? 'insert'}`),
            },
            p.targetDocuments ?? 0,
          )
        : t('ai.agent.preview.copyNew'),
    )
    if (p.masked) out.push(t('ai.agent.preview.copyMasked'))
  }
  // Design 2026-10-25 (C1): an export — how many documents go, and where the file is.
  if (tool === 'export_documents') {
    if (p.documents !== undefined)
      out.push(
        p.documentsAtLeast
          ? t('ai.agent.preview.exportedAtLeast', { n: count(p.documents) }, p.documents)
          : p.documentsAbout
            ? t('ai.agent.preview.exportedAbout', { n: count(p.documents) }, p.documents)
            : t('ai.agent.preview.exported', { n: count(p.documents) }, p.documents),
      )
    // Review of C1 (M6, nit 8): the file as it is written — its format by name, compressed or not.
    if (typeof p.format === 'string')
      out.push(
        t('ai.agent.preview.exportFormat', {
          format:
            (FORMAT_NAMES[p.format] ?? p.format) +
            (p.dialect ? ` (${DIALECT_NAMES[p.dialect] ?? p.dialect})` : ''),
        }) + (p.compressed ? ` ${t('ai.agent.preview.exportCompressed')}` : ''),
      )
  }
  // Design 2026-10-25 (B3): the operation a kill stops.
  if (tool === 'kill_operation' && p.operation) {
    // Review of B3 (nit): its kind in words, and none of a namespace where it has none.
    const op = te(`ai.agent.opKind.${p.operation}`) ? t(`ai.agent.opKind.${p.operation}`) : p.operation
    const secs = count(p.secsRunning ?? 0)
    out.push(
      p.namespace
        ? t('ai.agent.preview.killOperation', { op, ns: p.namespace, secs })
        : t('ai.agent.preview.killOperationNoNs', { op, secs }),
    )
  }
  // Review of B1: a paused schedule's runs wait; a deleted one's backups stay.
  if (p.paused) out.push(t('ai.agent.preview.pausedSchedule'))
  if (p.backupsStay) out.push(t('ai.agent.preview.backupsStay'))
  if (tool === 'restore_backup') {
    // Design 2026-10-25 (B2): what a restore writes, and what it overwrites.
    if (p.namespaces !== undefined)
      out.push(t('ai.agent.preview.restore', { n: count(p.namespaces) }, p.namespaces))
    if (p.existing) out.push(t('ai.agent.preview.existing', { n: count(p.existing) }, p.existing))
    if (p.lost) out.push(t('ai.agent.preview.overwritten', { n: count(p.lost) }, p.lost))
    // Review of B2 (M1, M2, M9): a count not known, what is left out, what the plan warns of, whence.
    if (p.lostUnknown) out.push(t('ai.agent.preview.overwrittenUnknown'))
    if (p.skipped) out.push(t('ai.agent.preview.skipped', { n: count(p.skipped) }, p.skipped))
    for (const w of p.warnings ?? [])
      // Fourth review of B2 (I2): which targets are capped, and what that does to their own documents.
      if (w === 'capped' && p.capped?.length) {
        // Fifth review (M-1, nit): one or more, each quoted (a name may hold a comma), listed.
        const names = new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(
          p.capped.map((n) => `“${n}”`),
        )
        out.push(
          p.cappedMore
            ? t('ai.agent.preview.restoreWarn.cappedMore', { names, n: count(p.cappedMore) })
            : t('ai.agent.preview.restoreWarn.cappedNames', { names }, p.capped.length),
        )
      } else out.push(t(`ai.agent.preview.restoreWarn.${w}`))
    if (p.from) out.push(t('ai.agent.preview.restoreFrom', { connection: p.from }))
    // I1: which backup — two of one name differ in when each was made.
    if (p.made)
      out.push(
        t('ai.agent.preview.restoreMade', {
          at: new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'medium' }).format(
            p.made,
          ),
        }),
      )
  } else if (p.namespaces !== undefined)
    out.push(
      t(
        'ai.agent.preview.backup',
        // Review (minor 1): the format as chosen on the card.
        { n: count(p.namespaces), format: plain.value ? 'gzip' : (p.format ?? '') },
        p.namespaces,
      ),
    )
  // Design 2026-10-25 (A3): where it goes, and when the copy kept here is removed.
  if (p.destinations?.length)
    out.push(
      t(p.deleteLocal ? 'ai.agent.preview.destinationsOnly' : 'ai.agent.preview.destinations', {
        list: p.destinations.join(', '),
      }),
    )
  if (p.expiresInHours !== undefined)
    out.push(t('ai.agent.preview.expires', { n: count(p.expiresInHours) }, p.expiresInHours))
  if (p.words) out.push(p.words)
  // Design 2026-10-25 (A4): what a schedule keeps of its backups.
  if (p.retention)
    out.push(
      t('ai.agent.preview.retention', {
        // Review of A4 (M4): what it keeps, the parts of none left out.
        list: new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(
          (['last', 'daily', 'weekly', 'monthly'] as const)
            .filter((k) => p.retention![k] > 0)
            .map((k) => t(`ai.agent.preview.keep.${k}`, { n: count(p.retention![k]) })),
        ),
      }),
    )
  // Design 2026-10-25 (C7): a report's counts, a rule snoozed or woken, where it is said.
  if (p.counts !== undefined) out.push(t('ai.agent.preview.counts', { n: count(p.counts) }, p.counts))
  if (p.snoozeMinutes !== undefined)
    out.push(
      p.snoozeMinutes === null
        ? t('ai.agent.preview.woken')
        : t('ai.agent.preview.snoozedFor', { n: count(p.snoozeMinutes) }, p.snoozeMinutes),
    )
  if (p.channels) {
    const list = [
      p.channels.inApp ? t('ai.agent.preview.channel.inApp') : null,
      p.channels.email ? t('ai.agent.preview.channel.email') : null,
      ...p.channels.webhooks.map((name) => t('ai.agent.preview.channel.webhook', { name })),
    ].filter((x): x is string => !!x)
    out.push(
      list.length
        ? t('ai.agent.preview.channels', {
            list: new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(list),
          })
        : t('ai.agent.preview.channelsNone'),
    )
  }
  if (p.nextRuns?.length)
    out.push(
      t('ai.agent.preview.nextRuns', {
        // Review of A4 (M2): in the schedule's own zone, named — as its words are.
        list: p.nextRuns.map((ms) => runFormat(p.timeZone).format(ms)).join(', '),
      }),
    )
  return out
})

async function answer(decision: 'confirm' | 'decline'): Promise<void> {
  if (deciding.value) return
  if (decision === 'confirm' && (!armed.value || !ready.value || backingUp.value)) return
  deciding.value = true
  error.value = null
  try {
    const result = await store.decide(props.step, {
      decision,
      ...(decision === 'confirm' && proposal.value.typed ? { confirm: typed.value } : {}),
      ...(decision === 'confirm' && plain.value ? { plain: true as const } : {}),
      ...(decision === 'confirm' && proposal.value.password && !plain.value
        ? { password: password.value }
        : {}),
    })
    if (result.state === 'error') error.value = words.reason(result.reason)
  } catch (e) {
    const reason =
      e instanceof ApiError
        ? ((e.details as { reason?: string } | undefined)?.reason ?? e.code)
        : 'unreachable'
    error.value = words.reason(reason)
    deciding.value = false
    guard.reset()
  }
  password.value = ''
  repeat.value = ''
}
</script>

<template>
  <section
    role="group"
    :aria-labelledby="`${id}-title`"
    :aria-describedby="`${id}-note`"
    class="flex flex-col gap-3 rounded-xl border bg-surface p-3 shadow-xs"
    :class="proposal.destructive ? 'border-danger/40' : 'border-accent/40'"
    data-agent-card
  >
    <header class="flex items-start gap-2">
      <span
        class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full"
        :class="proposal.destructive ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent-fg'"
        aria-hidden="true"
      >
        <TriangleAlert v-if="proposal.destructive" class="size-3.5" />
        <ShieldCheck v-else class="size-3.5" />
      </span>
      <div class="flex min-w-0 flex-col">
        <h3 :id="`${id}-title`" class="text-ui font-semibold text-fg">{{ words.tool(step.tool) }}</h3>
        <p class="truncate font-mono text-small text-fg-muted">
          {{ words.place(step.place, connectionName) }}
        </p>
      </div>
    </header>
    <ul v-if="previewLines.length" class="flex flex-col gap-1 text-small text-fg">
      <li v-for="line in previewLines" :key="line">{{ line }}</li>
    </ul>
    <div class="flex flex-col gap-1">
      <p class="text-small font-medium text-fg-muted">{{ t('ai.agent.card.payload') }}</p>
      <div
        class="max-h-56 overflow-auto rounded-lg bg-subtle p-2"
        tabindex="0"
        :aria-label="t('ai.agent.card.payload')"
      >
        <DsCodeView :text="payloadText" />
      </div>
    </div>
    <div v-if="replacedText" class="flex flex-col gap-1" data-agent-replaced>
      <p class="text-small font-medium text-fg-muted">{{ t('ai.agent.card.replaced') }}</p>
      <div
        class="max-h-40 overflow-auto rounded-lg bg-subtle p-2"
        tabindex="0"
        :aria-label="t('ai.agent.card.replaced')"
      >
        <DsCodeView :text="replacedText" />
      </div>
    </div>
    <DsInput
      v-if="proposal.typed"
      v-model="typed"
      mono
      autocomplete="off"
      :label="t('common.typeToConfirm', { name: proposal.typed })"
      :disabled="deciding"
      data-agent-typed
      @keydown.enter.prevent="guard.formSubmit()"
    />
    <!-- User request 2026-10-26: encrypted, or without a password, as the backup dialog offers them. -->
    <div
      v-if="proposal.plain"
      class="flex flex-col gap-2"
      role="radiogroup"
      :aria-label="t('backup.steps.format')"
      data-agent-format
    >
      <DsChoiceCard
        v-for="f in ['mmbak', 'gzip'] as const"
        :key="f"
        v-model="format"
        :name="`${id}-format`"
        :value="f"
        :title="t(`backup.format.${f}`)"
        :help="t(`backup.format.${f}Help`)"
        :disabled="deciding"
      />
      <p
        v-if="plain && proposal.plain.personal"
        class="flex items-start gap-1.5 text-small text-warning"
        data-agent-plain-personal
      >
        <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{{
          t('ai.agent.card.plainPersonal')
        }}
      </p>
    </div>
    <fieldset
      v-if="proposal.password && !plain"
      :disabled="deciding"
      :aria-describedby="proposal.opening ? undefined : `${id}-password-hint`"
      class="flex flex-col gap-1"
      data-agent-password
      @keydown.enter="passwordEnter"
    >
      <legend class="sr-only">
        {{ proposal.passwordFor === 'user' ? t('ai.agent.card.userPassword') : t('ai.agent.card.password') }}
      </legend>
      <DsInput
        v-if="proposal.opening"
        v-model="password"
        :label="t('ai.agent.card.openPassword')"
        :hint="t('ai.agent.card.openPasswordHint')"
        :icon="Lock"
        mono
        type="password"
        autocomplete="off"
        spellcheck="false"
      />
      <!-- Review of B4 (I2): a user's password with Database Access's field (generate, show, copy), never
           the backup's warning. -->
      <DbPasswordField
        v-else-if="proposal.passwordFor === 'user'"
        v-model="password"
        :label="t('ai.agent.card.userPassword')"
        :maxlength="MAX_DB_PASSWORD"
      />
      <PasswordField v-else v-model:password="password" v-model:repeat="repeat" />
      <!-- Review of B2 (nit): the opening field carries its own hint, as a field does. -->
      <p v-if="!proposal.opening" :id="`${id}-password-hint`" class="text-small text-fg-muted">
        <!-- Design 2026-10-25 (B4): a new MongoDB user's password, said as such. -->
        {{
          proposal.passwordFor === 'user'
            ? t('ai.agent.card.userPasswordHint')
            : t('ai.agent.card.passwordHint', { n: MIN_BACKUP_PASSWORD })
        }}
      </p>
    </fieldset>
    <!-- Design 2026-10-25 (C4): a backup of what the change loses, made first on asking. -->
    <section
      v-if="proposal.backup"
      :aria-labelledby="`${id}-backup`"
      class="flex flex-col gap-2 rounded-lg border border-line p-2.5"
      data-agent-backup
    >
      <p :id="`${id}-backup`" class="flex items-center gap-1.5 text-small font-medium text-fg">
        <DatabaseBackup class="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
        {{ t('ai.agent.card.backup.title', { what: backupWhat }) }}
      </p>
      <template v-if="!backup || backup.state === 'error'">
        <p class="text-small text-fg-muted">
          {{ t('ai.agent.card.backup.hint', { n: MIN_BACKUP_PASSWORD }) }}
        </p>
        <fieldset
          :disabled="backingUp || deciding"
          class="flex flex-col gap-1"
          data-agent-backup-password
          @keydown.enter="backupEnter"
        >
          <legend class="sr-only">{{ t('ai.agent.card.backup.password') }}</legend>
          <PasswordField v-model:password="backupPassword" v-model:repeat="backupRepeat" />
        </fieldset>
        <div class="flex justify-end">
          <DsButton
            size="sm"
            :disabled="!backupReady || backingUp || deciding"
            :loading="startingBackup"
            data-agent-backup-start
            @click="backUp"
          >
            {{ t('ai.agent.card.backup.start') }}
          </DsButton>
        </div>
      </template>
      <!-- Review of C4 (nit): one live region, there from the start, that its words change in. -->
      <p
        role="status"
        class="text-small empty:sr-only"
        :class="backup?.state === 'done' ? 'text-success' : 'text-fg'"
        data-agent-backup-state
      >
        {{
          backingUp
            ? t('ai.agent.card.backup.running')
            : backup?.state === 'done'
              ? t('ai.agent.card.backup.done')
              : ''
        }}
      </p>
      <DsCallout v-if="backup?.state === 'error' || backupError" tone="danger" role="alert">
        {{ backupError ?? words.reason(backup?.reason ?? 'backup_failed') }}
      </DsCallout>
      <div v-if="backup?.job" class="-ml-2 flex">
        <button
          type="button"
          class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          data-agent-backup-job
          @click="openBackupJob(backup.job)"
        >
          <ListChecks class="size-3.5" aria-hidden="true" />{{ t('ai.agent.openJob') }}
        </button>
      </div>
    </section>
    <p :id="`${id}-note`" class="text-small text-fg-subtle">{{ t('ai.agent.card.note') }}</p>
    <DsCallout v-if="error" tone="danger" role="alert">{{ error }}</DsCallout>
    <div class="flex flex-wrap justify-end gap-2">
      <DsButton size="sm" :disabled="deciding" data-agent-decline @click="answer('decline')">{{
        t('ai.agent.card.decline')
      }}</DsButton>
      <DsButton
        size="sm"
        class="relative overflow-hidden"
        :variant="proposal.destructive ? 'danger' : 'primary'"
        :disabled="!armed || !ready || deciding || backingUp"
        :loading="deciding"
        data-agent-confirm
        @pointerenter="pointerOnto"
        @pointermove="pointerOnto"
        @click="confirmClick"
      >
        {{ t('ai.agent.card.confirm') }}
        <!-- Getting ready, not broken: a bar fills while the moment runs (as the app's dialogs). -->
        <span
          v-if="!armed && !deciding"
          :key="arming"
          aria-hidden="true"
          class="confirm-arming absolute inset-x-0 bottom-0 h-0.5 origin-left bg-current opacity-60"
          :style="{ animationDuration: `${confirmGuard.armMs}ms` }"
        />
      </DsButton>
    </div>
  </section>
</template>

<style scoped>
.confirm-arming {
  animation-name: confirm-arming;
  animation-timing-function: linear;
  animation-fill-mode: both;
}
@keyframes confirm-arming {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .confirm-arming {
    animation: none;
    transform: scaleX(1);
  }
}
</style>
