<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 Gokhan OZGEZER -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { useWorkspaceDialogs } from '@/stores/workspaceDialogs'
import type { PluginRuntimeView } from '@mongo-manager/shared/browser'
import {
  BACKUP_SYSTEM_DATABASES,
  CollectionNameSchema,
  PersonalRuleSchema,
  ShardKeyAnalysisBodySchema,
  isHiddenChar,
  isSpoofingChar,
} from '@mongo-manager/shared/browser'
import DsSpinner from '@/ds/DsSpinner.vue'
import { ApiError } from '@/api/client'
import { pluginsApi } from '@/api/plugins'
import { connectionsApi, queryKeys } from '@/api/connections'
import { documentKeys, documentsApi, type CollectionTarget } from '@/api/documents'
import { explainError } from '@/api/reasons'
import { usePreferencesStore } from '@/stores/preferences'
import { useToastStore } from '@/stores/toasts'
import { useDialogStore } from '@/stores/dialogs'
import { storageApi } from '@/api/storage'
import { COMPACTING, STORAGE_KEPT_MS, STORAGE_READS } from './storageState'
import { searchIndexesFor } from './searchIndexes'
import { BridgeError, createBridge, type Bridge } from './bridge'
import { isDocumentId } from '@/documents/showDocument'
import { aggregateApi } from '@/api/aggregate'
import { readNdjson } from '@/aggregation/ndjson'
import { assertHandedPipeline, assertNoForbidden, assertReadOnlyPipeline } from './readOnly'
import { askedPlace } from './cells'
import { suggestPersonalIn, useAggregationIn, useQueryIn } from './useIn'
import { decodeValue } from '@/documents/values'
import { appInputIsRecent, watchAppInput } from './appInput'
import { buildDownload, fileName, saveBlob } from './download'
import { validationApi } from '@/api/explain'
import { dataModelApi } from '@/api/dataModel'
import { personalFieldKeys, personalFieldsApi } from '@/api/personalFields'
import { ruleSegments, uiLanguageOf } from '@mongo-manager/shared/browser'
import { LOCALE_TAGS } from '@/i18n'
import { rulesWithoutHidden } from './hiddenRules'
import { formatBytes, formatCount } from '@/format'
import { APP_QUESTION_MS } from './questions'
import type { DataModel } from '@mongo-manager/shared/browser'
import { localized, type ContributionKind } from './store'
import DsCallout from '@/ds/DsCallout.vue'

/**
 * Phase 4b §3: a plugin's page in a sandboxed frame — scripts only, an opaque origin (no cookies, no
 * storage of the app, no reach into its page), loaded through a ticket — and the host side of its
 * bridge: what it may ask, answered through the app's own API as this user (rights and masking
 * apply), a change only after the user confirms it here.
 */
const props = withDefaults(
  defineProps<{
    plugin: PluginRuntimeView
    kind: ContributionKind
    contribution: string
    target?: CollectionTarget | null
    /** The document an action opened the plugin with (canonical EJSON `_id`). */
    documentId?: unknown
    /** The documents' current filter (canonical EJSON), for a collection tab. */
    filter?: Record<string, unknown> | null
    /** A cell renderer's frame: kept out of sight and out of the accessibility tree. */
    hidden?: boolean
    /** A page kept while another tab shows (review I3): out of sight, it acts in nothing. */
    inactive?: boolean
  }>(),
  { target: null, documentId: undefined, filter: null, hidden: false, inactive: false },
)
const emit = defineEmits<{
  'open-document': [id: unknown]
  bridge: [bridge: Bridge | null]
  /** A query or stages were put in the app's own editors (wave 1). */
  applied: []
  /** A collection tab's page asked to stay while another section shows; false once it cannot. */
  keep: [keep: boolean]
}>()
const { t, locale } = useI18n()
const preferences = usePreferencesStore()
const toasts = useToastStore()
const dialogs = useDialogStore()
const name = computed(() => localized(props.plugin.name, locale.value))
/**
 * The plugin as its messages and questions name it: its name and its id (security audit 2026-10-16,
 * M5) — a name alone could read as the app's own.
 */
const who = computed(() => `${name.value} (${props.plugin.id})`)
const { data: connections } = useQuery({ queryKey: queryKeys.connections, queryFn: connectionsApi.list })
const queryClient = useQueryClient()
const workspaceDialogs = useWorkspaceDialogs()

const frame = ref<HTMLIFrameElement | null>(null)
const src = ref<string | null>(null)
const failed = ref<string | null>(null)
const height = ref<number | null>(null)
pluginsApi.ticket(props.plugin.id).then(
  (ticket) => {
    // The contribution is named in the fragment: never sent to the server, read by the page.
    const url = new URL(`${ticket.base}${ticket.entry}`, document.baseURI)
    url.hash = `${props.kind}=${encodeURIComponent(props.contribution)}`
    src.value = url.href
  },
  (e) => {
    failed.value = explainError(e, t)
    emit('keep', false)
  },
)

const MAX_FIND = 1000
/** Documents of another collection a plugin may read at once (wave 2). */
const MAX_FIND_IN = 200
/** The longest change a confirmation shows; reads a frame may make in a minute. */
const MAX_SHOWN = 2000
const READS_PER_MINUTE = 60
/**
 * Plugins wave 3 (spec §1.3): reads of definitions — indexes, validation rules — not documents, in a
 * minute of their own (a database's dictionary is one model read and two such reads a collection).
 */
