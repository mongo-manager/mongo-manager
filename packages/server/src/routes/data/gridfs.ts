import type { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { EJSON, calculateObjectSize } from 'bson'
import { Binary, GridFSBucket, ObjectId, type Collection, type Document } from 'mongodb'
import {
  BucketNameSchema,
  bsonClassOf,
  GRIDFS_MAX_SKIP,
  GridFsFileIdSchema,
  GridFsListQuerySchema,
  GridFsPatchSchema,
  GridFsUploadQuerySchema,
  isSpoofingChar,
  type GridFsFile,
  type GridFsPage,
} from '@mongo-manager/shared'
import { AppError, Errors } from '../../errors'
import { parseInput } from '../../validate'
import { requireConnection } from '../../connections/access'
import { clientFor, toAppError, withMongo } from '../../data/mongo-errors'
import {
  READ_OPTIONS,
  ejsonHazards,
  exactId,
  fromClient,
  hashDocument,
  refuseHazards,
  toClient,
} from '../../data/ejson-io'
import { safeEqual } from '../../http/security'
import { MASK, maskDocument } from '../../masking/document'
import type { NsMasker } from '../../masking/match'
import { notSupported, personalField } from '../../masking/gate/refusal'
import { PERSONAL_FIELD, guardFind } from '../../masking/gate'
import { gateFor, viewAwareMaskerFor } from '../../masking/restricted'
import { bucketLocked } from '../../masking/modes'
import { contentDisposition } from '../transfer'
import { asText, sniffMedia, wholeCharacters } from '../../data/sniff'
import { DbParams, assertTargetAllowed } from './params'
import { holdReadSlot } from '../../data/page'

const BucketParams = DbParams.extend({ bucket: BucketNameSchema })
const FileParams = BucketParams.extend({ fileId: GridFsFileIdSchema })
const MB = 1024 * 1024
/** GridFS's own chunk size (255 KiB): files written here read like any other. */
const CHUNK = 255 * 1024
/** A metadata document stays small: it describes a file, it is not one. */
const METADATA_BYTES = 16 * 1024
const LIST_MS = 10_000
/** A preview: the start of a text, an image, or a sound or video, each at most this large. */
const PREVIEW_TEXT_BYTES = 256 * 1024
const PREVIEW_IMAGE_BYTES = 10 * MB
const PREVIEW_MEDIA_BYTES = 50 * MB
/** A downloaded file's name: long enough for any real name, short enough for a header. */
const NAME_CHARS = 200

/** A file's `_id` for a URL: its canonical EJSON, base64url (any type of id, ObjectId or not). */
const idToUrl = (id: unknown) =>
  Buffer.from(EJSON.stringify(id as never, { relaxed: false })).toString('base64url')
/**
 * A file's `_id` from a URL: a value, never a query operator (4b review C1: `{"$ne":null}` reached
 * every file of a bucket). Used only as `{ _id: { $eq: id } }`.
 */
function idFromUrl(text: string): unknown {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
  } catch {
    throw Errors.validation('Not a file id')
  }
  return exactId(json)
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a field of `<bucket>.files`, or anything in it, is personal data for this user. */
const personal = (ns: NsMasker | undefined, field: string) =>
  !!ns && (ns.matches([field]) || ns.under([field]))

/**
 * A stored name as a download's name: what fakes a name's form shown as `_`, and bounded (its
 * extension kept), whatever wrote it (4b review M4, M5).
 */
function downloadName(name: string): string {
  const chars = [...name].map((c) => (isSpoofingChar(c.codePointAt(0)!) ? '_' : c))
  if (chars.length <= NAME_CHARS) return chars.join('') || 'file'
  const clean = chars.join('')
  const dot = clean.lastIndexOf('.')
  const ext = dot > 0 && clean.length - dot <= 16 ? [...clean.slice(dot)] : []
  return chars.slice(0, NAME_CHARS - ext.length).join('') + ext.join('')
}

/** Metadata keys MongoDB would read as an operator or a path (4b review M8). */
function assertPlainKeys(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertPlainKeys)
  if (!value || typeof value !== 'object' || value instanceof Date || bsonClassOf(value) !== undefined) return
  for (const [key, v] of Object.entries(value)) {
    if (key.startsWith('$') || key.includes('.'))
      throw Errors.validation('A metadata key may not start with "$" or hold a "."')
    assertPlainKeys(v)
  }
}

