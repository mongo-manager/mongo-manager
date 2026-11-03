import type { AgentVia } from '../ai/agent/calls'
import { BSON, type Document } from 'bson'
import type { MongoClient } from 'mongodb'
import type { BackupFormat, BackupScope, DumpReport, DumpStart } from '@mongo-manager/shared'
import { Errors } from '../errors'
import type { JobKind } from '../jobs/types'
import { PartTracker } from '../jobs/parts'
import type { Principal, ServerContext } from '../http/context'
import { currentPrincipal, noteJob, startSend } from './send-job'
import { assertBackupAccess } from './access'
import { killByComment } from '../data/operations'
import { READ_OPTIONS } from '../data/ejson-io'
import { maskWith } from '../transfer/copy-job'
import { BATCH_DOCS } from '../transfer/limits'
import { VERSION } from '../version'
import type { PreparedDump } from './dump-plan'
import { createDumpSink } from './pipeline'
import { dumpToolArgs, toolsComplete } from './dump-plan'
import { spawnTool, toolFailure, withToolConfig } from './tools'
import { finished } from 'node:stream/promises'
import type { NamespaceMeta } from './archive-writer'
import { seriesAccess } from './series'

export interface DumpJobParams {
  owner: string
  request: Omit<DumpStart, 'password'>
  /** In memory only: the runner keeps params in memory; the jobs table has no params column. */
  password: string | null
  prepared: PreparedDump
  fileName: string
  /** Phase 3d-3b, in memory only: the caller, to queue the send with their access when the dump completes. */
  sendAs: Principal | null
  /** Phase 3d-3c, in memory only: the owner's backup key for a scheduled .mmbak (a server slot); wiped at the end. */
  serverKey?: { keyId: string; key: Buffer } | null
  /** Review of B6 (M1): the agent's turn the backup was started for (its end's rows name it). */
  agent?: AgentVia | null
  /** Phase 3d-3c: the schedule and run this dump is for; `keep`: "keep on the server too". */
  schedule?: { id: string; name: string; runId: string; keep: boolean } | null
}

const EXT: Record<BackupFormat, string> = { archive: '.archive', gzip: '.archive.gz', mmbak: '.mmbak' }
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const MiB = 1024 * 1024

/** "shop-20261003-143005.mmbak", "shop.orders-….archive.gz", "server-….archive". */
export function backupFileName(scope: BackupScope, format: BackupFormat, now: number): string {
  const base =
    scope.kind === 'collection'
      ? `${scope.db}.${scope.coll}`
      : scope.kind === 'database'
        ? scope.db
        : 'server'
  return `${base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)}-${stamp(now)}${EXT[format]}`
}

const asBuffer = (raw: unknown): Buffer => {
  const u = raw as Uint8Array
  return Buffer.from(u.buffer, u.byteOffset, u.byteLength)
}