const DEFINITIONS_PER_MINUTE = 120
/** The longest NDJSON a plugin hands the Import wizard (spec §1.2). */
const MAX_NDJSON = 1_000_000
/** Messages (a toast, a copy) and queries or stages put in the app, a minute (wave 1 review I1, I2). */
const MESSAGES_PER_MINUTE = 5
const USES_PER_MINUTE = 10
/** Documents a plugin may open a minute — and attempts without the user's click (security audit). */
const OPENS_PER_MINUTE = 30
/** A plugin's pipeline: bounded in time, never spilling to disk (wave 1 review M2). */
const AGGREGATE_MAX_MS = 10_000
let toastTimes: number[] = []
let readTimes: number[] = []
let definitionTimes: number[] = []
let useTimes: number[] = []
let openTimes: number[] = []
let confirming = false
/** A ui.useQueryIn waiting for the database's list, and whether the frame is gone (review 2026-10-28). */
let usingIn = false
let gone = false
let declines = 0
/** The plugin's pipeline being read, stopped when the frame goes. */
let aggregating: AbortController | null = null
const stopped = ref(false)
/** At most `max` in the last minute, counted in `times`. */
function within(times: number[], max: number, message: string): number[] {
  const now = Date.now()
  const recent = times.filter((at) => now - at < 60_000)
  if (recent.length >= max) throw new BridgeError('too_many', message)
  recent.push(now)
  return recent
}
function read(): void {
  readTimes = within(readTimes, READS_PER_MINUTE, 'At most 60 reads a minute')
}
function definition(): void {
  definitionTimes = within(definitionTimes, DEFINITIONS_PER_MINUTE, 'At most 120 definition reads a minute')
}
function oneMessage(): void {
  toastTimes = within(toastTimes, MESSAGES_PER_MINUTE, 'At most 5 messages a minute')
}
/** What the user would see happen: never from a frame kept out of sight (a cell renderer). */
function inSight(): void {
  if (props.hidden || props.inactive)
    throw new BridgeError('not_visible', 'A frame out of sight cannot do this')
}
/**
 * What acts in the app on a plugin's word (a copy, a query or stages put in place, a document
 * opened or changed): only right after the user clicked or typed in this plugin's own page, a few
 * times a minute (review I1, I2). Security audit 2026-10-16: the app's activation alone was any
 * click anywhere in it (copying an AI answer's code) — the frame must also hold the focus, which an
 * iframe takes when the user clicks or types in it. `charge` counts the attempt first, refused or
 * not: a plugin trying again and again, waiting for a click elsewhere, spends its minute.
 */
function byUser(charge: () => void): void {
  inSight()
  charge()
  stillByUser(false)
}
/**
 * The user's click still the plugin's: after a wait (a list read), its page in sight, the frame
 * holding the focus and the activation not spent (review 2026-10-28) — never charged again.
 */
function stillByUser(afterWait = true): void {
  if (gone) throw new BridgeError('not_visible', 'A frame out of sight cannot do this')
  inSight()
  const el = frame.value
  if (!el || !document.hasFocus() || document.activeElement !== el)
    throw new BridgeError('no_activation', 'Only right after the user clicks or types in the plugin')
  // The focus still there, the click spent: after a wait, an answer the app waited for came too late.
  if (!navigator.userActivation?.isActive)
    throw new BridgeError(
      'no_activation',
      afterWait
        ? 'The app took too long after the click: click again'
        : 'Only right after the user clicks or types in the plugin',
    )
}
// Also at the app's start (main.ts): the press that opens a plugin comes before its frame.
watchAppInput()
/** The longest start of a text a copy question shows, once its hidden characters are spelled out. */
const COPY_PREVIEW = 80
/** The question waiting for the user, if any: one at a time (a copy, a file, documents). */
let asking: number | null = null
/**
 * Review of the security pass (I4) and its second review: a frame may take the focus without a
 * gesture, so what a plugin asks while a press in the app's own page may have given the activation
 * (appInput.ts) is not done on its word — the app asks the user, naming the plugin and what it
 * wants, and does it on a click of its own button. Wave 3 review: a file saved and documents handed
 * to the Import wizard as well as a copy. One question at a time; it goes when the frame does.
 */
function askUser(message: string, action: string, run: () => Promise<void> | void): Promise<true> {
  if (asking !== null) throw new BridgeError('busy', 'A question is waiting for the user')
  return new Promise((resolve, reject) => {
    // It ends in time even while pointed at (wave 3 second review): before the page gives up.
    let ended = false
    const end = setTimeout(() => {
      ended = true
      if (asking === id) toasts.dismiss(id)
    }, APP_QUESTION_MS)
    const id = toasts.push({
      kind: 'info',
      message,
      timeoutMs: 20_000,
      actions: [
        {
          label: action,
          run: () =>
            void Promise.resolve()
              .then(run)
              .then(
                () => resolve(true),
                (e: unknown) =>
                  reject(e instanceof BridgeError ? e : new BridgeError('failed', 'It could not be done')),
              ),
        },
      ],
      onClose: (reason) => {
        clearTimeout(end)
        asking = null
        // Third review: a question that went unanswered is no "no" (never counted toward a block).
        if (reason === 'timeout' || ended)
          reject(new BridgeError('unanswered', 'The user did not answer in time'))
        else if (reason !== 'action') reject(new BridgeError('declined', 'The user said no'))
      },
    })
    asking = id
  })
}
/** A copy asked for: the plugin named, how much and how it starts (every hidden character spelled out). */
function askToCopy(text: string): Promise<true> {
  const chars = [...text]
  const head = visible(chars.slice(0, COPY_PREVIEW).join('')).replace(/\n/g, '\\n')
  const cut = head.length > COPY_PREVIEW || chars.length > COPY_PREVIEW
  const preview = cut ? `${head.slice(0, COPY_PREVIEW)}…` : head
  return askUser(
    t('plugins.copyAsk', { name: who.value, count: chars.length, preview }),
    t('plugins.copyAction'),
    () =>
      navigator.clipboard.writeText(text).then(
        () => void toasts.push({ kind: 'success', message: t('plugins.copied', { name: who.value }) }),
        () => {
          throw new BridgeError('failed', 'The clipboard is not available')
        },
      ),
  )
}
/** A field name a plugin may change: no control, line-breaking or direction character (review I1). */
const plainField = (name: string) => ![...name].some((c) => isSpoofingChar(c.codePointAt(0)!))
/** Fields a plugin suggests as personal data at once, at most. */
const MAX_SUGGESTED = 50
/**
 * The fields a plugin suggests as personal data (research 2026-10-28): each a plain path of names a
 * rule of its collection may name — no wildcard, no operator, nothing that would read as another
 * name on the page; each once.
 */
function suggestedFields(v: unknown, target: CollectionTarget): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_SUGGESTED)
    throw new BridgeError('bad_params', `fields is a list of 1 to ${MAX_SUGGESTED} field paths`)
  const out: string[] = []
  for (const field of v) {
    if (
      typeof field !== 'string' ||
      // No hidden character either (a zero-width one would make a rule that hides nothing, review I1),
      // and no space around a name.
      [...field].some((c) => isHiddenChar(c.codePointAt(0)!)) ||
      field.split('.').some((s) => s === '*' || s === '**' || s !== s.trim()) ||
      !PersonalRuleSchema.safeParse({ db: target.db, coll: target.coll, field }).success
    )
      throw new BridgeError('bad_params', 'A field is a path of plain names')
    if (!out.includes(field)) out.push(field)
  }
  return out
}
const oneUse = () => void (useTimes = within(useTimes, USES_PER_MINUTE, 'At most 10 a minute'))
const oneOpen = () =>
  void (openTimes = within(openTimes, OPENS_PER_MINUTE, `At most ${OPENS_PER_MINUTE} a minute`))
