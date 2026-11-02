import {
  AI_CHAT_EXPORTS,
  AI_CHAT_LIMITS,
  STAGES,
  fencedBlocks,
  parsePipeline,
  parseQueryObject,
  type AiAction,
  type AiChatBlock,
  type AiChatExport,
  type AiChatTarget,
  type AiWarning,
} from '@mongo-manager/shared'
import { shape, usesServerJs } from './answer'

/** Spec §1.4: the languages a block of MongoDB code comes in. */
const CODE = new Set(['', 'json', 'js', 'javascript', 'mongodb'])
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

/** An array is a pipeline; $jsonSchema a validator; indexes a suggestion; any other object a query. */
function kindOf(value: unknown): AiAction | null {
  if (Array.isArray(value)) return 'pipeline'
  if (!isPlain(value)) return null
  if ('$jsonSchema' in value) return 'validation'
  if ('indexes' in value) return 'optimise'
  return 'query'
}

/**
 * Phase 4a-2 spec §1.4, plan rulings 6 and 7: every recognised block, parsed by the safe evaluator
 * (nothing is evaluated), with the index the panel's Markdown gives the same block.
 */
/** The keys of a query wrapper that may also name its collection. */
const QUERY_KEYS = new Set(['filter', 'projection', 'sort'])

/** The stages of a pipeline: an object of one of them alone is a piece of a pipeline, not a query. */
const STAGE_NAMES = new Set([
  ...STAGES.map((s) => s.operator),
  '$graphLookup',
  '$redact',
  '$setWindowFields',
  '$documents',
  '$collStats',
  '$indexStats',
  '$planCacheStats',
  '$changeStream',
  '$currentOp',
  '$listSessions',
  '$listLocalSessions',
  '$searchMeta',
  '$vectorSearch',
  '$listSearchIndexes',
  '$querySettings',
  '$shardedDataDistribution',
  '$changeStreamSplitLargeEvent',
  '$listSampledQueries',
])
const isStage = (v: unknown): boolean => {
  if (!isPlain(v)) return false
  const keys = Object.keys(v)
  return keys.length === 1 && STAGE_NAMES.has(keys[0]!)
}
const EXPORTS = new Set<string>(AI_CHAT_EXPORTS)

/**
 * Phase 4a-2 spec §1.4, plan rulings 6 and 7: every recognised block, parsed by the safe evaluator
 * (nothing is evaluated), with the index the panel's Markdown gives the same block. `names`: a
 * general turn's list of collections (user request 2026-10-10) — only then may a wrapper name its
 * collection, and only a name of the list points anywhere (review I2, I3). `about`: a collection turn's
 * own "db.coll" — a block naming it stays with the turn, one naming another goes nowhere.
 */
