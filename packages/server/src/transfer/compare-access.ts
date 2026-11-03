import type { Document, MongoClient } from 'mongodb'
import type { Deployment } from '@mongo-manager/shared'
import { asConnectionFailure, withMongo } from '../data/mongo-errors'
import { personOf } from '../connections/access'
import { gateDepsFor, viewAwareMasker } from '../masking/restricted'
import type { Principal, ServerContext } from '../http/context'
import { maskerForPrincipal } from '../masking/request'
import { guardFind } from '../masking/gate'
import { filterPaths } from '../masking/gate/filter'
import { personalField } from '../masking/gate/refusal'
import { compileRules, nsMaskerFrom, type Masker, type Pattern } from '../masking/match'
import { assertCopySource, assertCopyTarget, resolveSide } from './copy-access'
import { compareDeployments, deploymentOf } from './same-deployment'

export interface ComparePair {
  source: string
  target: string
  /** Each side's filter: the user's, rewritten by that side's gate for a restricted caller. */
  sourceFilter: Document
  targetFilter: Document
  /** Restricted on either side: both documents are masked with these paths before comparing (§5.3). */
  union: Pattern[] | null
  /** Restricted on the source: what a sync writes masked (plan ruling 9). */
  writeMask: Pattern[] | null
  /** The user filtered the comparison (data review M10: a sync's deletions look the source up). */
  filtered?: boolean
}

export interface PreparedCompare {
  sourceClient: MongoClient
  targetClient: MongoClient
  pairs: ComparePair[]
  ignore: string[][]
  sourceMasker: Masker | null
  targetMasker: Masker | null
  versions: { source: number; target: number }
  deployment: Deployment
  /** Source rules the target lacks, in target names ("db.coll.field"), for an unmasked sync (I5). */
  missingRules: string[]
}

/**
 * Final review C1: a namespace's personal paths through its views (a view is masked by what it
 * reads), from a side's rules — not the name alone.
 */
async function personalPaths(
  rules: Array<{ db: string; coll: string; field: string }>,
  client: MongoClient,
  db: string,
  coll: string,
): Promise<Pattern[]> {
  if (!rules.length) return []
  const masker = compileRules(rules as never)
  const aware = await withMongo(() => viewAwareMasker(masker, gateDepsFor(masker, client), [[db, coll]]))
  return [...aware.forNs(db, coll).patterns]
}

/**
 * Phase 3d-2 spec §5.3, §6: what a compare (and the sync that follows it) reads — both sides'
 * access, each pair's filters through the gates, and the masks. A personal path may be neither
 * filtered on nor ignored by a caller restricted on either side: it would tell a hidden value apart.
 */
export async function prepareCompare(
  ctx: ServerContext,
  principal: Principal,
  /** The source connection and its client (a route's held client, or the sync's). */
  source: { connectionId: string; client: MongoClient },
  input: {
    db: string
    pairs: Array<[string, string]>
    target: { connectionId: string; db: string }
    filter: Document
    ignore: string[]
  },
): Promise<PreparedCompare> {
  const sourceId = source.connectionId
  assertCopyTarget(input.target.db)
  for (const [s, t] of input.pairs) {
    assertCopySource(input.db, s)
    assertCopySource(input.target.db, t)
  }
  resolveSide(ctx, principal, input.target.connectionId, ['documents:read'])
  const sourceClient = source.client
  // W7: the caller's own sign-in on the target (a per-person OIDC connection in team mode).
  const targetClient = await ctx.manager
    .getClient(input.target.connectionId, { user: personOf(principal) })
    .catch(asConnectionFailure)
  const sourceMasker = maskerForPrincipal(ctx, principal, sourceId)
  const targetMasker = maskerForPrincipal(ctx, principal, input.target.connectionId)
  const src = ctx.personalFields.get(sourceId)
  const dst = ctx.personalFields.get(input.target.connectionId)
  const restricted = sourceMasker !== null || targetMasker !== null
  const sourceGate = sourceMasker ? gateDepsFor(sourceMasker, sourceClient) : null
  const targetGate = targetMasker ? gateDepsFor(targetMasker, targetClient) : null
  const ignore = input.ignore.map((p) => p.split('.'))
  const pairs: ComparePair[] = []
  const missing = new Set<string>()
  const dstMasker = compileRules(dst.rules)
  for (const [s, t] of input.pairs) {
    const srcPaths = await personalPaths(src.rules, sourceClient, input.db, s)
    const dstPaths = await personalPaths(dst.rules, targetClient, input.target.db, t)
    const union = restricted ? [...srcPaths, ...dstPaths] : []
    // Final review C2: a hidden _id would come back in samples, and its existence as "same".
    // Tenth review of the open's stop (minor 1): each names its field — the caller's own path, or
    // _id, every document's — and (eleventh review, minor 2) is the masking gate's own refusal: the
    // field cut short, the namespace named; (twelfth review, minor 1) the namespace of the side
    // whose rule it is, the source's first. Both are the caller's own.
    const sides: Array<[Pattern[], string]> = restricted
      ? [
          [srcPaths, `${input.db}.${s}`],
          [dstPaths, `${input.target.db}.${t}`],
        ]
      : []
    for (const [paths, at] of sides) {
      if (!paths.length) continue
      const ns = nsMaskerFrom(paths)
      if (ns.matches(['_id']) || ns.under(['_id'])) throw personalField('_id', at)
      for (const path of [...filterPaths(input.filter), ...ignore])
        if (ns.matches(path) || ns.under(path)) throw personalField(path.join('.'), at)
    }
    const sourceFilter = sourceGate
      ? (
          await withMongo(() =>
            guardFind(input.db, s, { filter: input.filter }, sourceGate, { order: false }),
          )
        ).filter
      : input.filter
    const targetFilter = targetGate
      ? (
          await withMongo(() =>
            guardFind(input.target.db, t, { filter: input.filter }, targetGate, { order: false }),
          )
        ).filter
      : input.filter
    const writeMask = sourceMasker && srcPaths.length ? srcPaths : null
    if (!writeMask) {
      const covered = dstMasker.forNs(input.target.db, t)
      for (const path of srcPaths)
        if (!covered.covers(path)) missing.add(`${input.target.db}.${t}.${path.join('.')}`)
    }
    pairs.push({
      source: s,
      target: t,
      sourceFilter,
      targetFilter,
      union: union.length ? union : null,
      writeMask,
      filtered: Object.keys(input.filter).length > 0,
    })
  }
  const sameConnection = sourceId === input.target.connectionId
  const deployment: Deployment = sameConnection
    ? 'same'
    : compareDeployments(
        ...(await withMongo(() => Promise.all([deploymentOf(sourceClient), deploymentOf(targetClient)]))),
      )
  return {
    sourceClient,
    targetClient,
    pairs,
    ignore,
    sourceMasker,
    targetMasker,
    versions: { source: src.version, target: dst.version },
    deployment,
    missingRules: [...missing],
  }
}
