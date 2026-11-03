import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  MIN_GAP_MS,
  RETENTION_PRESETS,
  cadenceProblem,
  compileCadence,
  nextRuns,
  type BackupEngine,
  type BackupFormat,
  type BackupScope,
  type Cadence,
  type CadenceProblem,
  type DumpPlan,
  type RetentionPolicy,
  type ScheduleView,
} from '@mongo-manager/shared/browser'
import { backupApi } from '@/api/backup'

export type CadenceKind = Cadence['kind']

/** Phase 3d-3c spec §1.2: everything the editor edits, flat, so each step binds plain fields. */
export interface ScheduleDraft {
  name: string
  /** The name follows the scope until the user types one. */
  nameTouched: boolean
  connectionId: string
  scope: 'database' | 'collection' | 'server'
  db: string
  coll: string
  /** A database's chosen collections and views; empty: all of them. */
  collections: string[]
  views: boolean
  /** The server's chosen databases; empty: all of them. */
  databases: string[]
  indexes: boolean
  options: boolean
  anonymous: boolean
  /** Final review minor 21: the engine it was saved with (the editor offers the built-in one). */
  engine: BackupEngine
  format: BackupFormat
  kind: CadenceKind
  every: number
  minute: number
  times: string[]
  days: number[]
  weeklyTime: string
  monthDay: number | 'last'
  monthlyTime: string
  expression: string
  timeZone: string
  destinations: string[]
  keepOnServer: boolean
  retention: RetentionPolicy
  /** W4.4: a restore drill every `drillEvery` runs (1–30), when on. */
  drillOn: boolean
  drillEvery: number
}

/** Spec §1.2: the browser's zone is the default. */
export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export function newDraft(opts: { connectionId?: string; db?: string; coll?: string } = {}): ScheduleDraft {
  return {
    name: '',
    nameTouched: false,
    connectionId: opts.connectionId ?? '',
    // From a connection's own Backups card (no database): the whole server.
    // From a collection's (review of the branch, M5): that collection.
    scope: opts.connectionId && !opts.db ? 'server' : opts.db && opts.coll ? 'collection' : 'database',
    db: opts.db ?? '',
    coll: opts.db ? (opts.coll ?? '') : '',
    collections: [],
    views: true,
    databases: [],
    indexes: true,
    options: true,
    anonymous: false,
    engine: 'builtin',
    format: 'mmbak',
    kind: 'daily',
    every: 6,
    minute: 0,
    times: ['02:00'],
    days: [1],
    weeklyTime: '02:00',
    monthDay: 1,
    monthlyTime: '02:00',
    expression: '0 2 * * *',
    timeZone: browserZone(),
    destinations: [],
    keepOnServer: false,
    retention: { ...RETENTION_PRESETS.standard },
    drillOn: false,
    drillEvery: 7,
  }
}

export function draftFrom(s: ScheduleView): ScheduleDraft {
  const d = newDraft({ connectionId: s.connectionId })
  const scope = s.dump.scope
  Object.assign(d, {
    name: s.name,
    nameTouched: true,
    scope: scope.kind,
    indexes: s.dump.indexes,
    options: s.dump.options,
    anonymous: s.dump.anonymous,
    engine: s.dump.engine,
    format: s.format,
    timeZone: s.timeZone,
    destinations: s.destinations.map((x) => x.id),
    keepOnServer: s.keepOnServer,
    retention: { ...s.retention },
    drillOn: s.drill !== null,
    drillEvery: s.drill?.everyRuns ?? 7,
  })
  if (scope.kind !== 'server') d.db = scope.db
  if (scope.kind === 'collection') d.coll = scope.coll
  if (scope.kind === 'database') {
    d.collections = [...(scope.collections ?? [])]
    d.views = scope.views
  }
  if (scope.kind === 'server') d.databases = [...(scope.databases ?? [])]
  const c = s.cadence
  d.kind = c.kind
  if (c.kind === 'hourly') Object.assign(d, { every: c.every, minute: c.minute })
  else if (c.kind === 'daily') d.times = [...c.times]
  else if (c.kind === 'weekly') Object.assign(d, { days: [...c.days], weeklyTime: c.time })
  else if (c.kind === 'monthly') Object.assign(d, { monthDay: c.day, monthlyTime: c.time })
  else d.expression = c.expression
  return d
}

