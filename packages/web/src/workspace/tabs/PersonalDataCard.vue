<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient, type Query } from '@tanstack/vue-query'
import { ChevronsUpDown, Plus, RotateCw, Trash2 } from 'lucide-vue-next'
import {
  MAX_PERSONAL_RULES,
  PersonalRuleSchema,
  formatRule,
  matchesAny,
  ruleSegments,
  type PersonalRule,
} from '@mongo-manager/shared/browser'
import { personalFieldKeys, personalFieldsApi } from '@/api/personalFields'
import { connectionsApi, queryKeys, type CollectionInfo, type DatabaseList } from '@/api/connections'
import { documentKeys, documentsApi } from '@/api/documents'
import { ApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { rulesChanged } from '@/masking/rulesEpoch'
import { useToastStore } from '@/stores/toasts'
import { useSessionStore } from '@/stores/session'
import { firstMeeting, inLane } from './personalSaveLane'
import DsButton from '@/ds/DsButton.vue'
import DsCard from '@/ds/DsCard.vue'
import DsCombobox from '@/ds/DsCombobox.vue'
import DsDataTable from '@/ds/DsDataTable.vue'
import DsIconButton from '@/ds/DsIconButton.vue'
import DsSwitch from '@/ds/DsSwitch.vue'
import type { DsOption } from '@/ds/menu'
import type { DsColumn } from '@/ds/table'
/**
 * Phase 3b spec §2.1: the fields of this connection that hold personal data. A user granted
 * "cannot see personal data" sees their values as ***; in local mode the local user does too.
 * User request 2026-10-24: a rule names a database, a collection and a field that exist — each
 * picked from what the server holds (the fields from a sample of the collection's documents), none
 * typed — and each change is saved at once. In team mode each administrator may hide the values
 * from themselves too.
 */
const props = defineProps<{
  connection: { id: string; name: string }
  /**
   * User request 2026-10-23/24: one database's rules (its Personal data tab) or one collection's:
   * only those are shown and added, and the connection's wider rules that reach them are shown as theirs.
   */
  scope?: { db: string; coll?: string }
  /** Research 2026-10-28: fields a plugin suggested as personal data here (a collection's card). */
  suggested?: { by: string; fields: string[] } | null
}>()
const emit = defineEmits<{ dismissSuggested: [] }>()
const { t } = useI18n()
const toasts = useToastStore()
const session = useSessionStore()
const queryClient = useQueryClient()
const rulesKey = computed(() => personalFieldKeys.rules(props.connection.id))
const query = useQuery({
  queryKey: rulesKey,
  queryFn: () => personalFieldsApi.get(props.connection.id),
})
const level = computed<'connection' | 'database' | 'collection'>(() =>
  !props.scope ? 'connection' : props.scope.coll === undefined ? 'database' : 'collection',
)
const local = computed(() => session.status?.mode === 'local')
/** Review of the Monitoring redesign (I-3): nothing is offered to change until the rules are read. */
const loaded = computed(() => query.data.value !== undefined)
const stored = computed(() => query.data.value?.rules ?? [])

/** A rule as its parts: `a.b` + `c` is not `a` + `b.c` (review of the tabs, M4). */
const partsOf = (r: PersonalRule) => JSON.stringify([r.db, r.coll, r.field])
/** A change, with the connection it was made on (fourth review, n2). */
type Change = ({ add: PersonalRule } | { adds: PersonalRule[] } | { remove: PersonalRule }) & { on: string }
/** Rules a change adds: one, or (a plugin's suggestion added at once) several in one save. */
const addedBy = (c: Change): PersonalRule[] => ('add' in c ? [c.add] : 'adds' in c ? c.adds : [])
const apply = (list: PersonalRule[], c: Change): PersonalRule[] =>
  'remove' in c
    ? list.filter((r) => partsOf(r) !== partsOf(c.remove))
    : addedBy(c).reduce((out, a) => (out.some((r) => partsOf(r) === partsOf(a)) ? out : [...out, a]), list)
/** Changes not saved yet, shown as made: each is saved in turn, on the rules as stored then. */
const pending = ref<Change[]>([])
/** The changes made on the connection shown (a card shown for another shows none of them). */
const pendingHere = computed(() => pending.value.filter((c) => c.on === props.connection.id))
const rules = computed(() => pendingHere.value.reduce(apply, stored.value))

const own = (r: PersonalRule) =>
  !props.scope || (r.db === props.scope.db && (props.scope.coll === undefined || r.coll === props.scope.coll))
/** The connection's rules that reach this database or collection without naming it (a `*`). */
const inheritedRules = computed(() => {
  const s = props.scope
  if (!s) return []
  return rules.value.filter(
    (r) =>
      !own(r) &&
      (r.db === '*' || r.db === s.db) &&
      (s.coll === undefined || r.coll === '*' || r.coll === s.coll),
  )
})
const inherited = computed(() => inheritedRules.value.map(formatRule))
const inheritedId = useId()
/** A rule's name where it is shown: what the scope does not already say. */
const nameIn = (r: PersonalRule) =>
  level.value === 'collection' ? r.field : level.value === 'database' ? `${r.coll}.${r.field}` : formatRule(r)
const ruleColumns = computed<DsColumn[]>(() => [
  ...(level.value === 'connection' ? [{ key: 'db', label: t('personalData.column.db'), mono: true }] : []),
  ...(level.value !== 'collection'
    ? [{ key: 'coll', label: t('personalData.column.coll'), mono: true }]
    : []),
  { key: 'field', label: t('personalData.column.field'), mono: true },
])
const ruleRows = computed(() =>
  rules.value.filter(own).map((r) => ({ ...r, key: partsOf(r), saving: isPending(r) })),
)
type RuleRow = (typeof ruleRows.value)[number]
const isPending = (r: PersonalRule) =>
  pendingHere.value.some((c) =>
    ('remove' in c ? [c.remove] : addedBy(c)).some((x) => partsOf(x) === partsOf(r)),
  )

// What a new rule names: the scope's own parts, the rest picked.
const pickedDb = ref('')
const pickedColl = ref('')
const db = computed(() => props.scope?.db ?? pickedDb.value)
const coll = computed(() => props.scope?.coll ?? pickedColl.value)
watch(pickedDb, () => (pickedColl.value = ''))

const databases = useQuery({
  queryKey: computed(() => queryKeys.databases(props.connection.id)),
  queryFn: () => connectionsApi.databases(props.connection.id),
  enabled: computed(() => level.value === 'connection'),
})
/** A name `*` is a rule's wildcard: picked, it would make a rule over every database or collection. */
const nameable = (name: string) => name !== '*'
const dbItems = computed<DsOption[]>(() =>
  (databases.data.value?.databases ?? [])
    .filter((d) => nameable(d.name))
    .map((d) => ({ value: d.name, label: d.name })),
)
const collections = useQuery({
  queryKey: computed(() => queryKeys.collections(props.connection.id, db.value)),
  queryFn: () => connectionsApi.collections(props.connection.id, db.value),
  enabled: computed(() => level.value !== 'collection' && db.value !== ''),
})
// A view holds no data of its own: its source's rules reach it (the server follows views); MongoDB's
// own collections (system.profile, system.views…) hold no one's data.
const collItems = computed<DsOption[]>(() =>
  (collections.data.value ?? [])
    .filter((c) => c.type !== 'view' && nameable(c.name) && !c.name.startsWith('system.'))
    .map((c) => ({ value: c.name, label: c.name })),
)

/** The fields a sample of the collection's documents holds, as a rule names them. */
const SAMPLE = 1_000
const SAMPLE_MS = 10_000
const target = computed(() => ({ connectionId: props.connection.id, db: db.value, coll: coll.value }))
/** Read once its picker opens, not for every collection only passed on the way (e2e 12, 2026-10-24). */
const wantFields = ref(false)
watch(target, () => (wantFields.value = false))
const hasSuggestion = computed(() => !!props.suggested && level.value === 'collection')
const sample = useQuery({
  queryKey: computed(() => documentKeys.schema(target.value, SAMPLE)),
  queryFn: ({ signal }) => documentsApi.schema(target.value, SAMPLE, signal, SAMPLE_MS),
  // Research 2026-10-28: read too when a plugin suggested fields, to offer only those it holds.
  enabled: computed(
    () => (wantFields.value || hasSuggestion.value) && loaded.value && db.value !== '' && coll.value !== '',
  ),
  staleTime: 10 * 60_000,
  retry: false,
})
const fieldItems = computed<DsOption[]>(() => {
  const taken = new Set(
    rules.value.filter((r) => r.db === db.value && r.coll === coll.value).map((r) => r.field),
  )
  const seen = new Set<string>()
  const out: DsOption[] = []
  for (const f of sample.data.value?.fields ?? []) {
    // Arrays are transparent to a rule: `items[].sku` is named `items.sku`.
    const keys = f.keys.filter((k): k is string => k !== null)
    // A key with a dot or starting with $ is no part of a path a rule can name: joined, `a.b` would
    // name another field (a, then b); a key `*` or `**` would be read as a wildcard.
    const plain = (k: string) => !k.includes('.') && !k.startsWith('$') && k !== '*' && k !== '**'
    if (keys.length === 0 || !keys.every(plain)) continue
    const field = keys.join('.')
    if (seen.has(field) || taken.has(field)) continue
    if (!PersonalRuleSchema.safeParse({ db: db.value, coll: coll.value, field }).success) continue
    seen.add(field)
    const type = Object.entries(f.types).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]?.[0]
    out.push({ value: field, label: field, ...(type ? { hint: type } : {}) })
  }
  return out
})
function openFields(): void {
  wantFields.value = true
  // retry: false, so a failure stays until asked again: opening the picker asks (review minor 7).
  if (sample.isError.value) void sample.refetch()
}
const fieldEmpty = computed(() =>
  sample.isError.value
    ? t('personalData.pick.fieldsFailed')
    : sample.isFetching.value
      ? t('personalData.pick.fieldsLoading')
      : t('personalData.pick.noFields'),
)

