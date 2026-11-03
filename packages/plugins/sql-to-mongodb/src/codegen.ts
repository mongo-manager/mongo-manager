import { deserializeValue } from '../../../shared/src/ejson'
import { formatShell } from '../../../shared/src/query/format'
import { EXPORT_LANGUAGES, exportFind, exportPipeline } from '../../../shared/src/aggregation/export'
import { canonical, type Doc, type Model } from './translate'

/**
 * Plugins wave 1: a translated query as code. Plugins wave 2: through the app's own generator —
 * mongosh as the shell writes it, and a complete program for each official driver (Node.js, Python,
 * Java, Go, C#, PHP, Ruby, Rust) that reads the connection string from MONGODB_URI.
 */
export const LANGUAGES = ['mongosh', ...EXPORT_LANGUAGES] as const
export type Language = (typeof LANGUAGES)[number]
export const LANGUAGE_NAMES: Record<Language, string> = {
  mongosh: 'mongosh',
  node: 'Node.js',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  csharp: 'C#',
  php: 'PHP',
  ruby: 'Ruby',
  rust: 'Rust',
}

/** A value of the model (plain JSON, patterns as `{ $regex }`) as the BSON it stands for. */
const decoded = (v: unknown): unknown => deserializeValue(canonical(v))

/**
 * Shell text on one line, line separators spelled out: they may stand in a string, never bare
 * (wave 1 review Minor 4).
 */
const shell = (v: unknown) =>
  formatShell(decoded(v), { indent: 0 }).replace(
    /[\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16)}`,
  )

/** The query as code; `db` names the database in the drivers' programs. */
export function code(model: Model, language: Language, db = 'test'): string {
  const coll = model.collection
  if (language === 'mongosh') {
    const target = `db.getCollection(${JSON.stringify(coll)})`
    if (model.kind === 'aggregate')
      return `${target}.aggregate([\n${model.pipeline.map((s) => `  ${shell(s)}`).join(',\n')}\n])`
    const { filter, projection, sort, skip, limit } = model
    const args = projection ? `(\n  ${shell(filter)},\n  ${shell(projection)}\n)` : `(${shell(filter)})`
    return `${target}.find${args}${sort ? `.sort(${shell(sort)})` : ''}${skip !== undefined ? `.skip(${skip})` : ''}${limit !== undefined ? `.limit(${limit})` : ''}`
  }
  if (model.kind === 'aggregate')
    return exportPipeline(language, { db, coll, stages: model.pipeline.map((s) => decoded(s)) })
  return exportFind(language, {
    db,
    coll,
    filter: decoded(model.filter),
    ...(model.projection ? { projection: decoded(model.projection) } : {}),
    ...(model.sort ? { sort: decoded(model.sort as Doc) } : {}),
    ...(model.skip !== undefined ? { skip: model.skip } : {}),
    ...(model.limit !== undefined ? { limit: model.limit } : {}),
  })
}