export function cadenceOf(d: ScheduleDraft): Cadence {
  switch (d.kind) {
    case 'hourly':
      return { kind: 'hourly', every: d.every, minute: d.minute }
    case 'daily':
      return { kind: 'daily', times: [...new Set(d.times)] }
    case 'weekly':
      return { kind: 'weekly', days: [...new Set(d.days)].sort((a, b) => a - b), time: d.weeklyTime }
    case 'monthly':
      return { kind: 'monthly', day: d.monthDay, time: d.monthlyTime }
    case 'cron':
      return { kind: 'cron', expression: d.expression.trim() }
  }
}

export function scopeOf(d: ScheduleDraft): BackupScope {
  if (d.scope === 'collection') return { kind: 'collection', db: d.db, coll: d.coll }
  if (d.scope === 'database')
    return {
      kind: 'database',
      db: d.db,
      views: d.views,
      ...(d.collections.length ? { collections: [...d.collections] } : {}),
    }
  return { kind: 'server', ...(d.databases.length ? { databases: [...d.databases] } : {}) }
}

/** The body POST /backup-schedules takes (PATCH takes the same without the connection). */
export function bodyOf(d: ScheduleDraft) {
  return {
    name: d.name.trim(),
    connectionId: d.connectionId,
    dump: {
      scope: scopeOf(d),
      engine: d.engine,
      indexes: d.indexes,
      options: d.options,
      anonymous: d.anonymous,
    },
    format: d.format,
    cadence: cadenceOf(d),
    timeZone: d.timeZone,
    destinations: [...d.destinations],
    keepOnServer: d.keepOnServer,
    retention: { ...d.retention },
    // W4.4: a restore drill every N runs, or none.
    drill: d.drillOn ? { everyRuns: d.drillEvery } : null,
  }
}

/** What counts as a change: a suggested name the user never touched does not. */
export const comparable = (d: ScheduleDraft): string =>
  JSON.stringify({ ...d, name: d.nameTouched ? d.name : '' })

export const scopeReady = (d: ScheduleDraft): boolean =>
  Boolean(d.connectionId) &&
  (d.scope === 'server' || (Boolean(d.db) && (d.scope === 'database' || Boolean(d.coll))))

/** Spec §5 When: the shared rules' verdict and the next five runs in the zone (the same code the server runs). */
export function cadenceState(
  d: ScheduleDraft,
  now: number,
): { problem: CadenceProblem | null; runs: number[] } {
  const cadence = cadenceOf(d)
  const problem = cadenceProblem(cadence, now)
  if (problem && problem.reason !== 'min_gap') return { problem, runs: [] }
  try {
    return { problem, runs: nextRuns(compileCadence(cadence), d.timeZone, now, 5, { minGapMs: MIN_GAP_MS }) }
  } catch {
    return { problem, runs: [] }
  }
}

/**
 * The 3d-3a dump plan of the draft, 300 ms after the last change; a newer request aborts the one in
 * flight. Protection reads whether the scope holds personal data; the summary shows its checks.
 */
export function useSchedulePlan(source: () => ScheduleDraft) {
  const plan = ref<DumpPlan | null>(null)
  const loading = ref(false)
  const error = ref<unknown>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: AbortController | null = null
  const request = computed(() => {
    const d = source()
    if (!scopeReady(d)) return null
    return {
      connectionId: d.connectionId,
      body: {
        scope: scopeOf(d),
        engine: d.engine,
        indexes: d.indexes,
        options: d.options,
        anonymous: d.anonymous,
        format: d.format,
        destinations: [...d.destinations],
      },
    }
  })
  watch(
    request,
    (r) => {
      clearTimeout(timer)
      inflight?.abort()
      inflight = null
      if (!r) {
        plan.value = null
        loading.value = false
        return
      }
      loading.value = true
      timer = setTimeout(
        () =>
          void (async () => {
            const mine = new AbortController()
            inflight = mine
            try {
              // As the schedule will run: what its save accepts is what is offered (second review A).
              const p = await backupApi.dumpPlan(r.connectionId, r.body, {
                signal: mine.signal,
                asScheduled: true,
              })
              if (inflight === mine) {
                plan.value = p
                error.value = null
              }
            } catch (e) {
              if (inflight === mine && !mine.signal.aborted) error.value = e
            } finally {
              if (inflight === mine) {
                loading.value = false
                inflight = null
              }
            }
          })(),
        300,
      )
    },
    { deep: true, immediate: true },
  )
  onBeforeUnmount(() => {
    clearTimeout(timer)
    inflight?.abort()
  })
  // What the schedule's save will judge too: the rules' names (third review, N4).
  const personal = computed(() =>
    plan.value
      ? plan.value.namespaces.some((n) => n.personal.length > 0) || plan.value.scheduledPersonal === true
      : null,
  )
  return { plan, loading, error, personal }
}