/**
 * Text with what hides, reverses or shows as nothing spelled out as \uXXXX (security audit
 * 2026-10-16, M2: zero-width, tag and other invisible characters too).
 */
const visible = (text: string) =>
  [...text]
    .map((c) => {
      const code = c.codePointAt(0)!
      return isHiddenChar(code) && c !== '\n' ? `\\u${code.toString(16).padStart(4, '0')}` : c
    })
    .join('')
const plain = (s: string, max: number) =>
  [...s]
    .filter((c) => !isHiddenChar(c.codePointAt(0)!))
    .join('')
    .slice(0, max)
const objectOr = (v: unknown, what: string): Record<string, unknown> | undefined => {
  if (v === undefined) return undefined
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new BridgeError('bad_params', `${what} is an object`)
  return v as Record<string, unknown>
}
const params = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
/**
 * The collection a request is about: the one the plugin was opened on; for a cell renderer (wave 2),
 * a place the app asked it about values in, named in the request — never any other.
 */
const collection = (p?: unknown): CollectionTarget => {
  if (props.target) return props.target
  if (props.hidden) {
    const asked = askedPlace(props.plugin.id, params(p).place)
    if (asked) return asked
  }
  throw new BridgeError('no_collection', 'Not opened on a collection')
}
/**
 * A query a plugin hands the user (ui.useQuery, ui.useQueryIn): its filter, projection and sort,
 * values the editors can show (wave 1 review M11) and nothing the user would not run — no code on
 * the server, no other collection.
 */
function handedQuery(q: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const key of ['filter', 'projection', 'sort'] as const) {
    const v = objectOr(q[key], key)
    if (!v) continue
    try {
      decodeValue(v)
    } catch {
      throw new BridgeError('bad_params', `${key} is not canonical Extended JSON`)
    }
    body[key] = v
  }
  assertNoForbidden(body)
  return body
}

/**
 * The collections of the plugin's database (wave 2): system collections left out, at most 500,
 * kept for 30 seconds. A collection a plugin names must be one of these.
 */
const listed = new Map<string, { at: number; names: Array<{ name: string; type: string }> }>()
async function databaseCollections(target: CollectionTarget): Promise<Array<{ name: string; type: string }>> {
  const where = JSON.stringify([target.connectionId, target.db])
  const known = listed.get(where)
  if (known && Date.now() - known.at < 30_000) return known.names
  const all = await api(() => connectionsApi.collections(target.connectionId, target.db))
  const names = all
    .filter((c) => !c.name.startsWith('system.'))
    .slice(0, 500)
    .map((c) => ({ name: c.name, type: c.type }))
  listed.set(where, { at: Date.now(), names })
  return names
}
/**
 * User request 2026-10-10: whether a plugin's collection is a view — read as any collection, never
 * written, without indexes; a collection the list does not name is taken for a collection (the
 * server refuses a write to a view either way).
 */
async function isView(target: CollectionTarget, forWrite = false): Promise<boolean> {
  const kind = await listedKind(target, forWrite)
  // Unknown (a list that does not name it, or none in time): a view for a write, a collection to be told.
  return kind === undefined ? forWrite : kind === 'view'
}
/**
 * What the database's list says the collection is ("collection", "view"…), or undefined when it
 * does not name it or was not read in time. `fresh`: a list read anew when the cached one does not.
 */
