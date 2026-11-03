import type { MongoClient } from 'mongodb'
import type { WatchReason, WatchTarget } from '@mongo-manager/shared'
import { topologyOf } from '../connections/manager'

/** Spec §1.2 step 2: why a subscription was refused, in a reason the web words (never MongoDB's text). */
export class WatchRefusal extends Error {
  override name = 'WatchRefusal'
  constructor(
    readonly reason: WatchReason,
    readonly detail?: string,
  ) {
    super(reason)
  }
}

/** What a feed learns of its target before it starts. */
export interface TargetFacts {
  /** The collection records pre-images (collection scope; null elsewhere). */
  preImages: boolean | null
  /** Final review M4: the collection exists yet (collection scope; null elsewhere). */
  exists: boolean | null
}

/**
 * Spec §1.1: change streams need a replica set, a sharded cluster or a load-balanced deployment; a
 * view cannot be watched. Answers whether the collection records pre-images (plan ruling 7).
 */
export async function checkTarget(client: MongoClient, target: WatchTarget): Promise<TargetFacts> {
  let hello: Record<string, unknown>
  try {
    hello = await client.db('admin').command({ hello: 1 })
  } catch {
    throw new WatchRefusal('connection')
  }
  if (topologyOf(hello) === 'standalone') throw new WatchRefusal('not_replica_set')
  if (target.scope !== 'collection') return { preImages: null, exists: null }
  const [info] = await client
    .db(target.db!)
    .listCollections({ name: target.coll! }, { nameOnly: false })
    .toArray()
    .catch(() => {
      throw new WatchRefusal('connection')
    })
  if (info?.type === 'view') throw new WatchRefusal('view')
  const options = (info as { options?: { changeStreamPreAndPostImages?: { enabled?: unknown } } } | undefined)
    ?.options
  return { preImages: options?.changeStreamPreAndPostImages?.enabled === true, exists: info !== undefined }
}
