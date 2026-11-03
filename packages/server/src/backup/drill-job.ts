import { createHash, randomBytes } from 'node:crypto'
import { BSON, type Document } from 'bson'
import type { Db, MongoClient } from 'mongodb'
import type { DrillNamespaceReport, DrillReport, NamespaceType, PersonalRule } from '@mongo-manager/shared'
import { AppError, Errors } from '../errors'
import { isEncryptionNamespace } from '../connections/access'
import type { JobKind } from '../jobs/types'
import type { ServerContext } from '../http/context'
import { PartTracker } from '../jobs/parts'
import { DRILL_DB, DRILL_STAGING } from '../jobs/duplicate'
import { killByComment } from '../data/operations'
import { openArchive } from './pipeline'
import { bucketsOf } from './archive-reader'
import { knownVersion, seriesAccess, serverVersionOf } from './series'
import { slotKeysFor } from './keys/slot-keys'
import { rulesOn } from '../transfer/copy-access'

// The staging mark and the scratch database names: see jobs/duplicate.ts (dropLeftoverStaging).
export { DRILL_DB, DRILL_STAGING }

export interface DrillJobParams {
  owner: string
  backupId: string
  /** The schedule and run the drill belongs to, for the report and the event. */
  schedule: { id: string; name: string; runId: string } | null
}

const DESER = { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true } as const
const BATCH = 1000
const MOD = 1n << 256n
const MAX_SCRATCH_NS = 255

/** A document's place in an order-free sum of digests: the same documents give the same sum. */
const digest = (bytes: Uint8Array): bigint => BigInt(`0x${createHash('sha256').update(bytes).digest('hex')}`)

interface Ns {
  db: string
  coll: string
  type: NamespaceType
  /** The scratch collection the data goes into (a time series: its buckets). */
  into: string | null
  /** A time series' buckets written and read through its own name (MongoDB 8.3 on, series.ts). */
  raw?: { rawData: true }
  archived: number
  sum: bigint
  batch: Document[]
  crc: DrillNamespaceReport['crc']
  reason?: string
}

/**
 * W4 review I2: whether the connection's user may drop `db` (connectionStatus with its privileges).
 * No authenticated user: the server runs without access control, so it may.
 */
export function mayDropDatabases(status: Document, db: string): boolean {
  const info = (status.authInfo ?? {}) as {
    authenticatedUsers?: unknown[]
    authenticatedUserPrivileges?: Array<{
      resource?: { db?: string; collection?: string; anyResource?: boolean }
      actions?: string[]
    }>
  }
  if (!(info.authenticatedUsers ?? []).length) return true
  return (info.authenticatedUserPrivileges ?? []).some((p) => {
    const r = p.resource ?? {}
    if (!(p.actions ?? []).includes('dropDatabase')) return false
    return r.anyResource === true || ((r.db === '' || r.db === db) && (r.collection ?? '') === '')
  })
}

type DiskStats = { fsTotalSize?: unknown; fsUsedSize?: unknown }
const freeOf = (s: DiskStats | undefined): number | null => {
  const total = Number(s?.fsTotalSize)
  const used = Number(s?.fsUsedSize)
  return Number.isFinite(total) && Number.isFinite(used) && total > 0 ? Math.max(0, total - used) : null
}

/**
 * W4 review I2: the free space of the server's data disk (dbStats), or null when it does not say
 * (Atlas shared tiers). W4 re-review (minor): through a mongos the answer sums the shards' disks,
 * while each shard fills its own: the shard with the least room decides.
 */
export async function freeSpace(client: MongoClient, db = 'admin'): Promise<number | null> {
  // W4 re-review 2 (minor): asked of a data database — through a mongos, admin's answer is the
  // config servers' disks, a database's has each shard's under `raw`.
  const s = (await client
    .db(db)
    .command({ dbStats: 1 })
    .catch(() => null)) as (DiskStats & { raw?: Record<string, DiskStats> }) | null
  if (s?.raw && typeof s.raw === 'object') {
    const each = Object.values(s.raw).map(freeOf)
    if (!each.length || each.some((f) => f === null)) return null
    return Math.min(...(each as number[]))
  }
  return freeOf(s ?? undefined)
}

const dropDb = (db: Db, comment: string) => db.dropDatabase({ comment } as never)

function noSpace(report: DrillReport) {
  report.code = 'drill_space'
  return Errors.conflict('The server has not enough free disk space for the drill', { reason: 'drill_space' })
}