async function listedKind(target: CollectionTarget, fresh = false): Promise<string | undefined> {
  // Review M1: the app's own list of the database (shared with its collection tab, not cut at 500);
  // a write asks for a fresh one when the cached one does not name the collection.
  const kindIn = async (staleTime: number): Promise<string | undefined> => {
    const list = await Promise.race([
      queryClient.fetchQuery({
        queryKey: queryKeys.collections(target.connectionId, target.db),
        queryFn: () => connectionsApi.collections(target.connectionId, target.db),
        staleTime,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow')), VIEW_CHECK_MS)),
    ])
    return list.find((c) => c.name === target.coll)?.type
  }
  try {
    return (await kindIn(30_000)) ?? (fresh ? await kindIn(0) : undefined)
  } catch {
    return undefined
  }
}
/**
 * Plugins wave 3 (spec §1.3): a collection a plugin names — its own, or, with database:read, another
 * of its database as listed (never a path, a system collection or one of another database).
 */
async function namedCollection(
  target: CollectionTarget,
  coll: unknown,
): Promise<{ target: CollectionTarget; view: boolean }> {
  if (coll === undefined || coll === target.coll) return { target, view: await isView(target) }
  if (typeof coll !== 'string' || !coll || coll.length > 255)
    throw new BridgeError('bad_params', 'coll is a collection name')
  if (!props.plugin.permissions.includes('database:read'))
    throw new BridgeError('not_permitted', 'This plugin was not approved for database:read')
  const found = (await databaseCollections(target)).find((c) => c.name === coll)
  if (!found) throw new BridgeError('bad_params', 'No such collection in this database')
  return { target: { connectionId: target.connectionId, db: target.db, coll }, view: found.type === 'view' }
}
/**
 * The database's model (the Database tab's), kept a minute per database (spec §1.3). Wave 3 review:
 * the read itself is kept while it runs, so a plugin asking eight times at once starts one model,
 * not eight holding the user's reads; a failed one is not kept.
 */
const models = new Map<string, { at: number | null; started: number; model: Promise<DataModel> }>()
/**
 * The field paths hidden from this user in the plugin's collection: names only (spec §1.3a). Wave 3
 * review: `null` when they could not be told in time (unknown, never "nothing hidden").
 */
async function hiddenPaths(target: CollectionTarget): Promise<string[][] | null> {
  try {
    const applied = await Promise.race([
      queryClient.fetchQuery({
        queryKey: personalFieldKeys.applied(target.connectionId, target.db, target.coll),
        queryFn: () => personalFieldsApi.applied(target.connectionId, target.db, target.coll),
        staleTime: 60_000,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow')), VIEW_CHECK_MS)),
    ])
    return (
      applied.patterns ??
      applied.rules
        .filter((r) => (r.db === '*' || r.db === target.db) && (r.coll === '*' || r.coll === target.coll))
        .map((r) => [...ruleSegments(r.field)])
    ).map((p) => [...p])
  } catch {
    return null
  }
}
/** How long a plugin waits for the kind of its collection (context.get is the first thing it asks). */
const VIEW_CHECK_MS = 3000
/** API failures in the app's own words; anything else stays inside. */
const api = async <T,>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (e) {
    if (e instanceof ApiError) throw new BridgeError(e.code.toLowerCase(), e.message)
    throw e
  }
}

let bridge: Bridge | null = null
const mayRead = () => props.plugin.permissions.includes('documents:read')
watch(frame, (el) => {
  // A frame gone (or replaced) reads no more (wave 1 review M2).
  aggregating?.abort()
  bridge?.dispose()
  bridge = null
  if (!el) return emit('bridge', null)
  bridge = createBridge({
    frame: () => frame.value?.contentWindow,
    // As approved now, not when the frame opened (security audit 2026-10-16, M3).
    permissions: () => props.plugin.permissions,
    handlers: {
      'context.get': async () => ({
        plugin: { id: props.plugin.id, version: props.plugin.version },
        contribution: { kind: props.kind, id: props.contribution },
        locale: locale.value,
        theme: preferences.dark ? 'dark' : 'light',
        // Plugin tabs redesign: the user's accent, one of the app's names, for the kit's colours.
        accent: preferences.accent,
        place: props.target
          ? {
              connectionId: props.target.connectionId,
              connectionName:
                connections.value?.find((c) => c.id === props.target!.connectionId)?.name ?? null,
              db: props.target.db,
              coll: props.target.coll,
              view: await isView(props.target),
              // The open document's _id and the user's filter are data: for a plugin that may read
              // documents only (review 2026-10-13, web).
              documentId: mayRead() ? (props.documentId ?? null) : null,
              filter: mayRead() ? (props.filter ?? {}) : {},
              // Plugins wave 3: what personal-data rules hide from this user here — names only.
              hidden: mayRead() ? await hiddenPaths(props.target) : [],
            }
          : null,
        settings: props.plugin.settings,
      }),
      'ui.toast': (p) => {
        // A message from a page out of sight would come from nowhere the user can see (re-review of
        // 2026-10-16: a kept collection tab's page).
        inSight()
        const { message, kind } = params(p)
        if (typeof message !== 'string' || !message.trim())
          throw new BridgeError('bad_params', 'message is text')
        oneMessage()
        toasts.push({
          kind: kind === 'success' || kind === 'error' ? kind : 'info',
          message: `${who.value}: ${plain(message, 200)}`,
        })
        return true
      },
      'ui.openDocument': (p) => {
        // Security audit 2026-10-16: on the user's click in the page only, like the rest.
        byUser(oneOpen)
        collection()
        const { id } = params(p)
        // A value only: never a query operator for the user's own list (4b review M4).
        if (!isDocumentId(id)) throw new BridgeError('bad_params', 'id is a document _id')
        emit('open-document', id)
        return true
      },
      // User report 2026-10-16: a page that follows context.changed (its filter read again) stays loaded
      // while another section of its collection tab shows; any other is loaded again each time, as it
      // reads its place once. Out of sight it still acts in nothing (inactive).
      'ui.keepOpen': () => {
        if (props.kind !== 'collectionTab') return false
        emit('keep', true)
        return true
      },
      'ui.resize': (p) => {
        const h = Number(params(p).height)
        if (!Number.isFinite(h)) throw new BridgeError('bad_params', 'height is a number')
        height.value = Math.min(2000, Math.max(80, Math.round(h)))
        return true
      },
      'documents.find': async (p) => {
        const target = collection(p)
        read()
        const q = params(p)
        const limit = q.limit === undefined ? 100 : Number(q.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FIND)
          throw new BridgeError('bad_params', `limit is 1 to ${MAX_FIND}`)
        const filter = objectOr(q.filter, 'filter') ?? {}
        const projection = objectOr(q.projection, 'projection')
        const sort = objectOr(q.sort, 'sort')
        // Never code on the server, whatever the server allows the user (wave 2).
        assertNoForbidden({ filter, projection, sort })
        const result = await api(() =>
          documentsApi.find(target, {
            filter,
            ...(projection ? { projection } : {}),
            ...(sort ? { sort } : {}),
            skip: 0,
            limit,
            remember: false,
          }),
        )
        return {
          documents: result.documents.flatMap((d) => ('document' in d ? [d.document] : [])),
          hasMore: result.hasMore,
        }
      },
      'documents.get': async (p) => {
        const target = collection(p)
        read()
        const { id } = params(p)
        if (id === undefined) throw new BridgeError('bad_params', 'id is required')
        const item = await api(() => documentsApi.get(target, id))
        return 'document' in item ? item.document : null
      },
      'ui.copy': async (p) => {
        byUser(oneMessage)
        const { text } = params(p)
        if (typeof text !== 'string' || text.length > 100_000)
          throw new BridgeError('bad_params', 'text is at most 100,000 characters')
        if (appInputIsRecent()) return askToCopy(text)
        await navigator.clipboard.writeText(text)
        toasts.push({ kind: 'success', message: t('plugins.copied', { name: who.value }) })
        return true
      },
      'ui.useQuery': (p) => {
        byUser(oneUse)
        const target = collection()
        useQueryIn(target, handedQuery(params(p)))
        emit('applied')
        return true
      },
      // Research 2026-10-28 (reverse references): a query on another collection of its database —
      // one it may list — put in Documents of that collection's tab, as ui.useQuery puts one in its own.
      'ui.useQueryIn': async (p) => {
        // Review 2026-10-28: one at a time — calls in parallel on one click opened a tab each.
        if (usingIn) throw new BridgeError('busy', 'An earlier query is still being put in place')
        byUser(oneUse)
        const target = collection()
        const q = params(p)
        if (typeof q.coll !== 'string' || !q.coll || q.coll.length > 255)
          throw new BridgeError('bad_params', 'coll is a collection name')
        const body = handedQuery(q)
        const coll = q.coll
        usingIn = true
        try {
          if (!(await databaseCollections(target)).some((c) => c.name === coll))
            throw new BridgeError('bad_params', 'No such collection in this database')
        } finally {
          usingIn = false
        }
        // The list may come late: the frame must still be there, in sight, and the click the user's.
        stillByUser()
        useQueryIn({ connectionId: target.connectionId, db: target.db, coll }, body)
        emit('applied')
        return true
      },
      // Research 2026-10-28 (the personal data finder): fields of its collection suggested as personal
      // data. Nothing is saved on a plugin's word: the collection's Personal data section opens with
      // them listed, and an administrator adds each there — the section's own save, which reads what
      // the rules hide anew everywhere.
      'ui.suggestPersonalData': async (p) => {
        byUser(oneUse)
        const target = collection()
        const may = connections.value?.find((c) => c.id === target.connectionId)?.permissions ?? []
        if (!may.includes('connections:manage'))
          throw new BridgeError(
            'not_permitted',
            'Only an administrator of this connection names its personal data',
          )
        // A rule's wildcard is no collection's name: a rule on it would be every collection's.
        if (target.db === '*' || target.coll === '*' || target.coll.startsWith('system.'))
          throw new BridgeError('bad_params', 'Not a collection a rule may name')
        const fields = suggestedFields(params(p).fields, target)
        // A view's values are its source's: its rules are named there.
        // Known to be a collection, as for a write: a view's data is its source's, and one the list
        // does not name (or not in time) is not taken for one.
        const kind = await listedKind(target, true)
        if (kind === 'view') throw new BridgeError('bad_params', 'A view’s data is its source’s')
        if (kind === undefined)
          throw new BridgeError('bad_params', 'This collection is not in its database’s list: try again')
        stillByUser()
        suggestPersonalIn(target, who.value, fields)
        return true
      },
      'ui.importSql': () => {
        byUser(oneUse)
        const target = collection()
        // Never a dialog the user could not use: an import writes and runs as a job.
        const may = connections.value?.find((c) => c.id === target.connectionId)?.permissions ?? []
        // Review M15: as everywhere else in the app, never into a system database.
        if (
          !may.includes('documents:write') ||
          !may.includes('jobs:run') ||
          BACKUP_SYSTEM_DATABASES.includes(target.db)
        )
          throw new BridgeError('not_permitted', 'You may not import into this database')
        workspaceDialogs.openImportSql(target.connectionId, target.db)
        return true
      },
      'ui.exportSql': () => {
        byUser(oneUse)
        const target = collection()
        // As the app's own Export (offered on views too): the connection's export right decides.
        if (!connections.value?.find((c) => c.id === target.connectionId)?.export)
          throw new BridgeError('not_permitted', 'You may not export from this collection')
        workspaceDialogs.openExportSql(target.connectionId, target.db, target.coll)
        return true
      },
      'ui.useAggregation': async (p) => {
        byUser(oneUse)
        const target = collection()
        // One question at a time, and none after the user said no twice (wave 1 review M1).
        if (declines >= 2) throw new BridgeError('blocked', 'The user declined its changes')
        if (confirming) throw new BridgeError('busy', 'A question is waiting for the user')
        const stages = assertHandedPipeline(params(p).stages)
        confirming = true
        let ok: boolean
        const deadline = AbortSignal.timeout(APP_QUESTION_MS)
        try {
          ok = await useAggregationIn(target, stages, who.value, t, deadline)
        } finally {
          confirming = false
        }
        if (!ok && deadline.aborted) throw new BridgeError('unanswered', 'The user did not answer in time')
        if (!ok) {
          declines++
          throw new BridgeError('declined', 'The user kept the pipeline there')
        }
        emit('applied')
        return true
      },
      'documents.aggregate': async (p) => {
        const target = collection(p)
        read()
        const q = params(p)
        // A join only for a plugin allowed to read the other collections of its database.
        const stages = assertReadOnlyPipeline(
          q.pipeline,
          false,
          props.plugin.permissions.includes('database:read'),
        )
        const limit = q.limit === undefined ? 100 : Number(q.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FIND)
          throw new BridgeError('bad_params', `limit is 1 to ${MAX_FIND}`)
        // A join reads only a collection the plugin may list, as documents.findIn (review M5).
        const joined = stages.flatMap((s) => {
          const lookup = s.$lookup as { from?: unknown } | undefined
          return lookup ? [String(lookup.from)] : []
        })
        if (joined.length) {
          const names = new Set((await databaseCollections(target)).map((c) => c.name))
          for (const from of joined)
            if (!names.has(from))
              throw new BridgeError('bad_params', '$lookup reads a collection of this database')
        }
        if (aggregating) throw new BridgeError('busy', 'Its last pipeline is still running')
        const documents: unknown[] = []
        let truncated = false
        const mine = new AbortController()
        aggregating = mine
        try {
          // Bounded, and none of the user's recent pipelines (wave 1 review M2).
          const body = { stages, limit, remember: false, allowDiskUse: false, maxTimeMS: AGGREGATE_MAX_MS }
          const stream = await api(() => aggregateApi.run(target, body, mine.signal))
          await readNdjson(stream, (lines) => {
            for (const line of lines as Array<Record<string, unknown>>) {
              if ('document' in line && documents.length < limit) documents.push(line.document)
              else if ('end' in line) truncated = !!(line.end as { truncated?: boolean }).truncated
              else if ('error' in line) {
                const e = line.error as { code?: string; message?: string }
                throw new BridgeError(
                  String(e.code ?? 'failed').toLowerCase(),
                  e.message ?? 'The pipeline failed',
                )
              }
            }
          })
        } finally {
          if (aggregating === mine) aggregating = null
        }
        return { documents, truncated }
      },
      'indexes.list': async (p) => {
        // Plugins wave 3: another collection of the database too, with database:read. Charged
        // first: a refused name costs a read too (wave 3 review).
        const base = collection(p)
        definition()
        const named = await namedCollection(base, params(p).coll)
        // A view has no indexes of its own.
        if (named.view) return []
        const list = await api(() => documentsApi.indexes(named.target))
        return list.map(({ name, key, options, usage }) => ({ name, key, options, usage }))
      },
      // Plugins wave 3 (spec §1.3): a collection's validation rules, as the Validation section reads
      // them; a view has none.
      // Plugins wave 4 (2026-10-27): the database's storage, as its report reads it.
      // Final review Minor 8: up to 500 $collStats a read — one read kept half a minute per database
      // (for every frame), forgotten after a compact there.
      'storage.stats': async (p) => {
        const target = collection(p)
        const where = JSON.stringify([target.connectionId, target.db])
        const known = STORAGE_READS.get(where)
        if (known && Date.now() - known.at < STORAGE_KEPT_MS) return known.report
        read()
        const report = api(() => storageApi.report(target.connectionId, target.db))
        STORAGE_READS.set(where, { at: Date.now(), report })
        report.catch(() => STORAGE_READS.delete(where))
        return report
      },
      // What compact would give back: its collection, another of its database with database:read.
      'storage.compactEstimate': async (p) => {
        const named = await namedCollection(collection(p), params(p).coll)
        if (named.view) throw new BridgeError('read_only', 'A view has no storage of its own')
        read()
        return api(() => storageApi.compactEstimate(named.target))
      },
      // Compact, in the app's own dialog naming the plugin and the collection, the name typed; only
      // on the user's click in the plugin's page, and for a user who may administer databases. Where
      // it would only fail (a time series, a read-only connection, rules reaching it), refused before
      // any dialog (final review Minor 5); one compact of a collection at a time (I5).
      'ui.compact': async (p) => {
        byUser(oneUse)
        const deadline = AbortSignal.timeout(APP_QUESTION_MS)
        if (declines >= 2) throw new BridgeError('blocked', 'The user declined its changes')
        if (confirming) throw new BridgeError('busy', 'A change is waiting for the user')
        const named = await namedCollection(collection(p), params(p).coll)
        if (named.view) throw new BridgeError('read_only', 'A view has no storage of its own')
        const ns = JSON.stringify([named.target.connectionId, named.target.db, named.target.coll])
        if (COMPACTING.has(ns)) throw new BridgeError('busy', 'This collection is being compacted')
        const conn = connections.value?.find((c) => c.id === named.target.connectionId)
        if (!(conn?.permissions ?? []).includes('databases:admin'))
          throw new BridgeError('not_permitted', 'You may not compact this collection')
        if (conn?.readOnly) throw new BridgeError('read_only', 'The connection is read-only')
        const kind = (await databaseCollections(named.target)).find((c) => c.name === named.target.coll)?.type
        if (kind === 'timeseries')
          throw new BridgeError('bad_params', 'A time series collection is not compacted here')
        const hidden = await hiddenPaths(named.target)
        if (hidden === null || hidden.length)
          throw new BridgeError('not_permitted', 'Personal data rules reach this collection')
        // What compact would give back, in the question (spec §2), when MongoDB can tell.
        const estimate = await storageApi
          .compactEstimate(named.target)
          .then((e) => (e.available ? e.estimatedBytes : null))
          .catch(() => null)
        confirming = true
        let ok: boolean
        try {
          ok = await dialogs.confirm({
            signal: deadline,
            title: t('plugins.bridge.compactTitle', { plugin: who.value }),
            message: [
              t('plugins.bridge.compactMessage', {
                plugin: who.value,
                ns: `${named.target.db}.${named.target.coll}`,
              }),
              estimate === null
                ? ''
                : t('plugins.bridge.compactEstimate', { size: formatBytes(estimate, locale.value) }),
              t('plugins.bridge.compactMembers'),
            ]
              .filter(Boolean)
              .join(' '),
            confirmLabel: t('plugins.bridge.compactConfirm'),
            danger: true,
            requireText: named.target.coll,
          })
        } finally {
          confirming = false
        }
        if (!ok && deadline.aborted) throw new BridgeError('unanswered', 'The user did not answer in time')
        if (!ok) {
          declines++
          throw new BridgeError('declined', 'The user declined compact')
        }
        // The name the dialog made the user type: the server checks it again (a stray call never compacts).
        COMPACTING.add(ns)
        let result: { bytesFreed: number }
        try {
          result = await api(() => storageApi.compact(named.target, named.target.coll))
        } finally {
          COMPACTING.delete(ns)
          STORAGE_READS.delete(JSON.stringify([named.target.connectionId, named.target.db]))
        }
        toasts.push({
          kind: 'success',
          message: t('plugins.bridge.compacted', {
            ns: `${named.target.db}.${named.target.coll}`,
            size: formatBytes(result.bytesFreed, locale.value),
          }),
        })
        return result
      },
      // A candidate shard key's characteristics (analyzeShardKey): its common values are data.
      'shardKey.analyze': async (p) => {
        const target = collection(p)
        const body = ShardKeyAnalysisBodySchema.safeParse({ key: params(p).key })
        if (!body.success)
          throw new BridgeError('bad_params', 'key is one to five fields, each 1 or "hashed" (one at most)')
        if (await isView(target, true)) throw new BridgeError('read_only', 'A view cannot be sharded')
        read()
        return api(() => storageApi.shardKeyAnalysis(target, body.data.key))
      },
      // The collection's search indexes (Atlas Search, vector search): their fields, never a hidden
      // one (as validation.get: a hidden field's type is never told).
      'searchIndexes.list': async (p) => {
        const target = collection(p)
        definition()
        const list = await api(() => documentsApi.searchIndexes(target))
        if (!list.supported) return searchIndexesFor(list, [])
        const hidden = await hiddenPaths(target)
        if (hidden === null) throw new BridgeError('failed', 'What is hidden here could not be told')
        return searchIndexesFor(list, hidden)
      },
      'validation.get': async (p) => {
        const base = collection(p)
        definition()
        const named = await namedCollection(base, params(p).coll)
        if (named.view) return null
        const state = await api(() => validationApi.get(named.target))
        if (state.kind === 'view') return null
        // Wave 3 review: what a rule says of a hidden field is not told (its name is).
        const hidden = await hiddenPaths(named.target)
        if (hidden === null) throw new BridgeError('failed', 'What is hidden here could not be told')
        return {
          validator: rulesWithoutHidden(state.validator, hidden),
          validationLevel: state.validationLevel,
          validationAction: state.validationAction,
        }
      },
      // Plugins wave 3 (spec §1.3): the database's model as its Database tab draws it — names, types
      // and shares, hidden fields by name only, references — one read, kept a minute.
      'database.model': async (p) => {
        const target = collection(p)
        const where = JSON.stringify([target.connectionId, target.db])
        const known = models.get(where)
        // Answered within the minute, or running for under 90 seconds (the server ends a model at 60):
        // a read that runs long is shared, one that hangs is not waited on forever (second and
        // third reviews).
        if (
          known &&
          (known.at === null ? Date.now() - known.started < 90_000 : Date.now() - known.at < 60_000)
        )
          return known.model
        read()
        const model = api(() => dataModelApi.get(target.connectionId, target.db, 200))
        const kept: { at: number | null; started: number; model: Promise<DataModel> } = {
          at: null,
          started: Date.now(),
          model,
        }
        models.set(where, kept)
        model.then(
          () => void (kept.at = Date.now()),
          () => {
            if (models.get(where) === kept) models.delete(where)
          },
        )
        return model
      },
      // Plugins wave 3 (spec §1.1): a file the plugin made, saved by the app on the user's click in
      // its page, under a safe name and as a kind the app knows.
      'ui.download': (p) => {
        byUser(oneUse)
        const file = buildDownload(p, props.plugin.id, LOCALE_TAGS[uiLanguageOf(locale.value)])
        const save = () => {
          saveBlob(file.name, file.blob)
          toasts.push({
            kind: 'success',
            message: t('plugins.downloaded', { name: who.value, file: file.name }),
          })
        }
        // Wave 3 review: a frame may have taken the focus after a press in the app — ask first.
        if (appInputIsRecent())
          return askUser(
            t('plugins.downloadAsk', {
              name: who.value,
              file: file.name,
              size: formatBytes(file.blob.size, locale.value),
            }),
            t('plugins.downloadAction'),
            save,
          )
        save()
        return true
      },
      // Plugins wave 3 (spec §1.2): documents handed to the app's Import wizard, on the plugin's
      // collection — the user previews, maps and starts the import there, with their own rights.
      'ui.importDocuments': async (p) => {
        byUser(oneUse)
        // Decided now, before any slow read (wave 3 second review).
        const askFirst = appInputIsRecent()
        const own = collection()
        const { ndjson, coll } = params(p)
        // Plugins wave 4: another collection of its database (a new one: an anonymised copy), with
        // database:read; never a system one. The user still decides everything in the wizard.
        let target = own
        if (coll !== undefined && coll !== own.coll) {
          if (!props.plugin.permissions.includes('database:read'))
            throw new BridgeError('not_permitted', 'This plugin was not approved for database:read')
          const name = CollectionNameSchema.safeParse(coll)
          // Final review I4: a name that reads as it is — no character that hides or turns text — and
          // never encryption's metadata.
          if (
            !name.success ||
            name.data.startsWith('system.') ||
            name.data.startsWith('enxcol_.') ||
            name.data.includes('$') ||
            [...name.data].some((c) => isHiddenChar(c.codePointAt(0)!) || isSpoofingChar(c.codePointAt(0)!))
          )
            throw new BridgeError('bad_params', 'coll is a collection name')
          target = { ...own, coll: name.data }
        }
        if (typeof ndjson !== 'string' || ndjson.length > MAX_NDJSON)
          throw new BridgeError('bad_params', 'ndjson is at most 1,000,000 characters')
        const lines = ndjson.split('\n').filter((l) => l.trim())
        if (!lines.length) throw new BridgeError('bad_params', 'No documents')
        for (const line of lines) {
          let doc: unknown
          try {
            doc = JSON.parse(line)
          } catch {
            throw new BridgeError('bad_params', 'Each line is a JSON object')
          }
          if (!doc || typeof doc !== 'object' || Array.isArray(doc))
            throw new BridgeError('bad_params', 'Each line is a JSON object')
        }
        // As the SQL import: never a wizard the user could not finish, never a system database.
        const may = connections.value?.find((c) => c.id === target.connectionId)?.permissions ?? []
        if (
          !may.includes('documents:write') ||
          !may.includes('jobs:run') ||
          BACKUP_SYSTEM_DATABASES.includes(target.db)
        )
          throw new BridgeError('not_permitted', 'You may not import into this collection')
        // Wave 3 review: never in place of a dialog the user has open.
        const busy = () => {
          if (workspaceDialogs.current) throw new BridgeError('busy', 'A dialog is open in the app')
        }
        busy()
        if (target === own) {
          if (await isView(target, true)) throw new BridgeError('read_only', 'A view is read-only')
        } else {
          // Final review I4: another collection is a new one, as the database is now (read afresh, not
          // the half-minute list): a plugin never fills a collection the user already has.
          const there = await api(() => connectionsApi.collections(target.connectionId, target.db))
          if (there.some((c) => c.name === target.coll))
            throw new BridgeError('bad_params', 'Import into a new collection: this one is there')
        }
        // Still in sight and nothing opened meanwhile (the kind may take a few seconds to tell).
        inSight()
        busy()
        const open = () => {
          busy()
          workspaceDialogs.open({
            kind: 'importData',
            connectionId: target.connectionId,
            db: target.db,
            coll: target.coll,
            file: {
              id: crypto.randomUUID(),
              name: fileName(`${props.plugin.id}-${target.coll}`, '.ndjson', props.plugin.id),
              text: ndjson,
              from: who.value,
            },
          })
        }
        if (askFirst || appInputIsRecent())
          return askUser(
            t(
              'plugins.importAsk',
              { name: who.value, count: formatCount(lines.length, locale.value), coll: target.coll },
              lines.length,
            ),
            t('plugins.importAction'),
            open,
          )
        open()
        return true
      },
      'collections.list': async (p) => {
        const target = collection(p)
        read()
        return databaseCollections(target)
      },
      'documents.findIn': async (p) => {
        const target = collection(p)
        const q = params(p)
        if (typeof q.coll !== 'string' || !q.coll || q.coll.length > 255)
          throw new BridgeError('bad_params', 'coll is a collection name')
        const limit = q.limit === undefined ? 50 : Number(q.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FIND_IN)
          throw new BridgeError('bad_params', `limit is 1 to ${MAX_FIND_IN}`)
        const filter = objectOr(q.filter, 'filter') ?? {}
        const projection = objectOr(q.projection, 'projection')
        assertNoForbidden({ filter, projection })
        read()
        // Only a collection of the plugin's own database, as listed: never a path (wave 2).
        const coll = q.coll
        if (!(await databaseCollections(target)).some((c) => c.name === coll))
          throw new BridgeError('bad_params', 'No such collection in this database')
        const other: CollectionTarget = { connectionId: target.connectionId, db: target.db, coll }
        const result = await api(() =>
          documentsApi.find(other, {
            filter,
            ...(projection ? { projection } : {}),
            skip: 0,
            limit,
            remember: false,
          }),
        )
        return { documents: result.documents.flatMap((d) => ('document' in d ? [d.document] : [])) }
      },
      'documents.update': async (p) => {
        // Security audit 2026-10-16: a question only right after the user's click in the page — never
        // one a page opens on its own, under the pointer, for a double-click to answer. Bounded by the
        // one question at a time and the two noes, not by a count — nor by a press in the app (second
        // review: answering the first question is one), as its arming guards the answer.
        byUser(() => undefined)
        // Third review: the question's time starts with the request, before any read.
        const deadline = AbortSignal.timeout(APP_QUESTION_MS)
        const target = collection()
        // One question at a time, and none after the user said no twice (4b review M5); taken
        // before anything is awaited, so two changes sent at once never ask twice (review 2026-10-10).
        if (declines >= 2) throw new BridgeError('blocked', 'The user declined its changes')
        if (confirming) throw new BridgeError('busy', 'A change is waiting for the user')
        const q = params(p)
        if (q.id === undefined) throw new BridgeError('bad_params', 'id is required')
        const set = objectOr(q.set, 'set') ?? {}
        const unset = q.unset === undefined ? [] : q.unset
        if (!Array.isArray(unset) || !unset.every((f) => typeof f === 'string'))
          throw new BridgeError('bad_params', 'unset is a list of field names')
        if (!Object.keys(set).length && !unset.length)
          throw new BridgeError('bad_params', 'Nothing to change')
        if (![...Object.keys(set), ...(unset as string[])].every(plainField))
          throw new BridgeError(
            'bad_params',
            'A field name holds a control, line-break or direction character',
          )
        // Shown whole, every hidden or reversing character spelled out: what is asked is what is
        // applied (4b review I2). A change too long to show is refused, never cut.
        const change = visible(
          JSON.stringify(
            { ...(Object.keys(set).length ? { $set: set } : {}), ...(unset.length ? { $unset: unset } : {}) },
            null,
            2,
          ),
        )
        const id = visible(JSON.stringify(q.id) ?? '')
        // Security audit 2026-10-16: every field changed, named on the first line — the change below
        // may run past what the dialog shows at once. Each quoted as JSON (review I1): a comma in a
        // name is no second field, and nothing in one can start a line of its own.
        const fields = [...Object.keys(set), ...(unset as string[])]
          .map((f) => visible(JSON.stringify(f)))
          .join(', ')
        if (change.length > MAX_SHOWN || id.length > 200 || fields.length > MAX_SHOWN)
          throw new BridgeError('too_large', 'The change is too long to show the user')
        confirming = true
        let ok: boolean
        let item: Awaited<ReturnType<typeof documentsApi.get>>
        try {
          // A view is never written (MongoDB refuses it too); an unknown kind is taken for a view.
          if (await isView(target, true)) throw new BridgeError('read_only', 'A view is read-only')
          item = await api(() => documentsApi.get(target, q.id))
          if (!('document' in item)) throw new BridgeError('not_found', 'No such document')
          // The user decides, in the app's own dialog naming the plugin and the change.
          ok = await dialogs.confirm({
            signal: deadline,
            title: t('plugins.bridge.updateTitle', { plugin: who.value }),
            message: t('plugins.bridge.updateMessage', { plugin: who.value, id, change, fields }),
            confirmLabel: t('plugins.bridge.updateConfirm'),
          })
        } finally {
          confirming = false
        }
        if (!ok && deadline.aborted) throw new BridgeError('unanswered', 'The user did not answer in time')
        if (!ok) {
          declines++
          throw new BridgeError('declined', 'The user declined the change')
        }
        const found = item as { hash: string }
        const result = await api(() => documentsApi.update(target, q.id, set, unset as string[], found.hash))
        // The app's own views of the collection show the change (review 2026-10-13, web).
        void queryClient.invalidateQueries({ queryKey: documentKeys.all(target) })
        return result
      },
    },
  })
})
/**
 * The page is up: it is greeted (its token) and, for a cell renderer, may be asked from now on.
 * A second load means the frame went to another page — a link, or a plugin handing itself over:
 * the bridge closes and the frame goes (4b review I1).
 */
let loads = 0
function loaded(): void {
  loads++
  if (loads === 1) {
    bridge?.hello()
    emit('bridge', bridge)
    return
  }
  bridge?.dispose()
  bridge = null
  if (asking !== null) toasts.dismiss(asking)
  emit('bridge', null)
  stopped.value = true
  emit('keep', false)
  toasts.push({ kind: 'error', message: t('plugins.navigated', { name: who.value }) })
}
// Language, theme and accent reach the page as they change; so does a change of what context.get
// says of the place (the user's filter, the open document), for a page kept while out of sight (user
// report 2026-10-16) — to a plugin that may read documents only, as context.get gives them.
const placeData = () => (mayRead() ? JSON.stringify([props.filter ?? {}, props.documentId ?? null]) : '')
// Each source on its own: a filter set again as it was is no change.
watch(
  [() => locale.value, () => preferences.dark, () => preferences.accent, placeData],
  ([lang, dark, accent]) =>
    bridge?.notify('context.changed', { locale: lang, theme: dark ? 'dark' : 'light', accent }),
)
onBeforeUnmount(() => {
  gone = true
  // A question of a frame gone (a copy, a file, documents) goes too.
  if (asking !== null) toasts.dismiss(asking)
  aggregating?.abort()
  bridge?.dispose()
  emit('bridge', null)
})
</script>

<template>
  <div
    v-if="!hidden"
    data-plugin-frame
    class="relative flex min-h-0 flex-1 flex-col"
    :style="height ? { height: `${height}px`, flex: 'none' } : undefined"
  >
    <DsCallout v-if="failed" tone="danger" class="m-4">{{ failed }}</DsCallout>
    <DsCallout v-else-if="stopped" data-plugin-stopped tone="danger" class="m-4">
      {{ t('plugins.navigated', { name }) }}
    </DsCallout>
    <div v-else-if="!src" class="flex items-center gap-2 p-4 text-ui text-fg-subtle">
      <DsSpinner :size="14" />{{ t('plugins.loading', { name }) }}
    </div>
    <iframe
      v-if="src && !stopped"
      ref="frame"
      :src="src"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      allow=""
      :title="t('plugins.frameTitle', { name })"
      class="min-h-0 w-full flex-1 border-0 bg-surface"
      @load="loaded"
    />
  </div>
  <iframe
    v-else-if="src && !stopped"
    ref="frame"
    :src="src"
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
    allow=""
    aria-hidden="true"
    tabindex="-1"
    title=""
    data-plugin-cells
    class="pointer-events-none fixed -left-[9999px] size-px opacity-0"
    @load="loaded"
  />
</template>
