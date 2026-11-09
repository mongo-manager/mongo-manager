// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { matchesAny, underAny } from '../../../shared/src/masking/glob'
import type { FieldShape } from '../../kit/src/shape'

/**
 * Plugins wave 3 (spec §6; Studio 3T's Reschema, NoSQLBooster's re-schema tool): operations on a
 * collection's fields as aggregation stages — $set and $unset only, on the read-only list a plugin
 * may run for a preview and hand to Aggregations. The source is never changed here: writing the
 * result is the user's $out, in Aggregations, which asks first.
 */
export const CONVERT_TO = ['int', 'long', 'double', 'decimal', 'string', 'date', 'bool', 'objectId'] as const
export type ConvertTo = (typeof CONVERT_TO)[number]
/** Where a default fills in: a missing field only, or a null one too. */
export type DefaultWhen = 'missing' | 'missingOrNull'

export type Operation =
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'flatten'; path: string; keys: string[]; separator: string }
  | { kind: 'nest'; fields: string[]; into: string }
  | { kind: 'convert'; path: string; to: ConvertTo; onError: 'null' | 'keep' }
  | { kind: 'remove'; path: string }
  | { kind: 'default'; path: string; value: string | number | boolean | null; when: DefaultWhen }
  | { kind: 'split'; path: string; separator: string }
  | { kind: 'join'; path: string; separator: string }
export type OperationKind = Operation['kind']
export const KINDS: OperationKind[] = [
  'rename',
  'flatten',
  'nest',
  'convert',
  'remove',
  'default',
  'split',
  'join',
]

export type Problem =
  'incomplete' | 'name' | 'id' | 'same' | 'overlap' | 'empty' | 'separator' | 'hidden' | 'duplicate'

/**
 * The stages a preview and a hand-off may hold: the bridge takes 50 in a pipeline, and the preview
 * adds two of its own ($match, or $limit and $facet) — review 30.
 */
export const MAX_STAGES = 48

/** A field's path: keys of letters and more, none empty, none holding $ (an operator) — review 24. */
const PATH = /^[^.$\s][^.$]*(\.[^.$\s][^.$]*)*$/
const okPath = (p: string) => PATH.test(p) && !p.includes('\u0000') && p.length <= 200
const under = (a: string, b: string) => a === b || b.startsWith(`${a}.`) || a.startsWith(`${b}.`)
const isId = (p: string) => p === '_id' || p.startsWith('_id.')
/** A shape's path as a step names it: arrays seen through. */
const bare = (path: string) => path.replace(/\[\]/g, '')

/**
 * Whether a path is hidden from the user, or holds a hidden field below it (review 23): a step
 * reading, moving, writing or removing it would carry a personal value where the user sees it, or
 * change what they may not see. A source is read whole, so a rule that could match below an object
 * counts even where the sample met no such field; a name typed as a target counts what is known.
 */
export type HiddenGuard = (path: string, role: 'source' | 'target') => boolean

export function hiddenGuard(
  patterns: readonly (readonly string[])[],
  shape: readonly FieldShape[],
): HiddenGuard {
  return (path, role) => {
    if (!patterns.length) return false
    const segments = path.split('.')
    if (matchesAny(patterns, segments)) return true
    // A hidden field the sample met at or below it.
    if (shape.some((f) => f.hidden && (bare(f.path) === path || bare(f.path).startsWith(`${path}.`))))
      return true
    if (role === 'target') return false
    const field = shape.find((f) => bare(f.path) === path)
    const holds = !field || field.types.some((t) => t.type === 'object' || t.type === 'array')
    if (holds) return underAny(patterns, segments)
    // Met only as a value, a field may still hold one below it in a document the sample missed: a
    // rule naming a field below it by its very name counts (`profile.ssn`, `profile.*.ssn`). Third
    // review: one reaching it through `*` or `**` (`*.ssn`) does not, or a common rule would leave
    // no top-level field to reshape.
    return patterns.some((p) => segments.every((s, i) => p[i] === s && p[i] !== '*' && p[i] !== '**'))
  }
}