/** Phase 3d-3a spec §5.1, §7.2: the dump job. */
export function dumpKind(deps: {
  client: (connectionId: string) => Promise<MongoClient>
  ctx: () => ServerContext
  kill?: (client: MongoClient, comment: string) => Promise<number>
}): JobKind<DumpJobParams> {
  const kill = deps.kill ?? killByComment
  return {
    name: 'backup.dump',
    async run(job, p) {
      const ctx = deps.ctx()
      // Phase 3d-3c: the jobs tray names the schedule (plan ruling 29); the room leaves it out.
      if (p.schedule) noteJob(ctx, job.id, { schedule: { id: p.schedule.id, name: p.schedule.name } })
      const { store, limits } = ctx.backup
      const started = ctx.now()
      const timeLeft = () => Math.max(1, limits.maxJobMs - (ctx.now() - started))
      const { prepared, request: r } = p
      const included = prepared.pairs.filter((x) => !x.skipped)
      // W4.4 (3d-3a U8): progress per namespace while the dump runs.
      const parts = new PartTracker((v) => job.setParts(v))
      const nsName = (x: { db: string; coll: string }) => `${x.db}.${x.coll}`
      parts.start(included.map(nsName), 'dump')
      const { row, path } = store.reserveBackup({
        owner: p.owner,
        jobId: job.id,
        connectionId: job.target.connectionId,
        name: p.fileName,
        scheduleId: p.schedule?.id ?? null,
        meta: {
          scope: r.scope,
          engine: r.engine,
          format: r.format,
          masked: prepared.masked,
          anonymous: r.anonymous,
          namespaces: included.length,
          startedAt: started,
          finishedAt: null,
          rulesVersion: prepared.versions.source,
          personal: included.some((p) => p.personal.length > 0),
          // Re-review of B2 (nit 7): for a database's backup only (a server's is restored from Backups).
          ...(r.scope.kind === 'database'
            ? { included: included.map((x) => ({ db: x.db, coll: x.coll })) }
            : {}),
          ...(p.serverKey ? { keyId: p.serverKey.keyId } : {}),
        },
      })
      const report: DumpReport = {
        kind: 'dump',
        scope: r.scope,
        engine: r.engine,
        format: r.format,
        namespaces: prepared.plan.namespaces.map((n) => ({ ...n, written: 0 })),
        backupId: null,
        size: 0,
        sha256: null,
        masked: prepared.masked,
        anonymous: r.anonymous,
        startedAt: started,
        finishedAt: null,
        throughput: null,
        versions: prepared.versions,
        // A restricted caller's dump is masked by the restriction; an anonymous one is not "restricted".
        restricted: { source: prepared.masked && !r.anonymous },
      }
      let lastGrow = 0
      const sink = createDumpSink({
        path,
        format: r.format,
        ...(p.password ? { password: p.password } : {}),
        ...(p.serverKey ? { serverKey: p.serverKey } : {}),
        chunkBytes: r.chunkMb ? r.chunkMb * MiB : limits.chunkBytes,
        tool: { name: 'mongo-manager', version: VERSION },
        now: started,
        onBytes: (total) => {
          // The quotas count the file while it is written; over them, the dump stops (B17).
          if (total - lastGrow >= MiB) {
            lastGrow = total
            store.grow(row.id, p.owner, total)
          }
        },
      })
      let bytesRead = 0
      let ok = false
      const complete = async () => {
        await sink.writer.finish()
        const done = await sink.done()
        const finished = ctx.now()
        store.completeBackup(row.id, { ...done, finishedAt: finished })
        report.backupId = row.id
        report.size = done.size
        report.sha256 = done.sha256
        report.finishedAt = finished
        report.throughput = bytesRead / Math.max(0.001, (finished - started) / 1000)
        job.progress(bytesRead, bytesRead)
        ok = true
      }
      /** Spec §5.3: mongodump writes the archive to stdout; it is compressed, encrypted and kept as ours. */
      const viaTools = async () => {
        const found = prepared.found
        const record = ctx.connections.get(job.target.connectionId)
        if (!found || !record)
          throw Errors.conflict('The backup tools are not available', { reason: 'tools_unavailable' })
        const release = ctx.backup.tools.acquire()
        const log: string[] = []
        // Final review minor 8: the tool stops with the job, and as soon as its output cannot be written
        // (the quota, a full disk), instead of running to its end on a tool slot.
        const stop = new AbortController()
        let outputFailed: Error | null = null
        const onJobAbort = () => stop.abort()
        job.signal.addEventListener('abort', onJobAbort, { once: true })
        let toolOut: { destroy(): void } | null = null
        const onSinkGone = (e?: Error) => {
          outputFailed ??= e ?? new Error('The backup output closed')
          // Closing our end first: the tool's next write fails at once, before the kill lands.
          toolOut?.destroy()
          stop.abort()
        }
        sink.input.once('error', onSinkGone)
        sink.input.once('close', () => {
          if (!sink.input.writableEnded) onSinkGone()
        })
        try {
          const code = await withToolConfig(
            record.settings,
            async (configArgs) => {
              const { stdout, exit } = spawnTool(
                found.dump,
                [
                  ...configArgs,
                  '--archive',
                  ...dumpToolArgs(r.scope, included, toolsComplete(r.scope, prepared.pairs)),
                ],
                {
                  stdin: null,
                  signal: stop.signal,
                  timeoutMs: timeLeft(),
                  ...(ctx.backup.spawnImpl ? { spawnImpl: ctx.backup.spawnImpl } : {}),
                  onLine: (line) => {
                    log.push(line)
                    if (log.length > 50) log.shift()
                    // "done dumping `shop.orders` (300 documents)" (older tools write it without quotes)
                    const m = /done dumping `?([^`.\s]+)\.([^`\s]+?)`? \((\d+) documents?\)/.exec(line)
                    const n = m
                      ? report.namespaces.find(
                          (x) => x.db === m[1] && (x.coll === m[2] || `system.buckets.${x.coll}` === m[2]),
                        )
                      : undefined
                    if (n) {
                      n.written = Number(m![3])
                      parts.update(nsName(n), { state: 'done', done: n.written })
                    }
                  },
                },
              )
              stdout.on('data', (c: Buffer) => {
                bytesRead += c.length
              })
              toolOut = stdout
              if (outputFailed) stdout.destroy()
              stdout.pipe(sink.input, { end: false })
              const [status] = await Promise.all([exit, finished(stdout).catch(() => undefined)])
              return status
            },
            ctx.backup.toolsTmp,
          )
          report.toolLog = log
          // The output's own failure says more than the killed tool's exit code.
          if (outputFailed) throw outputFailed
          if (code !== 0)
            throw Errors.conflict(`mongodump failed (exit ${code}): ${toolFailure(log)}`, {
              reason: 'tool_failed',
            })
        } finally {
          job.signal.removeEventListener('abort', onJobAbort)
          release()
        }
      }
      try {
        if (r.engine === 'tools') {
          await viaTools()
          if (job.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
          // The archive came from the tool: only the sink's end remains.
          const done = await sink.done()
          const finishedAt = ctx.now()
          store.completeBackup(row.id, { ...done, finishedAt })
          report.backupId = row.id
          report.size = done.size
          report.sha256 = done.sha256
          report.finishedAt = finishedAt
          report.throughput = bytesRead / Math.max(0.001, (finishedAt - started) / 1000)
          // The tool names each namespace it finished; any it did not name finished with it.
          for (const x of included) {
            const out = report.namespaces.find((n) => n.db === x.db && n.coll === x.coll)
            parts.update(nsName(x), { state: 'done', done: out?.written ?? 0 })
          }
          ok = true
          return
        }
        // Twelfth review of explain masking (I3): where the plan hid the size from its caller, the
        // progress counts what has been read, never the stored size still to come.
        const total =
          prepared.plan.estimate.bytes === null ? 0 : included.reduce((s, x) => s + (x.bytes ?? 0), 0)
        job.setEstimate(included.reduce((s, x) => s + (x.documents ?? 0), 0))
        const metas: NamespaceMeta[] = included.map((x) => ({
          db: x.db,
          coll: x.coll,
          type: x.type,
          options: x.options,
          indexes: x.indexes,
          ...(x.uuid ? { uuid: x.uuid } : {}),
        }))
        await sink.writer.begin(
          {
            serverVersion: prepared.serverVersion,
            toolVersion: `mongo-manager ${VERSION}`,
            mongoManager: { ...prepared.header, startedAt: started },
          },
          metas,
        )
        for (const x of included) {
          if (job.signal.aborted) break
          const out = report.namespaces.find((n) => n.db === x.db && n.coll === x.coll)!
          // A time series' buckets: where mongodump keeps them for this server's version (series.ts).
          const data =
            x.type === 'timeseries'
              ? seriesAccess(x.coll, prepared.serverVersion)
              : { coll: x.coll, options: {} }
          parts.update(nsName(x), { state: 'running', total: x.documents ?? null })
          await sink.writer.open(x.db, data.coll)
          if (x.type !== 'view') {
            const coll = prepared.client.db(x.db).collection(data.coll)
            const common = {
              batchSize: BATCH_DOCS,
              comment: job.comment,
              maxTimeMS: timeLeft(),
              ...data.options,
            }
            // A masked namespace goes through the gate's read and the mask; any other is copied raw.
            const masked = x.mask !== null || x.read !== null
            const cursor = masked
              ? coll.find(x.read?.filter ?? {}, { ...READ_OPTIONS, ...(x.read?.options ?? {}), ...common })
              : coll.find({}, { ...common, raw: true })
            try {
              for await (const item of cursor) {
                if (job.signal.aborted) break
                if (ctx.now() - started > limits.maxJobMs)
                  throw Errors.conflict('The backup ran longer than allowed')
                let raw: Buffer
                if (masked) {
                  const doc = x.read?.finish ? x.read.finish([item as Document])[0] : (item as Document)
                  if (!doc) continue
                  raw = Buffer.from(BSON.serialize(x.mask ? maskWith(doc, x.mask) : doc))
                } else raw = asBuffer(item)
                bytesRead += raw.length
                await sink.writer.write(raw)
                out.written++
                if (out.written % 1000 === 0) {
                  job.progress(bytesRead, Math.max(total, bytesRead))
                  parts.update(nsName(x), { done: out.written })
                }
              }
            } finally {
              await cursor.close().catch(() => undefined)
            }
            // Review of the CI fixes (minor 4): a time series whose buckets read as none while it
            // holds measurements was read in the wrong place; it is never kept as an empty one.
            // Second review (minor 4): its buckets are read once more, so a first measurement written
            // meanwhile is no failure.
            const opts = { comment: job.comment, maxTimeMS: timeLeft() }
            if (
              x.type === 'timeseries' &&
              out.written === 0 &&
              !job.signal.aborted &&
              (await prepared.client
                .db(x.db)
                .collection(x.coll)
                .countDocuments({}, { limit: 1, ...opts })) > 0 &&
              (await coll.findOne({}, { ...opts, ...data.options, projection: { _id: 1 } })) === null
            )
              throw Errors.conflict(`The time series ${nsName(x)} read as empty though it holds data`, {
                reason: 'series_unread',
              })
          }
          await sink.writer.close()
          parts.update(nsName(x), {
            state: job.signal.aborted ? 'failed' : 'done',
            done: out.written,
            ...(x.documents !== undefined && x.documents !== null
              ? { total: Math.max(x.documents, out.written) }
              : {}),
          })
          // An unmasked dump stops when the source's rules move under it (3d-2 spec §5.2).
          if (
            !prepared.masked &&
            ctx.personalFields.get(job.target.connectionId).version !== prepared.versions.source
          )
            throw Errors.conflict('The personal-field rules changed; start the backup again', {
              reason: 'rules_changed',
            })
        }
        if (job.signal.aborted) throw Errors.conflict('Cancelled', { reason: 'cancelled' })
        await complete()
      } catch (e) {
        sink.abort(e as Error)
        throw e
      } finally {
        p.serverKey?.key.fill(0)
        if (!ok) store.delete(p.owner, row.id)
        // Plan ruling 15: a "keep on the server too" schedule's copy is retention's, not the TTL's.
        else if (p.schedule?.keep) store.retain(row.id)
        if (ok && p.sendAs && r.destinations.length) {
          // Spec §1.2: the send starts when the backup is kept; its checks run again (grants may have moved).
          const audit = (outcome: 'success' | 'failure', details: Record<string, unknown>) =>
            ctx.audit.append({
              action: 'backup.send.start',
              outcome,
              userId: p.sendAs!.kind === 'user' ? p.sendAs!.userId : null,
              username: null,
              ip: null,
              connectionId: job.target.connectionId,
              namespace: null,
              details: {
                ...(p.agent ? { agent: { ...p.agent } } : {}),
                backup: row.id,
                destinations: r.destinations,
                deleteLocal: r.deleteLocal,
                dump: job.id,
                ...(p.schedule ? { schedule: p.schedule.id } : {}),
                ...details,
              },
            })
          try {
            // Final review B4: as the account stands now, with the 3d-3a download checks (D8).
            const principal = currentPrincipal(ctx, p.sendAs)
            const kept = store.byId(row.id)!
            assertBackupAccess(ctx, principal, kept)
            // Final review B3: this dump still counts as running; it does not take its own send's room.
            const send = startSend(ctx, principal, kept, r.destinations, r.deleteLocal, {
              exceptJob: job.id,
              ...(p.schedule ? { scheduled: { id: p.schedule.id, name: p.schedule.name } } : {}),
            })
            report.sendJobId = send.id
            // Final review B5 (spec §4.7): a queued send is audited like one started by hand.
            audit('success', { job: send.id })
          } catch (e) {
            report.sendJobId = null
            report.sendError = e instanceof Error ? e.message : 'The send could not start'
            audit('failure', { error: report.sendError })
          }
        }
        ctx.transfer.reports.save(job.id, p.owner, report, ctx.now() + limits.ttlMs)
        ctx.audit.append({
          action: 'backup.dump',
          outcome: ok ? 'success' : 'failure',
          userId: p.owner === 'local' ? null : p.owner,
          username: null,
          ip: null,
          connectionId: job.target.connectionId,
          namespace: r.scope.kind === 'server' ? null : r.scope.db,
          details: {
            ...(p.agent ? { agent: { ...p.agent } } : {}),
            job: job.id,
            scope: r.scope.kind,
            engine: r.engine,
            format: r.format,
            masked: report.masked,
            anonymous: r.anonymous,
            size: report.size,
          },
        })
      }
    },
    async cancel(job) {
      const client = await deps.client(job.target.connectionId).catch(() => null)
      if (client) await kill(client, job.comment).catch(() => 0)
      return true
    },
    recover: () => 'interrupted',
  }
}