const error = ref<string | null>(null)
/** The rule last added here, and a wider rule that already hides its field (nit 14). */
const lastAdded = ref<PersonalRule | null>(null)
const covered = computed(() => {
  const added = lastAdded.value
  if (!added || !rules.value.some((r) => partsOf(r) === partsOf(added))) return null
  const wider = rules.value.find(
    (r) =>
      partsOf(r) !== partsOf(added) &&
      r.field === added.field &&
      (r.db === '*' || r.db === added.db) &&
      (r.coll === '*' || r.coll === added.coll),
  )
  return wider ? formatRule(wider) : null
})

function add(field: string): void {
  if (!loaded.value) return
  const parsed = PersonalRuleSchema.safeParse({ db: db.value, coll: coll.value, field })
  if (!parsed.success) return void (error.value = t('personalData.invalid'))
  if (rules.value.some((r) => partsOf(r) === partsOf(parsed.data)))
    return void (error.value = t('personalData.duplicate'))
  if (rules.value.length >= MAX_PERSONAL_RULES)
    return void (error.value = t('personalData.full', { max: MAX_PERSONAL_RULES }))
  error.value = null
  lastAdded.value = parsed.data
  change({ add: parsed.data })
}
const remove = (r: PersonalRule) => change({ remove: r })

/**
 * The suggested fields no rule hides yet — this collection's, or a wider one (`*.*.email`) — each
 * added with the card's own save. Offered only when a sample of the collection holds it: a name a
 * plugin made up (an invisible character in it) never becomes a rule that hides nothing (review I1).
 */