/** The paths a step reads (and changes in place), and the ones it writes. */
function pathsOf(op: Operation): { sources: string[]; targets: string[] } {
  switch (op.kind) {
    case 'rename':
      return { sources: [op.from], targets: [op.to] }
    case 'nest':
      return { sources: op.fields, targets: [op.into] }
    case 'flatten':
      return { sources: [op.path], targets: op.keys.map((k) => `${op.path}${op.separator}${k}`) }
    default:
      return { sources: [op.path], targets: [] }
  }
}

/** A step not given its names yet (second review): unfinished, not wrong. */
function incomplete(op: Operation): boolean {
  switch (op.kind) {
    case 'rename':
      return !op.from || !op.to
    case 'nest':
      return !op.fields.length || !op.into
    default:
      return !op.path
  }
}

/** Why an operation cannot be made, or null. */
export function problemOf(op: Operation, hidden?: HiddenGuard): Problem | null {
  if (incomplete(op)) return 'incomplete'
  const { sources, targets } = pathsOf(op)
  const paths = [...sources, ...targets]
  // A flatten's separator becomes part of a field's name: never a . (a level) or a $ (review 24). A
  // split's or join's is a value, any text. (A NUL is refused with the names it makes.)
  if (op.kind === 'flatten' && /[.$]/.test(op.separator)) return 'separator'
  if (!paths.every(okPath)) return 'name'
  if (paths.some(isId)) return 'id'
  if (hidden && (sources.some((p) => hidden(p, 'source')) || targets.some((p) => hidden(p, 'target'))))
    return 'hidden'
  if (op.kind === 'nest' && !op.fields.length) return 'empty'
  if (op.kind === 'flatten' && !op.keys.length) return 'empty'
  if (op.kind === 'rename' && under(op.from, op.to)) return 'same'
  if (op.kind === 'nest' && op.fields.some((f) => under(f, op.into))) return 'same'
  // A field and one inside it (second review): the second would be read from what the first left.
  if (op.kind === 'nest' && op.fields.some((f, i) => op.fields.some((g, j) => i !== j && under(f, g))))
    return 'overlap'
  if (op.kind === 'nest' && new Set(op.fields.map(lastKey)).size !== op.fields.length) return 'duplicate'
  if ((op.kind === 'split' || op.kind === 'join') && !op.separator) return 'separator'
  return null
}

const lastKey = (path: string) => path.split('.').pop()!

/** What a step does to a field there (second review 14): replaces it, or sets it in each document. */
export interface Clash {
  path: string
  how: 'replaced' | 'each'
}

/**
 * What a step writes over (review 30): a field the sample holds under a target's name, or a value
 * that is not an object where the target would go inside it — replaced; a list of documents the
 * target goes inside — the value set in each of them (second review 14). Said, never refused.
 */
export function clashesOf(op: Operation, shape: readonly FieldShape[]): Clash[] {
  const out = new Map<string, Clash>()
  for (const target of pathsOf(op).targets) {
    const keys = target.split('.')
    for (let i = 1; i <= keys.length; i++) {
      const path = keys.slice(0, i).join('.')
      const field = shape.find((f) => bare(f.path) === path)
      if (!field) continue
      if (i < keys.length && field.types.some((t) => t.type === 'array')) {
        out.set(path, { path, how: 'each' })
        break
      }
      if (i === keys.length || !field.types.some((t) => t.type === 'object')) {
        if (!out.has(path)) out.set(path, { path, how: 'replaced' })
        break
      }
    }
  }
  return [...out.values()]
}

const ref = (path: string) => `$${path}`
const missing = (path: string) => ({ $eq: [{ $type: ref(path) }, 'missing'] })

