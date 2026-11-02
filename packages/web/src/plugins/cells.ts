import { inject, provide, shallowReactive, type InjectionKey } from 'vue'
import { bsonTypeOf, isHiddenChar, serializeValue } from '@mongo-manager/shared/browser'
import type { PluginRuntimeView } from '@mongo-manager/shared/browser'
import type { Bridge } from './bridge'
import type { CollectionTarget } from '@/api/documents'
import { i18n } from '@/i18n'

/**
 * Phase 4b §3: cell renderers. A plugin's hidden frame is asked about the values shown, in batches;
 * it answers text and a tone, which the app draws itself (never markup). A slow, wrong or missing
 * answer leaves the plain value.
 */

export const CELL_TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const
export type CellTone = (typeof CELL_TONES)[number]
export interface CellText {
  text: string
  tone: CellTone
  plugin: string
  /** Beside the value, or in a tooltip over it (user request 2026-10-13). */
  display?: 'inline' | 'tooltip'
}
/** A renderer may read before it answers (references, wave 2): a few seconds, then the plain value. */
export const CELL_TIMEOUT_MS = 3000
const BATCH = 200
const CACHE = 5000
/** Characters beside a value; a tooltip over it has room for more (research plugins' review, C1). */
const TEXT_CHARS = 80
const TOOLTIP_CHARS = 200

const GEOJSON = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
  'Feature',
  'FeatureCollection',
])

/** Whether a value (decoded BSON) is one a renderer asked for. */
export function matches(match: string, value: unknown): boolean {
  const type = bsonTypeOf(value)
  switch (match) {
    case 'geojson': {
      if (type !== 'object') return false
      const v = value as Record<string, unknown>
      return (
        typeof v.type === 'string' &&
        GEOJSON.has(v.type) &&
        (Array.isArray(v.coordinates) ||
          Array.isArray(v.geometries) ||
          Array.isArray(v.features) ||
          'geometry' in v)
      )
    }
    case 'string':
      return type === 'string'
    case 'number':
      return type === 'int32' || type === 'double' || type === 'long' || type === 'decimal128'
    case 'date':
      return type === 'date'
    case 'object':
      return type === 'object'
    case 'objectId':
      return type === 'objectId'
    // Plugins wave 3: a binary value, not a UUID (bsonTypeOf tells them apart).
    case 'binary':
      return type === 'binary'
    default:
      return false
  }
}

/** The bytes of a binary value a renderer is sent (spec §1.4): its head, never the whole value. */
export const BINARY_HEAD_BYTES = 2048

/**
 * A value as a renderer is sent it: canonical EJSON — a binary value as its head (the first 2,048
 * bytes), its subtype and its length, so an image of megabytes never crosses for a tooltip.
 */
export function cellValue(match: string, value: unknown): unknown {
  if (match !== 'binary') return serializeValue(value)
  const bin = value as { buffer: Uint8Array; sub_type: number; position?: number }
  const known = heads.get(bin)
  if (known) return known.value
  const length = bin.position ?? bin.buffer.length
  const head = bin.buffer.subarray(0, Math.min(length, BINARY_HEAD_BYTES))
  let raw = ''
  for (const b of head) raw += String.fromCharCode(b)
  const subType = bin.sub_type.toString(16).padStart(2, '0')
  const out = { $binaryHead: { base64: btoa(raw), subType, length } }
  heads.set(bin, { value: out, key: `binary:${subType}:${length}:${hashOf(raw)}` })
  return out
}

/**
 * Wave 3 review: a binary value's head, made once per value shown (never on every render), and the
 * short key its answer is kept under (its length, subtype and a hash of its head — never 2 KB of
 * base64 per value).
 */
const heads = new WeakMap<object, { value: unknown; key: string }>()
/** FNV-1a, twice (64 bits in all): a key, not a secret — the place and the plugin are in it too. */
function hashOf(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193) >>> 0
  }
  return `${a.toString(36)}${b.toString(36)}`
}
/** The key a value's answer is kept under: a binary value's short one, any other its EJSON. */
const valueKey = (match: string, value: unknown, ejson: unknown) =>
  (match === 'binary' && value && typeof value === 'object' && heads.get(value)?.key) || JSON.stringify(ejson)
/** A plugin's settings in the key: an answer given under other settings is asked again. */
const settingsKey = (plugin: PluginRuntimeView) => hashOf(JSON.stringify(plugin.settings ?? {}))

/**
 * An answer as the app shows it: plain text (bounded, nothing that fakes its form or shows as
 * nothing — security audit 2026-10-16, M2) and a known tone.
 */