const sampledFields = computed(() => {
  const seen = new Set<string>()
  for (const f of sample.data.value?.fields ?? []) {
    const keys = f.keys.filter((k): k is string => k !== null)
    // As the picker names a field: a key with a dot ("a.b" is no path a, b), a $ or a wildcard is none.
    const plain = (k: string) => !k.includes('.') && !k.startsWith('$') && k !== '*' && k !== '**'
    if (keys.length && keys.every(plain)) seen.add(keys.join('.'))
  }
  return seen
})
const suggestedLeft = computed(() => {
  const s = props.suggested
  if (!s || level.value !== 'collection') return []
  const here = rules.value
    .filter((r) => (r.db === '*' || r.db === db.value) && (r.coll === '*' || r.coll === coll.value))
    .map((r) => ruleSegments(r.field))
  return s.fields.filter((field) => !matchesAny(here, field.split('.')))
})
/** Whether a suggested field is one the sample holds: yes, no, or not known yet. */
const seenState = (field: string): 'seen' | 'unseen' | 'checking' | 'failed' =>
  sample.isError.value
    ? 'failed'
    : !sample.data.value
      ? 'checking'
      : sampledFields.value.has(field)
        ? 'seen'
        : 'unseen'
const suggestedSeen = computed(() => suggestedLeft.value.filter((f) => seenState(f) === 'seen'))
/** Rules that still fit (200 at most): Add all adds no more. */
const room = computed(() => Math.max(0, MAX_PERSONAL_RULES - rules.value.length))
/** All the suggested fields the sample holds, in one save (review I6: one change, not one each). */
function addSuggested(): void {
  if (!loaded.value) return
  const fields = suggestedSeen.value.slice(0, room.value)
  const adds = fields.flatMap((field) => {
    const parsed = PersonalRuleSchema.safeParse({ db: db.value, coll: coll.value, field })
    return parsed.success ? [parsed.data] : []
  })
  if (!adds.length) return void (error.value = t('personalData.full', { max: MAX_PERSONAL_RULES }))
  error.value =
    suggestedSeen.value.length > adds.length ? t('personalData.full', { max: MAX_PERSONAL_RULES }) : null
  change({ adds })
}
const suggestedId = useId()
const suggestedEl = ref<HTMLElement | null>(null)
// The section opened on a plugin's suggestion: the focus goes to it, which names it.
watch(
  () => (props.suggested && loaded.value ? props.suggested : null),
  (s) => {
    if (s) void nextTick(() => suggestedEl.value?.focus({ preventScroll: false }))
  },
  { immediate: true },
)