/** The indexes GridFS readers expect, made as the driver does: on a bucket's first file. */
async function ensureIndexes(files: Collection, chunks: Collection): Promise<void> {
  if (await files.findOne({}, { projection: { _id: 1 } })) return
  const has = async (c: Collection, key: Document) => {
    try {
      return (await c.listIndexes().toArray()).some((i) => JSON.stringify(i.key) === JSON.stringify(key))
    } catch {
      return false // No collection yet.
    }
  }
  if (!(await has(files, { filename: 1, uploadDate: 1 })))
    await files.createIndex({ filename: 1, uploadDate: 1 })
  if (!(await has(chunks, { files_id: 1, n: 1 })))
    await chunks.createIndex({ files_id: 1, n: 1 }, { unique: true })
}

/**
 * Phase 4b §1: GridFS buckets as files. Reading lists and downloads (a restricted user lists them
 * masked by the `<bucket>.files` rules and may not download where a rule reaches the bucket: the
 * content can hold anything); writing uploads, renames, describes and deletes — never for a
 * restricted user where a rule reaches the bucket, nor on a read-only connection, nor in a system
 * database without the connection's admin role. User report 2026-10-27: a bucket no rule reaches
 * holds no personal data by the rules, and is anyone's to use who may read or write there.
 */
/**
 * The chunks of the file with this id. Data review 2026-10-13 (M7): `$eq: null` would also match
 * every chunk that names no file.
 */
const chunksOf = (id: unknown) => (id === null ? { $type: 'null' } : { $eq: id })

/** A count or size as stored: an int, a long or a double. */
const num = (v: unknown): number =>
  typeof v === 'number'
    ? v
    : v && typeof (v as { toNumber?: unknown }).toNumber === 'function'
      ? (v as { toNumber(): number }).toNumber()
      : Number(v ?? 0)

/**
 * Sets a file's fields; with `pinMetadata`, only while its metadata is still exactly the version
 * read — compared as stored, whatever the bucket's collation (round 2, M4). Whether it was set.
 */
export async function setFileFields(
  files: Collection,
  doc: Document,
  set: Document,
  pinMetadata: boolean,
): Promise<boolean> {
  const pin = pinMetadata
    ? { $expr: { $eq: [{ $ifNull: ['$metadata', null] }, { $literal: doc.metadata ?? null }] } }
    : {}
  const result = await files.updateOne(
    { _id: { $eq: doc._id }, ...pin },
    { $set: set },
    { collation: { locale: 'simple' } },
  )
  return result.matchedCount > 0
}

/** What a list of files shows: nothing else of a files document is read for it (round 2, I6). */
const SHOWN_FIELDS = { filename: 1, length: 1, chunkSize: 1, uploadDate: 1, contentType: 1, metadata: 1 }

/** A file's metadata as a document of its own: empty when the file has none. */
const metadataOf = (doc: Document): Document => ('metadata' in doc ? { metadata: doc.metadata } : {})

const fileChanged = () =>
  new AppError(
    'DOCUMENT_CHANGED',
    'The file was changed by someone else since you loaded it; reload and try again',
    409,
  )

