import type { IndexAdvice, JobView, NextActionFacts, NextActionKind } from '@mongo-manager/shared/browser'
import type { Place } from '@/stores/places'

/**
 * completion W6.2: the Overview's next steps, worked out without AI from what the app already
 * knows — alerts firing, jobs that failed in the last day, schedules and live syncs that need a
 * person, the index advice of the database used last (the server reads its slow queries), and the
 * places opened lately that are not open now. Each is a step with a key (a new event gets a new key,
 * so a dismissal never hides the next one), a score, the facts the AI may be given (names and
 * counts only) and what it opens.
 */
export type StepTarget =
  | { to: 'alerts' }
  | { to: 'jobs'; jobId: string }
  | { to: 'schedules' }
  | { to: 'liveSyncs' }
  | {
      to: 'createIndex'
      connectionId: string
      db: string
      coll: string
      key: Array<[string, number | string]>
    }
  | { to: 'performance'; connectionId: string }
  | { to: 'place'; place: Place }

export interface Step {
  key: string
  kind: NextActionKind
  score: number
  facts: Omit<NextActionFacts, 'id' | 'kind'>
  target: StepTarget
}

export interface Signals {
  now: number
  firing: ReadonlyArray<{ id: string; connectionId: string | null }>
  jobs: readonly JobView[]
  /** The viewer's schedules and live syncs that need a person. */
  schedules: number
  liveSyncs: number
  /** Places opened lately, newest first; those open in a tab now. */
  recent: readonly Place[]
  open: ReadonlySet<string>
  /** The index advice of the database used last, when the user may watch its server. */
  advice: {
    connectionId: string
    db: string
    advice: IndexAdvice
    /** Review minor 3: the user may create indexes there (indexes:write); else no Create index step. */
    canCreate: boolean
  } | null
}

/**
 * Review I2: a step's key — its kind and a short hash of what makes it this step (alert ids, a
 * namespace, a place). Fixed in length, so a dismissal always fits the dashboard's limits, however
 * many alerts fire or however long a name is.
 */
export function stepKey(kind: string, raw: string): string {
  // cyrb53: a fast 53-bit string hash (public domain), shown in base 36.
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${kind.slice(0, 16)}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}

/** How many steps the widget shows. */
export const MAX_STEPS = 5
const DAY = 24 * 3_600_000
const MAX_CONTINUE = 2

export function suggest(s: Signals): Step[] {
  const steps: Step[] = []
  if (s.firing.length > 0) {
    const ids = s.firing.map((a) => a.id).sort()
    steps.push({
      key: stepKey('alerts', `${ids.join(',')}`),
      kind: 'alerts',
      score: 90,
      facts: { count: ids.length },
      target: { to: 'alerts' },
    })
  }
  const failed = s.jobs
    .filter((j) => j.state === 'failed' && s.now - (j.finishedAt ?? j.startedAt) < DAY)
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
  if (failed.length > 0)
    steps.push({
      key: stepKey('jobs', `${failed[0]!.id}`),
      kind: 'failedJobs',
      score: 80,
      facts: { count: failed.length },
      target: { to: 'jobs', jobId: failed[0]!.id },
    })
  if (s.liveSyncs > 0)
    steps.push({
      key: stepKey('liveSyncs', `${s.liveSyncs}`),
      kind: 'liveSyncs',
      score: 75,
      facts: { count: s.liveSyncs },
      target: { to: 'liveSyncs' },
    })
  if (s.schedules > 0)
    steps.push({
      key: stepKey('schedules', `${s.schedules}`),
      kind: 'schedules',
      score: 70,
      facts: { count: s.schedules },
      target: { to: 'schedules' },
    })
  const advice = s.advice
  const top = advice?.advice.suggestions[0]
  if (advice && top) {
    const dot = top.ns.indexOf('.')
    const db = top.ns.slice(0, dot)
    const coll = top.ns.slice(dot + 1)
    const fields = top.key.map(([f]) => f)
    if (advice.canCreate)
      steps.push({
        key: stepKey('index', `${advice.connectionId}:${top.ns}:${JSON.stringify(top.key)}`),
        kind: 'createIndex',
        score: 55 + Math.min(10, top.count),
        facts: { connectionId: advice.connectionId, db, coll, fields, count: top.count },
        target: { to: 'createIndex', connectionId: advice.connectionId, db, coll, key: top.key },
      })
    const slow = advice.advice.suggestions.reduce((n, x) => n + x.count, 0)
    steps.push({
      key: stepKey('slow', `${advice.connectionId}:${advice.db}:${slow}`),
      kind: 'slowQueries',
      score: 50,
      facts: { connectionId: advice.connectionId, db: advice.db, count: slow },
      target: { to: 'performance', connectionId: advice.connectionId },
    })
  }
  s.recent
    .filter((p) => !s.open.has(p.key))
    .slice(0, MAX_CONTINUE)
    .forEach((place, i) =>
      steps.push({
        key: stepKey('continue', `${place.key}`),
        kind: 'continue',
        score: 40 - i,
        facts: {
          connectionId: place.params.connectionId!,
          ...(place.params.db ? { db: place.params.db } : {}),
          ...(place.params.coll ? { coll: place.params.coll } : {}),
        },
        target: { to: 'place', place },
      }),
    )
  return steps.sort((a, b) => b.score - a.score)
}

/** The steps shown: the dismissed left out, at most five. */
export const visible = (steps: readonly Step[], dismissed: readonly string[], max = MAX_STEPS): Step[] =>
  steps.filter((s) => !dismissed.includes(s.key)).slice(0, max)

/** What the AI is given of the steps shown: an id each, the kind, names and counts. */
export const factsOf = (steps: readonly Step[]): NextActionFacts[] =>
  steps.map((s, i) => ({ id: `a${i}`, kind: s.kind, ...s.facts }))

/**
 * The steps in the AI's order (those it did not place keep their own order, after), each with the
 * title it gave, if any.
 */
export function ordered(
  steps: readonly Step[],
  answer: { order: readonly string[]; titles: Readonly<Record<string, string>> } | null,
): Array<{ step: Step; title: string | null }> {
  const byId = new Map(steps.map((s, i) => [`a${i}`, s]))
  if (!answer) return steps.map((step) => ({ step, title: null }))
  const first = answer.order.flatMap((id) => {
    const step = byId.get(id)
    return step ? [{ step, title: answer.titles[id] ?? null }] : []
  })
  const placed = new Set(first.map((f) => f.step))
  const titleOf = (step: Step) => {
    const id = [...byId].find(([, s]) => s === step)?.[0]
    return id ? (answer.titles[id] ?? null) : null
  }
  return [...first, ...steps.filter((s) => !placed.has(s)).map((step) => ({ step, title: titleOf(step) }))]
}