const saving = ref(false)
/** The connections a change was saved on: the status line speaks of the one shown (last review). */
const savedOn = ref(new Set<string>())
const savingHere = computed(() => pendingHere.value.length > 0)
const savedHere = computed(() => savedOn.value.has(props.connection.id))
function markSaved(id: string, saved: boolean): void {
  const next = new Set(savedOn.value)
  if (saved) next.add(id)
  else next.delete(id)
  savedOn.value = next
}
function change(made: { add: PersonalRule } | { adds: PersonalRule[] } | { remove: PersonalRule }): void {
  const c: Change = { ...made, on: props.connection.id }
  pending.value = [...pending.value, c]
  if (!saving.value) void saveAll()
}
/** Leaving the page while changes wait to be saved asks first: the rule meant to hide data is in them. */
function holdPage(event: BeforeUnloadEvent): void {
  event.preventDefault()
  event.returnValue = ''
}
/**
 * The changes in turn. Its card may go meanwhile (its tab closed, another section shown): what was
 * asked is saved all the same — the rules are read from the query cache, not from the card — and
 * the page is held until it is (second review, minor 1).
 */
async function saveAll(): Promise<void> {
  saving.value = true
  window.addEventListener('beforeunload', holdPage)
  try {
    while (pending.value.length > 0) {
      const c = pending.value[0]!
      try {
        await commit(c)
      } catch (e) {
        // Not saved: none of the changes made so far on its connection either; the rules as stored
        // are shown again. Another connection's are kept (last review, minor 2). One made while they
        // are read again is saved after (review I2: it was queued, never sent).
        pending.value = pending.value.filter((x) => x.on !== c.on)
        markSaved(c.on, false)
        toasts.push({ kind: 'error', message: describeError(e, t) })
        await readRules(c.on).catch(() => undefined)
        continue
      }
      pending.value = pending.value.slice(1)
      markSaved(c.on, true)
    }
  } finally {
    window.removeEventListener('beforeunload', holdPage)
    saving.value = false
  }
}
type Rules = { rules: PersonalRule[]; hiddenFromMe?: boolean }
/** The rules as stored, read now. */
const readRules = (id = props.connection.id) =>
  queryClient.fetchQuery({
    queryKey: personalFieldKeys.rules(id),
    queryFn: () => personalFieldsApi.get(id),
    staleTime: 0,
  })
/**
 * One change, made on the rules as stored. Rules changed meanwhile (another tab, another admin) are
 * refused by the server (409): they are read again and the change made on those, so none is lost.
 */
function commit(c: Change): Promise<void> {
  // One at a time per connection, whichever card asks (third review, N2); to the connection the
  // change was made on, whatever the card shows when its turn comes (fourth review, n2).
  return inLane(queryClient, c.on, () => commitNow(c, c.on))
}
async function commitNow(c: Change, id: string): Promise<void> {
  const key = personalFieldKeys.rules(id)
  for (let attempt = 0; ; attempt++) {
    const base = (queryClient.getQueryData<Rules>(key) ?? (await readRules(id))).rules
    const next = apply(base, c)
    if (JSON.stringify(next) === JSON.stringify(base)) return
    let saved: { rules: PersonalRule[] }
    try {
      saved = await personalFieldsApi.set(id, next, base)
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409) || attempt >= 2) throw e
      await readRules(id)
      continue
    }
    // Saved: nothing after this calls it otherwise (third review, M1). A read of the rules begun
    // before the save would answer what they were: it is let go (M3).
    await queryClient.cancelQueries({ queryKey: key, exact: true })
    if (queryClient.getQueryData<Rules>(key))
      queryClient.setQueryData<Rules>(key, (old) => ({ ...old, rules: saved.rules }))
    else {
      // Dropped meanwhile: what the server said, and read again for the rest (minor 8).
      queryClient.setQueryData<Rules>(key, { rules: saved.rules })
      void readRules(id).catch(() => undefined)
    }
    break
  }
  // The rules hide values from me — or may: not known (dropped and not read again) counts as
  // hidden (fourth review, n3). Everything shown follows at once, not waited for: the next change
  // need not wait for every view (review minor 9). The switch, once saved, says so here (N1).
  if (local.value || queryClient.getQueryData<Rules>(key)?.hiddenFromMe !== false) void refreshViews(id)
}

