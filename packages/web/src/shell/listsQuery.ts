import type { Query } from '@tanstack/vue-query'

/**
 * The lists a shell command can change: the connection's databases, and each database's collections
 * (a collection made in the shell completes, and shows in the tree). Nothing else is read again after a
 * command — stats and the rest stay as they are (second review 2026-10-12, minor 22).
 */
export const listsOf =
  (connectionId: string) =>
  (query: Query): boolean => {
    const [root, id, databases, , collections, ...rest] = query.queryKey as readonly unknown[]
    if (root !== 'connections' || id !== connectionId || databases !== 'databases') return false
    const length = query.queryKey.length
    return length === 3 || (length === 5 && collections === 'collections' && rest.length === 0)
  }
