import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  WATCH_REPLAY_PAGE,
  WATCH_REPLAY_PAGE_BYTES,
  type WatchEvent,
  type WatchRecording,
  type WatchRecordingPage,
} from '@mongo-manager/shared'
import type { FastifyRequest } from 'fastify'
import { Errors } from '../errors'
import { parseInput } from '../validate'
import { isRestricted, requireConnection, requireExport } from '../connections/access'
import { ownerOf, type TransferFile } from '../transfer/files'
import { RECORDING_JOB } from '../changestreams/recording'
import { sendTransferFile } from './transfer'

const Params = z.object({ id: z.string().min(1).max(64) })
const FileParams = Params.extend({ fileId: z.uuid() })
const PageQuery = z.object({
  from: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(WATCH_REPLAY_PAGE).default(WATCH_REPLAY_PAGE),
})
const NEWLINE = 0x0a

/**
 * W4.7 (completion design §2 W4.7): a viewer's recorded feeds of a connection — listed, replayed
 * or downloaded (NDJSON, as recorded), deleted. They are the recording viewer's own transfer files:
 * nobody else, administrators included, may read them. A download (and a replay, which reads the same
 * file) needs the export right now; an unmasked recording is not given to a viewer restricted since,
 * nor a masked one once the connection's rules moved (it was masked under others).
 */
export async function watchRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  const files = () => ctx.transfer.files
  const isRecording = (f: TransferFile, connectionId: string) =>
    f.kind === 'export' && f.connectionId === connectionId && RECORDING_JOB.test(f.jobId ?? '')
  const view = (f: TransferFile): WatchRecording => ({
    id: f.id,
    name: f.name,
    namespace: f.namespace,
    size: f.size,
    createdAt: f.createdAt,
    expiresAt: f.expiresAt,
    masked: f.masked,
    recording: !f.complete,
  })

  app.get(
    '/connections/:id/watch/recordings',
    // Names, sizes and times only.
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request): Promise<WatchRecording[]> => {
      const { id } = parseInput(Params, request.params)
      return files()
        .listFor(ownerOf(request.principal!), id)
        .filter((f) => isRecording(f, id) && f.expiresAt > ctx.now())
        .map(view)
    },
  )

  const recording = (owner: string, id: string, fileId: string): TransferFile => {
    const f = files().get(owner, fileId)
    if (!f || !isRecording(f, id) || f.expiresAt <= ctx.now()) throw Errors.notFound('Recording not found')
    return f
  }

  /** The caller's recording, as they may read it now (the download's and the replay's checks). */
  const readable = (request: FastifyRequest): TransferFile => {
    const { id, fileId } = parseInput(FileParams, request.params)
    const principal = request.principal!
    const f = recording(ownerOf(principal), id, fileId)
    if (!f.masked && isRestricted(ctx, principal, id))
      throw Errors.forbidden('Personal values are hidden from you on this connection now', {
        reason: 'masked_now',
      })
    if (f.masked && f.rulesVersion !== ctx.personalFields.get(id).version)
      throw Errors.conflict('The personal-field rules changed since it was recorded', {
        reason: 'rules_changed',
      })
    return f
  }

  app.get(
    '/connections/:id/watch/recordings/:fileId',
    // The events as recorded: masked ones stay masked; unmasked ones are refused to a restricted viewer.
    { preHandler: requireExport(), config: { masking: 'guarded', audit: 'watch.recording' } },
    async (request, reply) => {
      const f = readable(request)
      request.auditInfo = { details: { file: f.id, size: f.size, masked: f.masked } }
      return sendTransferFile(reply, f, files(), f.name)
    },
  )

  // W4 review I9: a replay reads the recording a page at a time (at most 500 events, 2 MiB) from a
  // place the previous page gave; a last line still being written is left for the next page. The
  // first page is audited as a download is.
  app.get(
    '/connections/:id/watch/recordings/:fileId/events',
    { preHandler: requireExport(), config: { masking: 'guarded' } },
    async (request): Promise<WatchRecordingPage> => {
      const f = readable(request)
      const { from, limit } = parseInput(PageQuery, request.query ?? {})
      if (from === 0)
        ctx.audit.append({
          action: 'watch.recording',
          outcome: 'success',
          userId: request.principal!.kind === 'user' ? request.principal!.userId : null,
          username: null,
          ip: request.ip,
          connectionId: f.connectionId,
          namespace: f.namespace,
          details: { file: f.id, size: f.size, masked: f.masked, replay: true },
        })
      const handle = await files().openRead(f)
      try {
        const size = (await handle.stat()).size
        if (from > size) throw Errors.validation('That place is past the end of the recording')
        const buf = Buffer.alloc(Math.min(WATCH_REPLAY_PAGE_BYTES, size - from))
        const { bytesRead } = await handle.read(buf, 0, buf.length, from)
        const events: WatchEvent[] = []
        let at = 0
        while (events.length < limit) {
          const nl = buf.indexOf(NEWLINE, at)
          if (nl < 0 || nl >= bytesRead) break
          const line = buf.subarray(at, nl).toString('utf8')
          at = nl + 1
          if (line.trim() === '') continue
          try {
            events.push(JSON.parse(line) as WatchEvent)
          } catch {
            // A damaged line: left out, the rest still read.
          }
        }
        // One line larger than a page cannot be read whole: it is passed over.
        if (at === 0 && bytesRead === WATCH_REPLAY_PAGE_BYTES) at = bytesRead
        const next = from + at
        // The end: the whole rest of the file was read and holds no further whole line.
        const end = from + bytesRead >= size && buf.subarray(at, bytesRead).indexOf(NEWLINE) < 0
        return { events, next, end }
      } finally {
        await handle.close()
      }
    },
  )

  app.delete(
    '/connections/:id/watch/recordings/:fileId',
    { preHandler: requireConnection('documents:read'), config: { masking: 'names-only' } },
    async (request, reply) => {
      const { id, fileId } = parseInput(FileParams, request.params)
      const owner = ownerOf(request.principal!)
      const f = recording(owner, id, fileId)
      files().delete(owner, f.id)
      return reply.status(204).send()
    },
  )
}