/**
 * What a refresh does with each view. The connections and the rules are names: read again, never
 * dropped — dropped, the connection read as gone, its tab fell back to its overview and the card
 * lost its picks (e2e 16, third review M2), or a save in flight was told the rules were gone (M1).
 * The lists of databases and collections are names too, but carry sizes and options the rules hide:
 * kept, without those (fourth review, m1). The rest hold values.
 */
type Kept = 'names' | 'databases' | 'collections' | 'values'
const keptAs = (key: readonly unknown[]): Kept =>
  key[0] !== 'connections'
    ? 'values'
    : key.length === 1 || key[2] === 'personal-fields'
      ? 'names'
      : key[2] === 'databases' && key.length === 3
        ? 'databases'
        : key[2] === 'databases' && key.length === 5 && key[4] === 'collections'
          ? 'collections'
          : 'values'
/** A collection's options that hold no one's data (a validator or a view's pipeline can quote values). */
const PLAIN_OPTIONS = new Set([
  'viewOn',
  'collation',
  'changeStreamPreAndPostImages',
  'capped',
  'size',
  'max',
  'timeseries',
  'expireAfterSeconds',
  'clusteredIndex',
])
/**
 * A list of names without what it carried that the rules can hide — in place, as the state it is
 * in: written as data set anew, a failed read read as a success, and a server that cannot be
 * reached as connected (review of the scrub, I1).
 */
function scrub(q: Query): void {
  const kept = keptAs(q.queryKey)
  const data = q.state.data
  if (data === undefined) return
  if (kept === 'databases') {
    const d = data as DatabaseList
    q.setState({
      data: { ...d, totalSize: null, databases: d.databases.map((x) => ({ ...x, sizeOnDisk: null })) },
    })
  } else if (kept === 'collections') {
    const list = data as CollectionInfo[]
    q.setState({
      data: list.map((c) => ({
        ...c,
        options: Object.fromEntries(Object.entries(c.options ?? {}).filter(([k]) => PLAIN_OPTIONS.has(k))),
      })),
    })
  }
}

/**
 * A read on its way when values are hidden was begun before: what it brings is from before. Met
 * when the refresh begins — not after it waits for the views read again, as one landing meanwhile
 * counted as read anew and kept what the rules hide (ninth review). When it lands, a view is reset
 * (read anew, or emptied where its watchers are paused), a list scrubbed — every size, hidden or not
 * — and read again: at once where it is watched, when next shown where not (tenth review); when it
 * fails or is let go (one let go may put back the state from before a scrub), a list is scrubbed
 * again. Once per read, however many refreshes meet it (seventh review).
 * The read is never let go here: one may be waiting for it, as for whether the server is connected.
 */
function whenItLands(q: Query): void {
  const read = q.promise
  if (!read || !firstMeeting(read)) return
  const values = keptAs(q.queryKey) === 'values'
  void read.then(
    () => {
      if (values) return queryClient.resetQueries({ queryKey: q.queryKey, exact: true })
      scrub(q)
      return queryClient.invalidateQueries({ queryKey: q.queryKey, exact: true })
    },
    () => (values ? undefined : scrub(q)),
  )
}

/**
 * What every view shows follows at once. Not reset: a view shown would lose its data meanwhile
 * (e2e 16, 2026-10-24). So the views kept aside (no one watching) are dropped, so none shows what
 * is hidden now when it comes back (review 2026-10-13, minor 9) — lists scrubbed instead; those
 * watched are read again in place; and any of those the read did not renew (it failed, or its
 * watchers are paused) is reset then, a list scrubbed (second review, minor 2) — told by its count
 * of reads, not a clock (third review, M4). Reads on their way are met at once (whenItLands).
 */