export function cellText(answer: unknown, plugin: string): CellText | null {
  if (!answer || typeof answer !== 'object') return null
  const { text, tone } = answer as { text?: unknown; tone?: unknown }
  if (typeof text !== 'string') return null
  const clean = [...text]
    .filter((c) => !isHiddenChar(c.codePointAt(0)!))
    .join('')
    .trim()
  // Cut by characters, never inside one (an emoji is two code units).
  const cut = [...clean].slice(0, TOOLTIP_CHARS).join('')
  if (!cut) return null
  return { text: cut, tone: CELL_TONES.includes(tone as CellTone) ? (tone as CellTone) : 'neutral', plugin }
}

type Entry = CellText | null | 'pending'
/** Answers by plugin, renderer and value (canonical EJSON); reactive, so a cell shows one as it comes. */
export const cellCache = shallowReactive(new Map<string, Entry>())
/**
 * Plugins wave 2: the collection a table's values come from — told to the renderers asked about
 * them, which may read there (and only there) with the plugin's permissions.
 */
const PLACE: InjectionKey<() => CollectionTarget | null> = Symbol('cellPlace')
export const provideCellPlace = (place: () => CollectionTarget | null) => provide(PLACE, place)
export const useCellPlace = () => inject(PLACE, () => null)

const placeKey = (t: CollectionTarget) => JSON.stringify([t.connectionId, t.db, t.coll])
/** The latest places each plugin's renderer was asked about values in. */
const asked = new Map<string, Map<string, CollectionTarget>>()
const ASKED_PLACES = 20

export function rememberCellPlace(pluginId: string, place: CollectionTarget): void {
  let places = asked.get(pluginId)
  if (!places) asked.set(pluginId, (places = new Map()))
  const key = placeKey(place)
  places.delete(key)
  places.set(key, { connectionId: place.connectionId, db: place.db, coll: place.coll })
  while (places.size > ASKED_PLACES) places.delete(places.keys().next().value!)
}

/** A place a renderer names, if the app asked it about values there; else null. */
export function askedPlace(pluginId: string, place: unknown): CollectionTarget | null {
  if (!place || typeof place !== 'object') return null
  const { connectionId, db, coll } = place as Record<string, unknown>
  if (typeof connectionId !== 'string' || typeof db !== 'string' || typeof coll !== 'string') return null
  return asked.get(pluginId)?.get(placeKey({ connectionId, db, coll })) ?? null
}

/** Each queued value with the column it sits in (wave 2), by cache key, and where it was asked. */
const queues = new Map<string, Map<string, { value: unknown; path: string | null }>>()
const queuePlaces = new Map<string, CollectionTarget | null>()
/**
 * Review M2: a value whose answer did not come (a timeout, a refusal) or that the renderer asked to
 * be asked again about (`{ retry: true }`): when it may be asked again.
 */
const retryAt = new Map<string, number>()
export const RETRY_MS = 30_000
/**
 * Wave 3 review: an answer may age ("3 minutes ago"): one older than this is asked for again while
 * it still shows, and replaced when the new one comes.
 */
export const ANSWER_TTL_MS = 60_000
const answeredAt = new Map<string, number>()
/** When each shown answer last came (a failed asking again leaves it). */
const goodAt = new Map<string, number>()
/** How long an answer may stay while asking about it again keeps failing (third review). */
export const STALE_MAX_MS = 5 * 60_000
const later = (key: string, retryAsked = false) => {
  // Wave 3 second review: an answer already shown stays when asking about it again fails; it is
  // asked again a minute later. Third review: for a few minutes at most, and never when the
  // renderer itself asked to be asked again.
  const shown = cellCache.get(key)
  if (shown && shown !== 'pending' && !retryAsked && Date.now() - (goodAt.get(key) ?? 0) < STALE_MAX_MS)
    return void answeredAt.set(key, Date.now())
  cellCache.set(key, null)
  retryAt.set(key, Date.now() + RETRY_MS)
}