/**
 * W4.4 (completion design §2 W4.4): a restore drill. The backup is read from the store with its
 * owner's keys, every namespace restored into a fresh scratch database `mm_drill_<12 hex>` of the
 * backup's connection, then each scratch collection read back: its count must equal the backup's, and
 * the documents read must be, byte for byte, those written (an order-free sum of SHA-256 digests). The
 * scratch database is dropped whatever happens (a stopped server's leftover at the next open). The
 * outcome is reported, and announced as an app event (alerts).
 *
 * The archive's own checksums (CRC) are checked as a restore checks them. Collections are created
 * without options (a validator or a cap would turn the check into a check of the target), and views
 * are not restored (they hold no documents).
 */
export function drillKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  ctx: () => ServerContext
  kill?: (client: MongoClient, comment: string) => Promise<number>
  /** Tests only: called after the documents are written, before they are read back. */
  afterLoad?: (client: MongoClient, scratch: string, collections: string[]) => Promise<void>
  /** Tests only: the drop of the scratch database, the scratch names tried, the free disk space. */
  drop?: (db: Db, comment: string) => Promise<unknown>
  scratchName?: () => string
  freeBytes?: (client: MongoClient, db: string) => Promise<number | null>
  connectionStatus?: (client: MongoClient, comment: string) => Promise<Document | null>
}): JobKind<DrillJobParams> {
  const kill = deps.kill ?? killByComment
  const newScratch = deps.scratchName ?? (() => `mm_drill_${randomBytes(6).toString('hex')}`)
  const freeBytes = deps.freeBytes ?? freeSpace
  return {
    name: 'backup.drill',
    async run(job, p) {
      const ctx = deps.ctx()
      const started = ctx.now()
      const { store, limits } = ctx.backup
      const timeLeft = () => Math.max(1, limits.maxJobMs - (ctx.now() - started))
      // Only the owner's own backup: the row is looked up by its owner.
      const row = store.get(p.owner, p.backupId)
      if (!row || !row.complete) throw Errors.notFound('The backup is gone')
      const report: DrillReport = {
        kind: 'drill',
        backupId: row.id,
        backupName: row.name,
        ok: false,
        namespaces: [],
        startedAt: started,
        finishedAt: null,
        ...(p.schedule ? { schedule: { id: p.schedule.id, name: p.schedule.name } } : {}),
      }
      const connectionId = job.target.connectionId
      const client = await deps.client(connectionId)
      // Where a time series' buckets go on this server (series.ts).
      const version = await serverVersionOf(client)
      const parts = new PartTracker((v) => job.setParts(v))
      parts.start([], 'restore')
      const opts = { comment: job.comment }
      const byData = new Map<string, Ns>()
      const all: Ns[] = []
      // W4 review C1: the rules the backup was taken under (its header), with the connection's own.
      let backupRules: readonly PersonalRule[] = []
      // W4 review I2: set once a name no database has was chosen — only that database is ever dropped.
      let scratch = ''
      let db: Db | null = null
      try {
        // W4 review I2: the connection's user must be able to drop what the drill creates (a drill
        // that cannot clean up leaves a copy of the backup behind); asked before anything is written.
        const status = await (
          deps.connectionStatus ??
          ((c: MongoClient, comment: string) =>
            c.db('admin').command({ connectionStatus: 1, showPrivileges: true, comment }))
        )(client, job.comment).catch(() => null)
        // W4 review I2: a name no database has (case aside: MongoDB refuses names differing by case).
        const taken = new Set(
          (
            await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true })
          ).databases.map((d) => d.name.toLowerCase()),
        )
        let name = ''
        for (let i = 0; i < 5 && (!name || taken.has(name.toLowerCase())); i++) name = newScratch()
        if (taken.has(name.toLowerCase()))
          throw Errors.conflict('No free name was found for the scratch database', { reason: 'drill_failed' })
        // W4 re-review (minor): a right that cannot be read is not assumed.
        if (!status || !mayDropDatabases(status, name)) {
          report.code = 'drill_cleanup_rights'
          throw Errors.conflict(
            'The connection’s MongoDB user may not drop databases: the drill could not clean up after itself',
            { reason: 'drill_cleanup_rights' },
          )
        }
        // W4 review I2: what the drill writes stays under half the server's free disk space (the
        // documents, their indexes and the journal on top); a stored backup larger than that is not tried.
        // W4 re-review (minor): where the server does not say, an explicit cap (MM_BACKUP_DRILL_MAX_MB)
        // is the bound, or the drill does not run; with both, the smaller.
        // The backed-up database (a whole-server backup: the first of the connection's own).
        const statsDb =
          job.target.db !== '*'
            ? job.target.db
            : ((
                await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true })
              ).databases
                .map((d) => d.name)
                .find((n) => !['admin', 'local', 'config'].includes(n) && !DRILL_DB.test(n)) ?? 'admin')
        const disk = await freeBytes(client, statsDb)
        const cap = limits.drillMaxBytes
        if (disk === null && cap === null) {
          report.code = 'drill_space_unknown'
          throw Errors.conflict(
            'The server does not say how much disk space it has free: set MM_BACKUP_DRILL_MAX_MB to drill',
            { reason: 'drill_space_unknown' },
          )
        }
        const room = Math.min(disk === null ? Infinity : disk / 2, cap ?? Infinity)
        if (row.size > room) throw noSpace(report)
        scratch = name
        db = client.db(scratch)
        job.setStaging(DRILL_STAGING, { connectionId, db: scratch })
        report.scratch = scratch
        let written = 0
        const { events } = await openArchive(store, row, {
          keys: slotKeysFor(ctx, p.owner),
          signal: job.signal,
          follow: 'complete',
        })
        const flush = async (n: Ns) => {
          const docs = n.batch
          n.batch = []
          if (!docs.length || !n.into) return
          await db!
            .collection(n.into)
            .insertMany(docs, { ...opts, ordered: false, maxTimeMS: timeLeft(), ...n.raw })
          parts.update(`${n.db}.${n.coll}`, { done: n.archived })
        }
        for await (const e of events) {
          if (job.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
          if (ctx.now() - started > limits.maxJobMs)
            throw Errors.conflict('The drill ran longer than allowed')
          if (e.kind === 'header') backupRules = e.mongoManager?.rules ?? []
          else if (e.kind === 'meta') {
            const { db: from, coll, type, options } = e.meta
            const name = `${from}.${coll}`
            const n: Ns = { db: from, coll, type, into: null, archived: 0, sum: 0n, batch: [], crc: 'absent' }
            all.push(n)
            parts.add(name)
            if (type === 'view') {
              n.reason = 'A view holds no documents'
              parts.update(name, { state: 'skipped' })
              continue
            }
            // W4 × W8: a key vault (or Queryable Encryption metadata) is key material, never copied —
            // not even into a scratch database no one can open (a backup from before a connection
            // named it, or from elsewhere, may hold one).
            if (isEncryptionNamespace(from, coll)) {
              n.reason = 'Encryption keys and metadata are not restored, not even in a drill'
              parts.update(name, { state: 'skipped' })
              continue
            }
            if (Buffer.byteLength(scratch) + 1 + Buffer.byteLength(name) + 15 > MAX_SCRATCH_NS) {
              n.reason = 'The name is too long to restore under a scratch database'
              parts.update(name, { state: 'skipped' })
              continue
            }
            // W4 review C1: before a document is written, the scratch collection is covered by the
            // rules of what it holds — mapped to its scratch name, so whoever could reach it (no one
            // should: see isDrillScratch) meets them masked, as the normal restore makes sure.
            const own = ctx.personalFields.stored(connectionId).rules
            ctx.personalFields.addScratchRules(
              connectionId,
              scratch,
              [...rulesOn(backupRules, from, coll), ...rulesOn(own, from, coll)].map((r) => ({
                db: scratch,
                coll: name,
                field: r.field,
              })),
            )
            // The scratch collection is named after the namespace, so namespaces of several databases meet.
            if (type === 'timeseries') {
              // Review of the CI fixes (minor 4): never a guess at where the buckets go.
              if (!knownVersion(version))
                throw Errors.conflict(
                  'The server does not say its version, so a time series cannot be drilled',
                  {
                    reason: 'series_version',
                  },
                )
              const ts = (options as { timeseries?: Document }).timeseries
              await db.createCollection(name, { ...(ts ? { timeseries: ts } : {}), ...opts } as never)
              const data = seriesAccess(name, version)
              n.into = data.coll
              if (data.options.rawData) n.raw = { rawData: true }
              byData.set(`${from}.system.buckets.${coll}`, n)
            } else {
              await db.createCollection(name, opts as never)
              n.into = name
              byData.set(name, n)
            }
            parts.update(name, { state: 'running' })
          } else if (e.kind === 'doc') {
            const n = byData.get(`${e.db}.${e.coll}`)
            if (!n) continue
            written += e.raw.length
            if (written > room) throw noSpace(report)
            const doc = BSON.deserialize(e.raw, DESER)
            // What the restore writes, as the driver will write it: compared with what is read back.
            n.sum = (n.sum + digest(BSON.serialize(doc))) % MOD
            n.archived++
            n.batch.push(doc)
            if (n.batch.length >= BATCH) await flush(n)
          } else if (e.kind === 'end') {
            const ns = bucketsOf(e.coll) ? `${e.db}.system.buckets.${bucketsOf(e.coll)}` : `${e.db}.${e.coll}`
            const n = byData.get(ns) ?? byData.get(`${e.db}.${e.coll}`)
            if (!n) continue
            n.crc = e.crc
            await flush(n)
          }
        }
        for (const n of byData.values()) await flush(n)
        await deps.afterLoad?.(
          client,
          scratch,
          all.flatMap((n) => (n.into ? [n.into] : [])),
        )
        parts.phase('verify')
        for (const n of all) {
          const name = `${n.db}.${n.coll}`
          const out: DrillNamespaceReport = {
            ns: name,
            type: n.type,
            archived: n.archived,
            restored: 0,
            crc: n.crc,
            contents: 'skipped',
            ...(n.reason ? { reason: n.reason } : {}),
          }
          report.namespaces.push(out)
          if (!n.into) continue
          let sum = 0n
          const cursor = db
            .collection(n.into)
            .find({}, { ...opts, raw: true, maxTimeMS: timeLeft(), ...n.raw })
          try {
            for await (const raw of cursor) {
              out.restored++
              sum = (sum + digest(raw as unknown as Uint8Array)) % MOD
            }
          } finally {
            await cursor.close().catch(() => undefined)
          }
          out.contents = out.restored === n.archived && sum === n.sum ? 'match' : 'mismatch'
          parts.update(name, { state: out.contents === 'match' && n.crc !== 'mismatch' ? 'done' : 'failed' })
        }
        report.ok = report.namespaces.every((n) => n.contents !== 'mismatch' && n.crc !== 'mismatch')
        if (!report.ok) {
          report.code = 'drill_mismatch'
          throw Errors.conflict('The drill found namespaces whose restored data differ from the backup', {
            reason: 'drill_mismatch',
          })
        }
      } catch (e) {
        report.ok = false
        report.code ??= 'drill_failed'
        // MongoDB's words never go into an event; the report keeps a short reason for the owner.
        report.failure ??= e instanceof AppError ? e.message.slice(0, 300) : 'The restore did not complete'
        throw e
      } finally {
        parts.phase('cleanup')
        // W4 review I2: a scratch database that could not be dropped fails the drill, said as such.
        const dropped =
          !db ||
          (await (deps.drop ?? dropDb)(db, job.comment).then(
            () => true,
            () => false,
          ))
        if (dropped) {
          job.setStaging(null)
          // Kept while the scratch database may still be there (dropped at the next open).
          if (scratch) ctx.personalFields.dropScratchRules(connectionId, scratch)
        } else {
          report.cleanup = 'failed'
          if (report.ok) {
            report.ok = false
            report.code = 'drill_cleanup'
            report.failure = `The backup restored as it should, but the scratch database ${scratch} could not be dropped: drop it by hand`
          }
        }
        report.finishedAt = ctx.now()
        ctx.transfer.reports.save(job.id, p.owner, report, ctx.now() + limits.ttlMs)
        const mismatched = report.namespaces.filter((n) => n.contents === 'mismatch' || n.crc === 'mismatch')
        ctx.events.emit(report.ok ? 'backup.drill.passed' : 'backup.drill.failed', {
          // The data came back as they should and only the cleanup failed: a warning.
          severity: report.ok ? 'info' : report.code === 'drill_cleanup' ? 'warning' : 'critical',
          summary: report.ok
            ? `The restore drill of ${row.name} passed`
            : report.code === 'drill_cleanup'
              ? `The restore drill of ${row.name} passed, but its scratch database could not be dropped`
              : `The restore drill of ${row.name} failed`,
          connectionId,
          namespace: job.target.db === '*' ? null : job.target.db,
          ownerId: p.owner,
          details: {
            backup: row.id,
            namespaces: report.namespaces.length,
            mismatched: mismatched.length,
            reason: report.code ?? null,
            ...(p.schedule ? { schedule: p.schedule.id, run: p.schedule.runId } : {}),
          },
        })
        ctx.audit.append({
          action: 'backup.drill',
          outcome: report.ok ? 'success' : 'failure',
          userId: p.owner === 'local' ? null : p.owner,
          username: null,
          ip: null,
          connectionId,
          namespace: null,
          details: {
            job: job.id,
            backup: row.id,
            namespaces: report.namespaces.length,
            mismatched: mismatched.map((n) => n.ns).slice(0, 20),
            ...(report.cleanup ? { cleanup: report.cleanup, scratch } : {}),
            ...(p.schedule ? { schedule: p.schedule.id } : {}),
          },
        })
      }
      // Reached only when nothing else failed: the drill itself passed, its cleanup did not.
      if (report.cleanup === 'failed')
        throw Errors.conflict('The scratch database could not be dropped', { reason: 'drill_cleanup' })
    },
    async cancel(job) {
      const client = await deps.client(job.target.connectionId).catch(() => null)
      if (client) await kill(client, job.comment).catch(() => 0)
      return true
    },
    recover: () => 'interrupted',
  }
}