async function refreshViews(id = props.connection.id): Promise<void> {
  // A request on its way learns the rules changed: what it answers is not kept (2026-10-26).
  rulesChanged()
  const cache = queryClient.getQueryCache()
  const rules = JSON.stringify(personalFieldKeys.rules(id))
  const before = new Map<Query, number>()
  for (const q of cache.findAll({ predicate: (q) => keptAs(q.queryKey) !== 'names' })) {
    const watched = q.getObserversCount() > 0
    if (!watched && keptAs(q.queryKey) === 'values') {
      cache.remove(q)
      continue
    }
    // A list no one watches is scrubbed at once: a view opened while the refresh waits shows it so.
    if (!watched) scrub(q)
    else if (q.state.data !== undefined) before.set(q, q.state.dataUpdateCount)
    whenItLands(q)
  }
  // Its own rules are this card's to set (M3): what else names fields is read again.
  await queryClient.invalidateQueries({ predicate: (q) => JSON.stringify(q.queryKey) !== rules })
  const stale = cache.findAll({
    predicate: (q) => before.get(q) === q.state.dataUpdateCount && q.state.data !== undefined,
  })
  await Promise.all(
    stale.map((q) => {
      if (keptAs(q.queryKey) === 'values')
        return queryClient.resetQueries({ queryKey: q.queryKey, exact: true })
      scrub(q)
      // A read on its way (a read again waiting offline, or one begun before met by whenItLands): if
      // it fails or is let go, scrubbed again (eighth review). One begun after brings what the server
      // says may be shown: kept. Left as is: a view whose next page is on its way (offline: until back)
      // still shows the page it had (its placeholder, held by its watcher, not the cache) — values it
      // showed already.
      void q.promise?.catch(() => scrub(q))
    }),
  )
}

/** Team mode, where there are rules: whether the values they name are hidden from me too. */
const selfSwitch = computed(
  () => !local.value && query.data.value?.hiddenFromMe !== undefined && stored.value.length > 0,
)
const switching = ref(false)
/** What was asked, while it is saved: shown as such, and back to what is stored when refused. */
const asked = ref<boolean | null>(null)
const hiddenFromMe = computed({
  get: () => asked.value ?? query.data.value?.hiddenFromMe === true,
  set: (hide: boolean) => void setHiddenFromMe(hide),
})
async function setHiddenFromMe(hide: boolean): Promise<void> {
  switching.value = true
  asked.value = hide
  try {
    await personalFieldsApi.setHiddenFromMe(props.connection.id, hide)
    // Saved: so it reads, whether or not the rules are read again (second review, nit 5).
    const key = personalFieldKeys.rules(props.connection.id)
    if (queryClient.getQueryData<Rules>(key))
      queryClient.setQueryData<Rules>(key, (old) => (old ? { ...old, hiddenFromMe: hide } : old))
    // Every view follows; the switch need not wait for the slowest of them (nit 6).
    void refreshViews()
    toasts.push({
      kind: 'success',
      message: t(hide ? 'personalData.hiddenFromMe' : 'personalData.shownToMe'),
    })
  } catch (e) {
    toasts.push({ kind: 'error', message: describeError(e, t) })
  } finally {
    asked.value = null
    switching.value = false
  }
}

const intro = computed(() => {
  const suffix = local.value ? 'Local' : ''
  if (level.value === 'collection')
    return t(`personalData.introCollection${suffix}`, { name: `${db.value}.${coll.value}` })
  if (level.value === 'database') return t(`personalData.introDatabase${suffix}`, { name: db.value })
  return t(`personalData.intro${suffix}`)
})
const pickerClass =
  'inline-flex h-7 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-ui text-fg hover:border-fg-subtle focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus/20 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60'
</script>