export function answerBlocks(
  text: string,
  allowServerJs: boolean,
  names: ReadonlyMap<string, AiChatTarget> | Readonly<Record<string, AiChatTarget>> | null = null,
  about: string | null = null,
  /**
   * Re-review of A1/A2 (M2): a name in another letter case is the one name — only where the same
   * names are known when the chat is read again (an agent turn's own steps).
   */
  anyCase = false,
): AiChatBlock[] {
  const isAbout = (name: string): boolean => !!about && (name === about || name.endsWith(` / ${about}`))
  const exact = (name: string): AiChatTarget | undefined =>
    !names
      ? undefined
      : names instanceof Map
        ? names.get(name)
        : Object.hasOwn(names, name)
          ? (names as Record<string, AiChatTarget>)[name]
          : undefined
  // Review of A1 (nit): a name in another letter case is the same one, when it is the only such one.
  const targetOf = (name: string): AiChatTarget | undefined => {
    const hit = exact(name)
    if (hit || !names || !anyCase) return hit
    const lower = name.toLowerCase()
    const keys = (names instanceof Map ? [...names.keys()] : Object.keys(names)).filter(
      (k) => k.toLowerCase() === lower,
    )
    return keys.length === 1 ? exact(keys[0]!) : undefined
  }
  const out: AiChatBlock[] = []
  /**
   * The collection the answer named, for a block naming none (user report 2026-10-13: Run said "open
   * a collection tab" under a pipeline that named it): the last one named before it, else the first
   * named after it (review M8). A name not given leaves the rest nowhere.
   */
  let named: AiChatTarget | 'unresolved' | undefined
  const waiting: AiChatBlock[] = []
  const place = (b: AiChatBlock, where: AiChatTarget | 'unresolved'): void => {
    if (where === 'unresolved') b.unresolved = true
    else b.target = where
  }
  for (const [index, block] of fencedBlocks(text).entries()) {
    if (out.length >= AI_CHAT_LIMITS.blocks) break
    if (!CODE.has(block.lang.toLowerCase()) || !block.text.trim()) continue
    let value: unknown
    try {
      value = block.text.trim().startsWith('[') ? parsePipeline(block.text) : parseQueryObject(block.text)
    } catch {
      continue
    }
    // A lone stage is a piece of a pipeline to add somewhere: nothing to run alone (user report
    // 2026-10-13: a $match was offered as a query).
    if (isStage(value)) continue
    // A wrapper may name its collection — from the list sent, or nowhere (never a bare filter field)
    // — and ask for its output as a file.
    let own: AiChatTarget | 'unresolved' | undefined
    let exportAs: AiChatExport | undefined
    if (isPlain(value) && ('namespace' in value || 'export' in value)) {
      const { namespace, export: asFile, ...rest } = value
      const keys = Object.keys(rest)
      const pipeline = keys.length === 1 && Array.isArray(rest.pipeline)
      // A pipeline wrapped with keys of no meaning is nothing to act on.
      if ('pipeline' in rest && !pipeline) continue
      const query = keys.length > 0 && keys.every((k) => QUERY_KEYS.has(k))
      // A block naming its collection with more than a wrapper's keys (a validator, indexes, a filter
      // with a limit) is still about that collection, never another's (review 2026-10-13, I1).
      const named_ = typeof namespace === 'string' && keys.length > 0
      if (pipeline || query || named_) {
        value = pipeline ? rest.pipeline : rest
        if (typeof asFile === 'string' && EXPORTS.has(asFile)) exportAs = asFile as AiChatExport
        // Only a name of the list points anywhere. A turn about its collection was given none: its own
        // name stays with it, another goes nowhere — never into the turn's collection under another's
        // name (review 2026-10-13, I2).
        if (typeof namespace === 'string') {
          if (names) own = targetOf(namespace) ?? 'unresolved'
          else if (!isAbout(namespace)) own = 'unresolved'
        }
      }
    }
    const action = kindOf(value)
    if (!action) continue
    const warnings = new Set<AiWarning>()
    const result = shape(action, value, warnings)
    if (!result) continue
    if (usesServerJs(value)) {
      if (!allowServerJs) {
        out.push({ index, result: null, warnings: [], reason: 'server_js' })
        continue
      }
      warnings.add('server_js')
    }
    // A file of a query or a pipeline that only reads: the server exports nothing that writes (M1).
    const asFile =
      exportAs && (result.kind === 'query' || (result.kind === 'pipeline' && !warnings.has('write_stage')))
    const entry: AiChatBlock = {
      index,
      result,
      warnings: [...warnings],
      ...(asFile ? { export: exportAs } : {}),
    }
    if (own) {
      place(entry, own)
      if (names) {
        if (named === undefined) for (const w of waiting.splice(0)) place(w, own)
        named = own
      }
    } else if (names) {
      // Naming none, it is about the collection the answer named (a general turn only).
      if (named === undefined) waiting.push(entry)
      else place(entry, named)
    }
    out.push(entry)
  }
  // User report 2026-10-25: blocks naming none in an answer that named no collection in its blocks
  // go to the one listed collection its words name ("Sales Mongo / sales.users") — never a guess: two
  // named, or none, and they stay nowhere.
  if (names && named === undefined && waiting.length) {
    const keys = (names instanceof Map ? [...names.keys()] : Object.keys(names)).filter((k) =>
      text.includes(k),
    )
    // Review of the chat entry (M4): longest first, each said taken out of the words, so a name inside
    // a longer one ("a / db.c" in "a / db.coll") counts only where it stands alone.
    let rest = text
    const said: string[] = []
    for (const k of keys.sort((x, y) => y.length - x.length))
      if (rest.includes(k)) {
        said.push(k)
        rest = rest.split(k).join('\u0000')
      }
    if (said.length === 1) for (const w of waiting) place(w, exact(said[0]!)!)
  }
  return out
}

/**
 * The collections an agent turn's steps used, in order (a step's namespace "db.coll"): only steps
 * that did something — one refused or failed names where it was aimed, not a collection used
 * (review of A1, I1: a refused read of admin.system.users made it "the last used").
 */
export function stepTargets(
  steps: ReadonlyArray<{ connectionId: string | null; namespace: string | null; state: string }>,
): AiChatTarget[] {
  const out: AiChatTarget[] = []
  for (const s of steps) {
    const at = s.namespace?.indexOf('.') ?? -1
    if (s.state === 'done' && s.connectionId && at > 0)
      out.push({
        connectionId: s.connectionId,
        db: s.namespace!.slice(0, at),
        coll: s.namespace!.slice(at + 1),
      })
  }
  return out
}

/**
 * The AI database manager (design 2026-10-25, A1): an agent answer's block naming none goes to the
 * collection its steps used last; with none used, nowhere — never into whatever tab is open.
 */
export function placeAgentBlocks(blocks: readonly AiChatBlock[], last: AiChatTarget | null): AiChatBlock[] {
  return blocks.map((b) =>
    b.target || b.unresolved ? b : last ? { ...b, target: last } : { ...b, unresolved: true as const },
  )
}