function flush(
  bridge: Bridge,
  plugin: PluginRuntimeView,
  queueKey: string,
  renderer: string,
  locale: string,
): void {
  const queue = queues.get(queueKey)
  const place = queuePlaces.get(queueKey) ?? null
  queues.delete(queueKey)
  queuePlaces.delete(queueKey)
  if (!queue?.size) return
  const entries = [...queue.entries()]
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH)
    const params = {
      renderer,
      values: batch.map(([, v]) => v.value),
      paths: batch.map(([, v]) => v.path),
      locale,
      ...(place ? { place: { connectionId: place.connectionId, db: place.db, coll: place.coll } } : {}),
    }
    bridge.ask('cells.render', params, CELL_TIMEOUT_MS).then(
      (answers) => {
        const list = Array.isArray(answers) && answers.length === batch.length ? answers : []
        batch.forEach(([key], n) => {
          const answer = list[n] as { retry?: unknown } | null | undefined
          if (answer && typeof answer === 'object' && answer.retry === true) later(key, true)
          else {
            cellCache.set(key, cellText(answer, plugin.id))
            answeredAt.set(key, Date.now())
            goodAt.set(key, Date.now())
          }
        })
      },
      () => batch.forEach(([key]) => later(key)),
    )
  }
}

/** A value queued for its renderer: values asked in the same moment go in one message. */
function enqueue(
  bridge: Bridge,
  plugin: PluginRuntimeView,
  renderer: string,
  locale: string,
  place: CollectionTarget | null,
  key: string,
  value: unknown,
  path: string | null,
): void {
  const where = place ? placeKey(place) : ''
  const queueKey = `${plugin.id}\u0000${renderer}\u0000${locale}\u0000${where}`
  let queue = queues.get(queueKey)
  if (!queue) {
    queue = new Map()
    queues.set(queueKey, queue)
    queuePlaces.set(queueKey, place)
    if (place) rememberCellPlace(plugin.id, place)
    queueMicrotask(() => flush(bridge, plugin, queueKey, renderer, locale))
  }
  queue.set(key, { value, path })
}

/**
 * The text a plugin gives a value, once it answered (null until then, and when none applies). The
 * first ask queues the value; values asked in the same moment go in one message. Asked in the app's
 * language, and again in another one (wave 1 review M8).
 */
export function cellTextFor(
  plugins: readonly PluginRuntimeView[],
  renderers: ReadonlyMap<string, Bridge>,
  value: unknown,
  path: string | null = null,
  place: CollectionTarget | null = null,
): CellText | null {
  return cellTextsFor(plugins, renderers, value, path, place)[0] ?? null
}

/**
 * What every plugin says of a value, one text per plugin (wave 2: a time and a reference both) — and
 * per place: one beside the value, one in its tooltip. Its first renderer for a place speaks there;
 * while that one's answer is on its way, a later one waits rather than showing and being replaced.
 */
export function cellTextsFor(
  plugins: readonly PluginRuntimeView[],
  renderers: ReadonlyMap<string, Bridge>,
  value: unknown,
  path: string | null = null,
  place: CollectionTarget | null = null,
): CellText[] {
  const out: CellText[] = []
  for (const plugin of plugins) {
    const bridge = renderers.get(plugin.id)
    if (!bridge) continue
    const decided = new Set<string>()
    for (const r of plugin.contributes.cellRenderers) {
      const display = r.display ?? 'inline'
      if (decided.has(display) || !matches(r.match, value)) continue
      let ejson: unknown
      try {
        ejson = cellValue(r.match, value)
      } catch {
        continue
      }
      const locale = i18n.global.locale.value
      const where = place ? placeKey(place) : ''
      const key = `${plugin.id}@${plugin.version}\u0000${settingsKey(plugin)}\u0000${r.id}\u0000${locale}\u0000${where}\u0000${path ?? ''}\u0000${valueKey(r.match, value, ejson)}`
      let known = cellCache.get(key)
      const retry = retryAt.get(key)
      if (known === null && retry !== undefined && Date.now() >= retry) {
        retryAt.delete(key)
        known = undefined
      }
      if (known === undefined) {
        if (cellCache.size >= CACHE) {
          cellCache.clear()
          retryAt.clear()
          answeredAt.clear()
          goodAt.clear()
        }
        cellCache.set(key, 'pending')
        enqueue(bridge, plugin, r.id, locale, place, key, ejson, path)
        decided.add(display)
      } else if (known === 'pending') decided.add(display)
      else if (known) {
        out.push({
          ...known,
          text: display === 'tooltip' ? known.text : [...known.text].slice(0, TEXT_CHARS).join(''),
          display,
        })
        decided.add(display)
        // An old answer still shows while it is asked for again (once a minute at most).
        if (Date.now() - (answeredAt.get(key) ?? 0) >= ANSWER_TTL_MS) {
          answeredAt.set(key, Date.now())
          enqueue(bridge, plugin, r.id, locale, place, key, ejson, path)
        }
      }
    }
  }
  return out
}
