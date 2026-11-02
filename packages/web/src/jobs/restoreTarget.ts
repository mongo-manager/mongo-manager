import type { RestoreReport } from '@mongo-manager/shared/browser'

export type RestoreTarget =
  { kind: 'collection'; db: string; coll: string } | { kind: 'database'; db: string }

/**
 * W4.4 (3d-3a U8): where a finished restore wrote — its one collection, or the one database of its
 * collections — so its toast and its details can open it. Null when it wrote nothing, or into several
 * databases (the jobs page then says the rest). A namespace is "db.coll": a database name holds no ".".
 */
export function restoreTarget(report: RestoreReport): RestoreTarget | null {
  const written = report.namespaces.filter((n) => n.to !== '*' && n.to.includes('.'))
  if (!written.length) return null
  const split = (ns: string) => ({ db: ns.slice(0, ns.indexOf('.')), coll: ns.slice(ns.indexOf('.') + 1) })
  const all = written.map((n) => split(n.to))
  if (all.length === 1) return { kind: 'collection', ...all[0]! }
  const db = all[0]!.db
  return all.every((n) => n.db === db) ? { kind: 'database', db } : null
}