function stagesOfOne(op: Operation): Record<string, unknown>[] {
  switch (op.kind) {
    case 'rename':
      return [{ $set: { [op.to]: ref(op.from) } }, { $unset: op.from }]
    case 'flatten':
      // Only the keys chosen move: a key the sample missed stays in the object, a value that is no
      // object stays as it is (review 24); the object goes only when the move emptied it, never one
      // that was empty before (second review 15).
      return [
        {
          $set: Object.fromEntries(
            op.keys.map((k) => [`${op.path}${op.separator}${k}`, ref(`${op.path}.${k}`)]),
          ),
        },
        {
          $set: {
            [op.path]: {
              $cond: [
                { $eq: [{ $type: ref(op.path) }, 'object'] },
                {
                  $let: {
                    vars: {
                      rest: {
                        $arrayToObject: {
                          $filter: {
                            input: { $objectToArray: ref(op.path) },
                            cond: { $not: { $in: ['$$this.k', { $literal: op.keys }] } },
                          },
                        },
                      },
                    },
                    in: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$$rest', { $literal: {} }] },
                            { $ne: [ref(op.path), { $literal: {} }] },
                          ],
                        },
                        '$$REMOVE',
                        '$$rest',
                      ],
                    },
                  },
                },
                ref(op.path),
              ],
            },
          },
        },
      ]
    case 'nest':
      // An expression's result replaces the target; a document written as it is would merge into an
      // object there, and into each document of a list (second review 14).
      return [
        {
          $set: {
            [op.into]: { $mergeObjects: [Object.fromEntries(op.fields.map((f) => [lastKey(f), ref(f)]))] },
          },
        },
        { $unset: op.fields.length === 1 ? op.fields[0]! : op.fields },
      ]
    case 'convert':
      // A missing field stays missing, a null stays null (review 25).
      return [
        {
          $set: {
            [op.path]: {
              $cond: [
                missing(op.path),
                '$$REMOVE',
                {
                  $convert: {
                    input: ref(op.path),
                    to: op.to,
                    onError: op.onError === 'null' ? null : ref(op.path),
                    onNull: null,
                  },
                },
              ],
            },
          },
        },
      ]
    case 'remove':
      return [{ $unset: op.path }]
    case 'default':
      // $literal: a value, never read as a path ($…) or an operator. A null is filled only when
      // chosen (review 30).
      return [
        {
          $set: {
            [op.path]:
              op.when === 'missingOrNull'
                ? { $ifNull: [ref(op.path), { $literal: op.value }] }
                : { $cond: [missing(op.path), { $literal: op.value }, ref(op.path)] },
          },
        },
      ]
    case 'split':
      return [
        {
          $set: {
            [op.path]: {
              $cond: [
                { $eq: [{ $type: ref(op.path) }, 'string'] },
                { $split: [ref(op.path), { $literal: op.separator }] },
                ref(op.path),
              ],
            },
          },
        },
      ]
    case 'join':
      // Any element joins without failing the pipeline (one that is no text, number, date, id or
      // boolean as nothing), and the separator goes before every element but the first — counted,
      // never read from the text so far, which an empty first element left empty (review 26).
      return [
        {
          $set: {
            [op.path]: {
              $cond: [
                { $isArray: ref(op.path) },
                {
                  $let: {
                    vars: {
                      joined: {
                        $reduce: {
                          input: ref(op.path),
                          initialValue: { text: '', count: 0 },
                          in: {
                            text: {
                              $concat: [
                                '$$value.text',
                                { $cond: [{ $eq: ['$$value.count', 0] }, '', { $literal: op.separator }] },
                                { $convert: { input: '$$this', to: 'string', onError: '', onNull: '' } },
                              ],
                            },
                            count: { $add: ['$$value.count', 1] },
                          },
                        },
                      },
                    },
                    in: '$$joined.text',
                  },
                },
                ref(op.path),
              ],
            },
          },
        },
      ]
  }
}

/** The stages of the operations that can be made, in their order. */
export const stagesOf = (ops: readonly Operation[], hidden?: HiddenGuard): Record<string, unknown>[] =>
  ops.filter((op) => problemOf(op, hidden) === null).flatMap(stagesOfOne)