export async function gridfsRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app
  // Uploads are raw bytes, streamed into GridFS; this parser exists only here.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload))

  /** The rules of a bucket's files, following a view to what it reads (review of the rule scope, I1). */
  const nsOf = async (request: FastifyRequest, db: string, bucket: string) =>
    (await viewAwareMaskerFor(request, [[db, `${bucket}.files`]]))?.forNs(db, `${bucket}.files`)
  const collections = async (request: FastifyRequest, db: string, bucket: string) => {
    const d = (await clientFor(request)).db(db)
    return { files: d.collection(`${bucket}.files`), chunks: d.collection(`${bucket}.chunks`) }
  }
  /** A file as listed: every field a restricted user may not see left out, and named (4b review I1). */
  const view = (
    request: FastifyRequest,
    db: string,
    bucket: string,
    doc: Document,
    ns: NsMasker | undefined,
  ): GridFsFile => {
    const hidden = (field: string) => personal(ns, field)
    const masked = ['_id', 'filename', 'length', 'chunkSize', 'uploadDate', 'contentType'].filter(hidden)
    let metadata: Record<string, unknown> | null = null
    const raw = doc.metadata
    if (hidden('metadata') && ns!.matches(['metadata'])) masked.push('metadata')
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const plain = toClient(raw as Document) as Record<string, unknown>
      metadata = hidden('metadata')
        ? (maskDocument(plain, ns!, ['metadata']) as Record<string, unknown>)
        : plain
      if (hidden('metadata')) masked.push('metadata')
    }
    const inMetadata = metadata?.contentType
    const type =
      typeof inMetadata === 'string' && inMetadata !== MASK
        ? inMetadata
        : !hidden('contentType') && typeof doc.contentType === 'string'
          ? doc.contentType
          : null
    const filename = typeof doc.filename === 'string' ? doc.filename : String(doc.filename ?? '')
    return {
      id: hidden('_id') ? null : idToUrl(doc._id),
      filename: hidden('filename') ? MASK : filename,
      length: hidden('length') ? null : num(doc.length),
      chunkSize: hidden('chunkSize') ? null : num(doc.chunkSize),
      uploadDate:
        !hidden('uploadDate') && doc.uploadDate instanceof Date ? doc.uploadDate.toISOString() : null,
      contentType: type,
      metadata,
      ...metadataState(db, bucket, doc, masked.length > 0 || !!ns?.any),
      masked,
    }
  }
  /**
   * Data review 2026-10-13 (M3): the metadata's version (an HMAC bound to the bucket, as a document's
   * pin is) and what in it the app would not write back as stored. A restricted user, who cannot
   * change it, is given neither.
   */
  const metadataVersion = (db: string, bucket: string, doc: Document): string =>
    hashDocument({ metadata: doc.metadata ?? null }, app.ctx.docPinKey, `${db}.${bucket}.files#metadata`)
  const metadataState = (
    db: string,
    bucket: string,
    doc: Document,
    restricted: boolean,
  ): Pick<GridFsFile, 'version' | 'caution'> => {
    if (restricted) return { version: null, caution: null }
    const [first, ...rest] = ejsonHazards(metadataOf(doc), 101)
    return {
      version: metadataVersion(db, bucket, doc),
      caution: first
        ? {
            kind: first.kind,
            field: first.path.slice(0, 200),
            ...(rest.length ? { others: rest.length } : {}),
          }
        : null,
    }
  }
  /**
   * A file's content is all there before any of it is sent (preview review I2): a missing chunk is
   * said plainly, never answered with a 200 and part of the bytes.
   */
  const assertWhole = async (request: FastifyRequest, db: string, bucket: string, doc: Document) => {
    const length = num(doc.length)
    const size = num(doc.chunkSize)
    const expected = length > 0 && size > 0 ? Math.ceil(length / size) : 0
    const { chunks } = await collections(request, db, bucket)
    // Round 2 (M5): GridFS reads a file by `files_id: <id>`; for a null id that matches the chunks
    // naming no file too, which would be read as its own.
    if (
      doc._id === null &&
      (await withMongo(() => chunks.countDocuments({ files_id: { $exists: false } }, { limit: 1 })))
    )
      throw new AppError(
        'BAD_FILE',
        'Chunks that name no file would be read as this one: it cannot be read from here',
        422,
        {
          reason: 'ambiguous',
        },
      )
    const found = await withMongo(() => chunks.countDocuments({ files_id: chunksOf(doc._id) }))
    if (found !== expected)
      throw new AppError('BAD_FILE', 'The file is damaged: some of its content is missing', 422, {
        reason: 'damaged',
      })
  }
  const findFile = async (request: FastifyRequest, db: string, bucket: string, id: unknown) => {
    const { files } = await collections(request, db, bucket)
    // Round 2 (I3): read as stored — a double stays a double — so metadata is shown and written
    // back with its own types.
    const doc = await withMongo(() => files.findOne({ _id: { $eq: id as never } }, READ_OPTIONS))
    if (!doc) throw Errors.notFound('File not found')
    return doc
  }

  app.get(
    '/connections/:id/databases/:db/gridfs',
    { preHandler: requireConnection('databases:read'), config: { masking: 'names-only' } },
    async (request) => {
      const { db } = parseInput(DbParams, request.params)
      const client = await clientFor(request)
      const names = new Set(
        (await withMongo(() => client.db(db).listCollections({}, { nameOnly: true }).toArray())).map(
          (c) => c.name,
        ),
      )
      return [...names]
        .filter((n) => n.endsWith('.files') && names.has(`${n.slice(0, -'.files'.length)}.chunks`))
        .map((n) => n.slice(0, -'.files'.length))
        .filter((n) => BucketNameSchema.safeParse(n).success)
        .sort()
        .map((name) => ({ name }))
    },
  )

  app.get(
    '/connections/:id/databases/:db/gridfs/:bucket/files',
    { preHandler: requireConnection('documents:read'), config: { masking: 'guarded' } },
    async (request, reply): Promise<GridFsPage> => {
      const { db, bucket } = parseInput(BucketParams, request.params)
      const q = parseInput(GridFsListQuerySchema, request.query)
      // Security review 2026-10-13 round 2 (I6): a page of files read like a page of documents —
      // the fields shown only, with a byte cap, under the same read slots.
      const { slots, maxPageBytes } = request.server.ctx.documents
      holdReadSlot(request, reply, slots)
      const ns = await nsOf(request, db, bucket)
      // A search or an order by a hidden field would tell its values, a letter at a time (4b review I2).
      const where = `${db}.${bucket}.files`
      if (q.q && personal(ns, 'filename')) throw personalField('filename', where)
      if (q.sort && personal(ns, q.sort)) throw personalField(q.sort, where)
      const field = q.sort ?? (personal(ns, 'uploadDate') ? null : 'uploadDate')
      const own: Document = field ? { [field]: q.dir === 'asc' ? 1 : -1 } : { $natural: 1 }
      const filter = q.q ? { filename: { $regex: `^${escapeRegex(q.q)}`, $options: 'i' } } : {}
      const { files } = await collections(request, db, bucket)
      // Twelfth and fourteenth reviews (Minor 6): where rules apply, the gate's order, so ties
      // come in no hidden index's order, nor in a hidden _id's (a clustered files collection).
      const gate = ns?.any ? gateFor(request, await clientFor(request)) : null
      const read = gate
        ? await withMongo(() => guardFind(db, `${bucket}.files`, { filter, sort: own }, gate))
        : null
      // Where the gate gives no order, _id still breaks ties, where it is shown (fifteenth review, Minor 2).
      const tied: Document = field && !personal(ns, '_id') ? { ...own, _id: 1 } : own
      // Eighteenth review (nit): a time series named like a bucket's files, its _id able to repeat.
      if (read?.repeats) throw notSupported('This bucket', `${db}.${bucket}.files`)
      const sort: Document = read?.hint || (read?.sort && '_id' in read.sort) ? (read.sort ?? own) : tied
      const docs: Document[] = []
      let more = false
      const list = async (order: { sort: Document; hint?: Document | string }) => {
        docs.length = 0
        more = false
        await withMongo(async () => {
          const cursor = files
            .find(filter, {
              ...READ_OPTIONS,
              projection: SHOWN_FIELDS,
              maxTimeMS: LIST_MS,
              ...(order.hint ? { hint: order.hint } : {}),
            })
            .sort(order.sort)
            .skip(q.skip)
            .limit(q.limit + 1)
          try {
            let bytes = 0
            for await (const doc of cursor) {
              bytes += calculateObjectSize(doc)
              // Past the cap the page ends early: the next one starts where this one stopped.
              if (docs.length === q.limit || (bytes > maxPageBytes && docs.length > 0)) {
                more = true
                break
              }
              docs.push(doc)
            }
          } finally {
            await cursor.close().catch(() => undefined)
          }
        })
      }
      await list({ sort, ...(read?.hint ? { hint: read.hint } : {}) })
      // Fifteenth and sixteenth reviews (I-3, M7): the page is checked as any page the gate orders,
      // and read again in natural order where it is refused for a document _id and that tells nothing.
      let page: Document[] = docs
      if (read)
        try {
          page = read.finish(docs)
        } catch (e) {
          const d = (e as { details?: { reason?: unknown; field?: unknown } }).details
          if (!read.natural || d?.reason !== PERSONAL_FIELD || d.field !== '_id') throw e
          await list({ sort: read.natural.sort ?? own, hint: read.natural.hint })
          page = read.natural.finish(docs)
        }
      const next = q.skip + page.length
      return {
        files: page.map((d) => view(request, db, bucket, d, ns)),
        locked: await bucketLocked(request, db, bucket),
        // A page starts at most at GRIDFS_MAX_SKIP: past it, a search narrows the list (4b review M1).
        next: more && next <= GRIDFS_MAX_SKIP ? next : null,
      }
    },
  )

  app.get(
    '/connections/:id/databases/:db/gridfs/:bucket/files/:fileId/download',
    {
      preHandler: requireConnection('documents:read'),
      config: { masking: 'denied-when-ruled', audit: 'gridfs.download' },
    },
    async (request, reply) => {
      const { db, bucket, fileId } = parseInput(FileParams, request.params)
      const doc = await findFile(request, db, bucket, idFromUrl(fileId))
      request.auditInfo = { details: { bucket, name: doc.filename, size: num(doc.length) } }
      await assertWhole(request, db, bucket, doc)
      // The stored file's own id, never what the client sent; the driver checks every chunk's order and size.
      const body = new GridFSBucket((await clientFor(request)).db(db), {
        bucketName: bucket,
      }).openDownloadStream(doc._id)
      // Always a download that never renders: no stored content type is trusted (active content).
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', contentDisposition(downloadName(String(doc.filename ?? 'file'))))
        .header('content-length', String(num(doc.length)))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'no-store')
        .send(body)
    },
  )

  // User request 2026-10-10: a preview — an image, a sound or a video by what its bytes are (never the
  // type it was stored with), else the start of a text; sandboxed, so nothing in it ever runs.
  app.get(
    '/connections/:id/databases/:db/gridfs/:bucket/files/:fileId/preview',
    {
      preHandler: requireConnection('documents:read'),
      config: { masking: 'denied-when-ruled', audit: 'gridfs.preview' },
    },
    async (request, reply) => {
      const { db, bucket, fileId } = parseInput(FileParams, request.params)
      const doc = await findFile(request, db, bucket, idFromUrl(fileId))
      request.auditInfo = { details: { bucket, name: doc.filename, size: num(doc.length) } }
      const length = num(doc.length)
      await assertWhole(request, db, bucket, doc)
      const files = new GridFSBucket((await clientFor(request)).db(db), { bucketName: bucket })
      const read = async (end: number) => {
        if (end <= 0) return Buffer.alloc(0)
        const parts: Buffer[] = []
        for await (const part of files.openDownloadStream(doc._id, { start: 0, end }))
          parts.push(part as Buffer)
        return Buffer.concat(parts)
      }
      // The start of the file: enough to know an image or a sound, and the whole of a text preview.
      const head = await withMongo(() => read(Math.min(length, PREVIEW_TEXT_BYTES)))
      const media = sniffMedia(head)
      reply
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
        .header('cache-control', 'no-store')
        .header(
          'content-disposition',
          contentDisposition(downloadName(String(doc.filename ?? 'file'))).replace(/^attachment/, 'inline'),
        )
      if (media) {
        if (length > (media.kind === 'image' ? PREVIEW_IMAGE_BYTES : PREVIEW_MEDIA_BYTES))
          throw new AppError('PAYLOAD_TOO_LARGE', 'This file is too large to preview', 413, {
            reason: 'too_large',
          })
        return reply
          .header('content-type', media.type)
          .header('x-preview-kind', media.kind)
          .header('content-length', String(length))
          .send(length <= head.length ? head : files.openDownloadStream(doc._id))
      }
      const truncated = length > head.length
      const text = asText(truncated ? wholeCharacters(head) : head)
      if (text === null)
        throw new AppError('BAD_FILE', 'This file has no preview', 415, { reason: 'no_preview' })
      if (truncated) reply.header('x-preview-truncated', '1')
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('x-preview-kind', 'text')
        .send(text)
    },
  )

  app.put(
    '/connections/:id/databases/:db/gridfs/:bucket/files',
    {
      preHandler: requireConnection('documents:write'),
      config: { masking: 'denied-when-ruled', audit: 'gridfs.upload', streamBody: true },
    },
    async (request, reply) => {
      const { db, bucket } = parseInput(BucketParams, request.params)
      const { filename, contentType } = parseInput(GridFsUploadQuerySchema, request.query)
      if (!String(request.headers['content-type'] ?? '').startsWith('application/octet-stream'))
        throw Errors.unsupportedType()
      assertTargetAllowed(request, db, `${bucket}.files`)
      const limit = ctx.config.gridfsMaxMb * MB
      const declared = Number(request.headers['content-length'])
      if (Number.isFinite(declared) && declared > limit) throw Errors.payloadTooLarge()
      request.auditInfo = { details: { bucket, name: filename } }
      const body = request.body as Readable
      const { files, chunks } = await collections(request, db, bucket)
      await withMongo(() => ensureIndexes(files, chunks))
      const id = new ObjectId()
      let size = 0
      let n = 0
      let pending: Buffer[] = []
      let pendingBytes = 0
      // Chunks written one at a time, each awaited: when the upload stops (over the limit, the client
      // gone), no write is still on its way, so removing its chunks removes them all (4b review I3).
      let writing: Promise<void> = Promise.resolve()
      const writeFull = async () => {
        while (pendingBytes >= CHUNK) {
          const all = Buffer.concat(pending)
          await chunks.insertOne({ files_id: id, n: n++, data: new Binary(all.subarray(0, CHUNK)) })
          const rest = all.subarray(CHUNK)
          pending = rest.length ? [rest] : []
          pendingBytes = rest.length
        }
      }
      try {
        await new Promise<void>((resolve, reject) => {
          let failed = false
          const fail = (e: unknown) => {
            if (failed) return
            failed = true
            body.removeListener('data', onData)
            // The rest is read and dropped, so the answer reaches the client.
            body.resume()
            reject(e)
          }
          const onData = (piece: Buffer) => {
            size += piece.length
            if (size > limit) return fail(Errors.payloadTooLarge())
            pending.push(piece)
            pendingBytes += piece.length
            if (pendingBytes < CHUNK) return
            body.pause()
            writing = writing.then(writeFull).then(() => {
              if (!failed) body.resume()
            })
            writing.catch(fail)
          }
          body.on('data', onData)
          body.on('aborted', () => fail(Errors.validation('The upload was interrupted')))
          body.on('error', fail)
          body.on('end', () => {
            writing
              .then(async () => {
                if (failed) return
                if ((request.raw as { aborted?: boolean }).aborted)
                  throw Errors.validation('The upload was interrupted')
                if (pendingBytes)
                  await chunks.insertOne({ files_id: id, n: n++, data: new Binary(Buffer.concat(pending)) })
                resolve()
              })
              .catch(fail)
          })
        })
        await files.insertOne({
          _id: id,
          length: size,
          chunkSize: CHUNK,
          uploadDate: new Date(),
          filename,
          metadata: contentType ? { contentType } : {},
        })
      } catch (e) {
        await writing.catch(() => undefined)
        await chunks.deleteMany({ files_id: id }).catch(() => undefined)
        throw e instanceof AppError ? e : toAppError(e)
      }
      request.auditInfo = { details: { bucket, name: filename, size } }
      return reply
        .status(201)
        .send(
          view(request, db, bucket, await findFile(request, db, bucket, id), await nsOf(request, db, bucket)),
        )
    },
  )

  app.patch(
    '/connections/:id/databases/:db/gridfs/:bucket/files/:fileId',
    {
      preHandler: requireConnection('documents:write'),
      config: { masking: 'denied-when-ruled', audit: 'gridfs.update' },
    },
    async (request) => {
      const { db, bucket, fileId } = parseInput(FileParams, request.params)
      const body = parseInput(GridFsPatchSchema, request.body)
      assertTargetAllowed(request, db, `${bucket}.files`)
      const doc = await findFile(request, db, bucket, idFromUrl(fileId))
      const set: Document = {}
      if (body.filename !== undefined) set.filename = body.filename
      if (body.metadata !== undefined) {
        // Data review 2026-10-13 (M3): the metadata is replaced whole from what was shown — only
        // that version of it, and only metadata the app reads back as it is.
        if (!safeEqual(metadataVersion(db, bucket, doc), body.version ?? '')) throw fileChanged()
        // Clearing it misreads nothing (round 2, M6).
        if (body.metadata !== null) refuseHazards(metadataOf(doc), null, null)
        if (body.metadata !== null && Buffer.byteLength(JSON.stringify(body.metadata)) > METADATA_BYTES)
          throw Errors.validation('Metadata is limited to 16 KiB')
        set.metadata = body.metadata === null ? null : fromClient(body.metadata, 'metadata')
        assertPlainKeys(set.metadata)
      }
      request.auditInfo = {
        details: {
          bucket,
          name: doc.filename,
          ...(body.filename !== undefined ? { to: body.filename } : {}),
          metadata: body.metadata !== undefined,
        },
      }
      const { files } = await collections(request, db, bucket)
      if (!(await withMongo(() => setFileFields(files, doc, set, body.metadata !== undefined))))
        throw fileChanged()
      return view(
        request,
        db,
        bucket,
        await findFile(request, db, bucket, doc._id),
        await nsOf(request, db, bucket),
      )
    },
  )

  app.delete(
    '/connections/:id/databases/:db/gridfs/:bucket/files/:fileId',
    {
      preHandler: requireConnection('documents:write'),
      config: { masking: 'denied-when-ruled', audit: 'gridfs.delete' },
    },
    async (request, reply) => {
      const { db, bucket, fileId } = parseInput(FileParams, request.params)
      assertTargetAllowed(request, db, `${bucket}.files`)
      const doc = await findFile(request, db, bucket, idFromUrl(fileId))
      request.auditInfo = { details: { bucket, name: doc.filename, size: num(doc.length) } }
      const { files, chunks } = await collections(request, db, bucket)
      // The stored file's own id: never what the client sent. The file goes first, then its content.
      await withMongo(async () => {
        await files.deleteOne({ _id: { $eq: doc._id } })
        await chunks.deleteMany({ files_id: chunksOf(doc._id) })
      })
      return reply.status(204).send()
    },
  )
}