<template>
  <DsCard :title="t('personalData.title')" :count="ruleRows.length || undefined" data-personal-data>
    <div class="flex flex-col gap-3">
      <p class="text-ui text-fg-muted">{{ intro }}</p>
      <!-- Team mode: each administrator's own choice, on every Personal data tab of the connection. -->
      <div v-if="selfSwitch" class="rounded-lg bg-subtle p-3" data-hide-from-me>
        <DsSwitch
          v-model="hiddenFromMe"
          :label="t('personalData.hideFromMe')"
          :hint="t('personalData.hideFromMeHint')"
          :disabled="switching"
        />
      </div>
      <!-- Research 2026-10-28: a plugin's suggestion, saved only field by field on the admin's click. -->
      <div
        v-if="suggested && level === 'collection' && loaded"
        ref="suggestedEl"
        class="flex flex-col gap-2 rounded-lg border border-line bg-subtle p-3"
        role="region"
        tabindex="-1"
        :aria-labelledby="suggestedId"
        data-personal-suggested
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p :id="suggestedId" class="text-ui font-medium text-fg">
            {{ t('personalData.suggested.title', { plugin: suggested.by }) }}
          </p>
          <div class="flex gap-1.5">
            <DsButton v-if="suggestedSeen.length > 1" size="sm" :icon="Plus" @click="addSuggested">{{
              t('personalData.suggested.addAll')
            }}</DsButton>
            <DsButton size="sm" variant="ghost" @click="emit('dismissSuggested')">{{
              t('personalData.suggested.dismiss')
            }}</DsButton>
          </div>
        </div>
        <p class="text-small text-fg-muted">
          {{
            suggestedLeft.length
              ? t('personalData.suggested.hint', { plugin: suggested.by })
              : t('personalData.suggested.done')
          }}
        </p>
        <p v-if="suggestedSeen.length > room" class="text-small text-warning" data-suggested-room>
          {{ t('personalData.suggested.room', { n: room, max: MAX_PERSONAL_RULES }, room) }}
        </p>
        <p
          v-if="sample.data.value?.truncated && suggestedLeft.some((f) => seenState(f) === 'unseen')"
          class="text-small text-fg-muted"
          data-suggested-partial
        >
          {{ t('personalData.suggested.partial') }}
        </p>
        <p v-if="sample.isError.value" class="flex flex-wrap items-center gap-2 text-small text-danger">
          {{ t('personalData.suggested.checkFailed') }}
          <DsButton size="sm" :icon="RotateCw" @click="sample.refetch()">{{ t('common.retry') }}</DsButton>
        </p>
        <ul v-if="suggestedLeft.length" class="flex flex-col gap-1">
          <li
            v-for="field in suggestedLeft"
            :key="field"
            class="flex items-center justify-between gap-2 rounded-md bg-surface px-2 py-1"
            :data-suggested-field="field"
          >
            <span class="truncate font-mono text-small" :title="field">{{ field }}</span>
            <DsButton
              v-if="seenState(field) === 'seen'"
              size="sm"
              :icon="Plus"
              :aria-label="t('personalData.suggested.add', { field })"
              @click="add(field)"
              >{{ t('personalData.suggested.addOne') }}</DsButton
            >
            <span v-else class="shrink-0 text-small text-fg-subtle" data-suggested-state>{{
              t(
                seenState(field) === 'unseen'
                  ? 'personalData.suggested.unseen'
                  : seenState(field) === 'checking'
                    ? 'personalData.suggested.checking'
                    : 'personalData.suggested.notChecked',
              )
            }}</span>
          </li>
        </ul>
      </div>
      <DsDataTable
        dense
        :label="t('personalData.title')"
        :columns="ruleColumns"
        :rows="ruleRows"
        :row-key="(row: RuleRow) => row.key"
        :loading="query.isPending.value && !query.isError.value"
        :loading-label="t('app.loading')"
        :error="!loaded && query.isError.value ? describeError(query.error.value, t) : undefined"
        :actions-label="t('common.actions')"
      >
        <template #retry>
          <DsButton size="sm" :icon="RotateCw" @click="query.refetch()">{{ t('common.retry') }}</DsButton>
        </template>
        <template #cell-db="{ row }">
          <span :title="row.db" data-rule-db-cell>{{ row.db }}</span>
        </template>
        <template #cell-coll="{ row }">
          <span :title="row.coll" data-rule-coll-cell>{{ row.coll }}</span>
        </template>
        <template #cell-field="{ row }">
          <span :title="row.field" data-rule-row>{{ row.field }}</span>
          <span v-if="row.saving" class="ml-2 font-sans text-small text-fg-subtle">{{
            t('personalData.saving')
          }}</span>
        </template>
        <template #actions="{ row }">
          <DsIconButton
            size="sm"
            :icon="Trash2"
            :label="t('personalData.remove', { rule: nameIn(row) })"
            data-rule-remove
            @click="remove(row)"
          />
        </template>
        <template #empty>
          <p
            class="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-ui text-fg-muted"
          >
            {{
              t(
                level === 'collection'
                  ? 'personalData.noneCollection'
                  : level === 'database'
                    ? 'personalData.noneDatabase'
                    : 'personalData.none',
              )
            }}
          </p>
        </template>
      </DsDataTable>
      <div v-if="inherited.length" class="flex flex-col gap-1.5" data-rules-inherited>
        <p :id="inheritedId" class="text-small text-fg-subtle">{{ t('personalData.inherited') }}</p>
        <ul class="flex flex-wrap gap-1.5" :aria-labelledby="inheritedId">
          <li
            v-for="text in inherited"
            :key="text"
            class="rounded-md bg-subtle px-2 py-0.5 font-mono text-small text-fg-muted"
            data-rule-inherited
          >
            {{ text }}
          </li>
        </ul>
      </div>
      <!-- User request 2026-10-24: what a new rule names is picked, never typed; a field picked is saved. -->
      <div
        v-if="loaded"
        class="grid gap-2"
        :class="
          level === 'connection' ? 'sm:grid-cols-3' : level === 'database' ? 'sm:grid-cols-2' : 'sm:max-w-sm'
        "
        data-rule-pickers
      >
        <div v-if="level === 'connection'" class="min-w-0" data-rule-db>
          <DsCombobox
            :label="pickedDb ? t('personalData.pick.dbIs', { name: pickedDb }) : t('personalData.pick.db')"
            :items="dbItems"
            :current="pickedDb"
            :placeholder="t('personalData.pick.find')"
            :empty-text="
              databases.isError.value ? describeError(databases.error.value, t) : t('layout.noMatch')
            "
            :trigger-class="pickerClass"
            @select="pickedDb = $event"
          >
            <template #trigger>
              <span class="truncate font-mono" :class="pickedDb ? '' : 'font-sans text-fg-subtle'">{{
                pickedDb || t('personalData.pick.db')
              }}</span>
              <ChevronsUpDown class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            </template>
          </DsCombobox>
        </div>
        <template v-if="level !== 'collection'">
          <div v-if="db" class="min-w-0" data-rule-coll>
            <DsCombobox
              :label="
                pickedColl ? t('personalData.pick.collIs', { name: pickedColl }) : t('personalData.pick.coll')
              "
              :items="collItems"
              :current="pickedColl"
              :placeholder="t('personalData.pick.find')"
              :empty-text="
                collections.isError.value ? describeError(collections.error.value, t) : t('layout.noMatch')
              "
              :trigger-class="pickerClass"
              @select="pickedColl = $event"
            >
              <template #trigger>
                <span class="truncate font-mono" :class="pickedColl ? '' : 'font-sans text-fg-subtle'">{{
                  pickedColl || t('personalData.pick.coll')
                }}</span>
                <ChevronsUpDown class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
              </template>
            </DsCombobox>
          </div>
          <span
            v-else
            class="inline-flex h-7 items-center rounded-md border border-dashed border-line-strong px-2.5 text-ui text-fg-subtle"
            >{{ t('personalData.pick.coll') }}</span
          >
        </template>
        <div v-if="db && coll" class="min-w-0" data-rule-field>
          <DsCombobox
            :label="t('personalData.pick.field', { name: `${db}.${coll}` })"
            :items="fieldItems"
            :placeholder="t('personalData.pick.findField')"
            :empty-text="fieldEmpty"
            :trigger-class="pickerClass"
            @open="openFields"
            @select="add"
          >
            <template #trigger>
              <span class="inline-flex min-w-0 items-center gap-1.5 text-fg-muted"
                ><Plus class="size-3.5 shrink-0" aria-hidden="true" /><span class="truncate">{{
                  t('personalData.pick.addField')
                }}</span></span
              >
              <ChevronsUpDown class="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            </template>
          </DsCombobox>
        </div>
        <span
          v-else
          class="inline-flex h-7 items-center rounded-md border border-dashed border-line-strong px-2.5 text-ui text-fg-subtle"
          >{{ t('personalData.pick.addField') }}</span
        >
      </div>
      <p v-if="error" class="-mt-1 text-small text-danger" role="alert" data-rule-error>{{ error }}</p>
      <p v-else-if="covered" class="-mt-1 text-small text-fg-subtle" role="status" data-rule-covered>
        {{ t('personalData.coveredBy', { rule: covered }) }}
      </p>
      <p class="text-small text-fg-subtle" role="status" data-rules-status>
        {{
          savingHere
            ? t('personalData.saving')
            : savedHere
              ? t('personalData.savedAuto')
              : t('personalData.auto')
        }}
      </p>
      <!-- Spec 3c §11 risk 13 (W5): what a rule costs restricted users' queries. -->
      <p class="text-small text-fg-subtle" data-rule-cost>{{ t('personalData.cost') }}</p>
    </div>
  </DsCard>
</template>
