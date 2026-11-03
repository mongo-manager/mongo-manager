import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Transform } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { AppError, Errors } from '../errors'
import type { JobKind } from '../jobs/types'
import type { ServerContext, TransferEntry } from '../http/context'
import { safeEqual } from '../http/security'
import { adapterFor, registryDeps } from './destinations/registry'
import { RETRY_DELAYS, isRetryable } from './destinations/retry'
import { DestinationError } from './destinations/types'
import { EgressError, scrubText } from '../net/egress'

export interface FetchJobParams {
  owner: string
  userId: string | null
  destinationId: string
  key: string
  uploadId: string
  expectSha256: string | null
  size: number
}

const reasonOf = (e: unknown): string | undefined =>
  e instanceof DestinationError || e instanceof EgressError
    ? e.reason
    : e instanceof AppError
      ? (e.details as { reason?: string } | undefined)?.reason
      : undefined

/**
 * Final review B26: failures after which the bytes already here are no part of the file a new fetch
 * would get (a digest that differs, a file gone or longer than said, a destination deleted).
 */
const DISCARD = new Set([
  'verify',
  'not_found',
  // Short names review 14 (M2): a deleted destination, said as one.
  'destination_deleted',
  'path',
  // Short names review 6 (M-4): a folder refused for its name is a folder refusal like `path`.
  'path_name',
  'too_large',
  'upload_overflow',
  'upload_gone',
])

/**
 * Phase 3d-3b spec §4.2: download into a growing upload row (3d-3a's inspection reads it as it
 * grows), never past the declared size, resuming with Range; complete only when the digest matches.
 */
export function fetchKind(deps: { ctx: () => ServerContext }): JobKind<FetchJobParams> {
  return {
    name: 'backup.fetch',
    async run(job, p) {
      const ctx = deps.ctx()
      const { store, destinations, slots, transfers, limits } = ctx.backup
      // Final review B9: the job time limit holds for fetches too.
      const deadline = AbortSignal.timeout(limits.maxJobMs)
      const signal = AbortSignal.any([job.signal, deadline])
      const entry: TransferEntry = {
        kind: 'fetch',
        userId: p.userId,
        destinationIds: [p.destinationId],
        uploadId: p.uploadId,
        waiting: new Set(),
      }
      transfers.set(job.id, entry)
      // Final review B9: the sweeper never takes the upload from under a running fetch.
      const unhold = store.hold(p.uploadId)
      let ok = false
      let keep = false
      try {
        const record = destinations.get(p.destinationId)
        if (!record) throw new DestinationError('destination_deleted', 'The destination was deleted')
        const received = () => store.byId(p.uploadId)?.size ?? 0
        const release = await slots.acquire(p.destinationId, signal, () => {
          entry.waiting!.add(p.destinationId)
          job.progress(received(), p.size)
        })
        if (entry.waiting!.delete(p.destinationId)) job.progress(received(), p.size)
        try {
          const adapter = adapterFor(record, destinations.secrets(p.destinationId), registryDeps(ctx))
          let failures = 0
          for (;;) {
            const row = store.byId(p.uploadId)
            if (!row) throw Errors.conflict('The download was discarded', { reason: 'upload_gone' })
            if (row.size >= p.size) break
            const before = row.size
            try {
              const stream = await adapter.get(p.key, before, signal)
              let got = 0
              const counted = stream.pipe(
                new Transform({
                  transform(chunk: Buffer, _e, cb) {
                    got += chunk.length
                    job.progress(before + got, p.size)
                    cb(null, chunk)
                  },
                }),
              )
              stream.on('error', (e) => counted.destroy(e))
              // Full server run, 2026-10-20: the store reads the part only after its own checks (and
              // may refuse it unread). A failure before then is this attempt's, which the store's
              // reading sees once it reads; never an uncaught error, which would end the server.
              counted.on('error', () => undefined)
              const stop = () => stream.destroy(new Error('Cancelled'))
              signal.addEventListener('abort', stop, { once: true })
              try {
                await store.appendUpload({
                  owner: p.owner,
                  id: p.uploadId,
                  offset: before,
                  body: counted,
                  byJob: true,
                })
              } finally {
                signal.removeEventListener('abort', stop)
                // Read to its end or not (a refused part was never read), the provider's stream is let go of.
                stream.destroy()
                counted.destroy()
              }
            } catch (e) {
              const transient =
                isRetryable(e) ||
                (e instanceof AppError && ['upload_aborted', 'upload_idle'].includes(String(reasonOf(e))))
              if (signal.aborted || !transient || ++failures > RETRY_DELAYS.length) throw e
              await sleep(RETRY_DELAYS[failures - 1]!, undefined, { signal })
              continue
            }
            // A provider that ends early sends nothing more: counted as a failure, so it cannot loop.
            if ((store.byId(p.uploadId)?.size ?? 0) === before && ++failures > RETRY_DELAYS.length)
              throw new DestinationError('provider', 'The destination stopped sending the file')
          }
          const row = store.byId(p.uploadId)!
          const h = createHash('sha256')
          for await (const c of createReadStream(store.pathOf(row), { signal })) h.update(c as Buffer)
          const sha = h.digest('hex')
          // D12: a file whose digest differs is removed, so a restore can never start from it.
          if (p.expectSha256 && !safeEqual(sha, p.expectSha256))
            throw new DestinationError(
              'verify',
              'The downloaded file differs from the one that was sent; it was removed',
            )
          store.finishFetched(p.uploadId, sha)
          ok = true
        } finally {
          release()
        }
      } catch (e) {
        // Final review B26: a download that broke keeps its bytes, and a new fetch of the same file
        // by the same user resumes them; a cancelled one, and one no longer worth resuming, do not.
        // Nothing received is nothing to resume (and the declared size would hold the quota for nothing).
        keep =
          !job.signal.aborted && !DISCARD.has(String(reasonOf(e))) && (store.byId(p.uploadId)?.size ?? 0) > 0
        if (deadline.aborted && !job.signal.aborted)
          throw Errors.conflict('The download ran longer than allowed', { reason: 'job_time' })
        // The job row shows AppError messages only: a destination's failure is said in its own words.
        if (e instanceof DestinationError || e instanceof EgressError)
          throw Errors.conflict(scrubText(e.message), { reason: e.reason })
        throw e
      } finally {
        unhold()
        transfers.delete(job.id)
        if (!ok && !keep) store.delete(p.owner, p.uploadId)
      }
    },
    cancel: async () => true,
    recover: () => 'interrupted',
  }
}
