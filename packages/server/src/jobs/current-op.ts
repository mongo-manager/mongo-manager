import type { Document, MongoClient } from 'mongodb'

/** Connections whose account may not list other users' operations (asked once, then remembered). */
const ownOperationsOnly = new WeakSet<MongoClient>()

/**
 * Operations matching `match`, from every user when the account may see them, else its own.
 * Asking for all operations without the right fails, and MongoDB audits each failure, so after
 * one refusal this client only asks for its own (final review 1g-2, Minor 7). Empty when neither
 * can be read.
 */
export async function currentOps(
  client: MongoClient,
  match: Document,
  opts: {
    internal?: boolean
    stages?: Document[]
    comment?: string
    primary?: boolean
    timeoutMS?: number
  } = {},
): Promise<Document[]> {
  try {
    return (await listOperations(client, match, opts)).ops
  } catch {
    return []
  }
}

/**
 * Like currentOps, and whether every user's operations were listed or only the account's own
 * (phase 3b §4: the list says so instead of silently showing fewer).
 */
export async function listOperations(
  client: MongoClient,
  match: Document,
  opts: {
    internal?: boolean
    stages?: Document[]
    comment?: string
    primary?: boolean
    timeoutMS?: number
  } = {},
): Promise<{ ops: Document[]; scope: 'all' | 'own' }> {
  const admin = client.db('admin')
  const options = {
    ...(opts.comment ? { comment: opts.comment } : {}),
    ...(opts.primary ? { readPreference: 'primary' as const } : {}),
    ...(opts.timeoutMS ? { timeoutMS: opts.timeoutMS } : {}),
  }
  // An index build's own thread, the one carrying its progress, is listed only with idle connections.
  const idleConnections = opts.internal ?? false
  const pipeline = (allUsers: boolean) => [
    { $currentOp: { allUsers, idleConnections } },
    { $match: match },
    ...(opts.stages ?? []),
  ]
  if (!ownOperationsOnly.has(client)) {
    try {
      return { ops: await admin.aggregate(pipeline(true), options).toArray(), scope: 'all' }
    } catch (e) {
      // Only a refusal means the account lacks the role; anything else (the network, a timeout)
      // is reported, not remembered as "own operations only" (final review M2).
      if (!unauthorized(e)) throw e
      ownOperationsOnly.add(client)
    }
  }
  return { ops: await admin.aggregate(pipeline(false), options).toArray(), scope: 'own' }
}

/** MongoDB's "Unauthorized" (code 13): the account may not run this. */
const unauthorized = (e: unknown): boolean => (e as { code?: unknown }).code === 13

/** Waits up to `ms` for a matching operation: one just started may not be listed yet. */
export async function findOperation(
  client: MongoClient,
  match: Document,
  opts: { ms: number; stillRunning: () => boolean; internal?: boolean },
): Promise<Document | null> {
  const deadline = Date.now() + opts.ms
  for (;;) {
    const [op] = await currentOps(client, match, { internal: opts.internal ?? false })
    if (op) return op
    if (!opts.stillRunning() || Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 50))
  }
}
