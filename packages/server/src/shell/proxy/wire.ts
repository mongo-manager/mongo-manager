// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { BSON } from 'bson'

/**
 * Phase 3a-1 spec §5.2: the minimum of the MongoDB wire protocol the proxy needs. It splits a byte
 * stream into frames, reads the command out of an OP_MSG, and rewrites the worker's `hello` so the
 * server never sees a second client-metadata document (the proxy sent the first). Compression is
 * never negotiated, so OP_COMPRESSED must not appear; an unknown opcode or an oversize frame is a
 * protocol error and closes the connection.
 */
export const MAX_FRAME_BYTES = 48 * 1024 * 1024
const HEADER_BYTES = 16

export const OP_MSG = 2013
export const OP_QUERY = 2004
export const OP_REPLY = 1
export const OP_COMPRESSED = 2012

/** OP_MSG flag bits we care about. */
export const FLAG_CHECKSUM_PRESENT = 1 << 0
export const FLAG_MORE_TO_COME = 1 << 1

export interface Frame {
  requestID: number
  responseTo: number
  opCode: number
  /** The bytes after the 16-byte header. */
  body: Buffer
}

/**
 * Split a stream into whole wire frames. Throws on an oversize or malformed length. The chunks are
 * kept as they came and each frame is copied once (security review 2026-10-13, M7: joining every
 * chunk to what was held made one 47 MB frame take seconds of the server's one thread).
 */
export class FrameSplitter {
  private chunks: Buffer[] = []
  private held = 0

  push(chunk: Buffer): Frame[] {
    if (chunk.length) {
      this.chunks.push(Buffer.from(chunk))
      this.held += chunk.length
    }
    const frames: Frame[] = []
    while (this.held >= HEADER_BYTES) {
      // The header may straddle chunks: join only the first ones until it is whole.
      if (this.chunks[0]!.length < HEADER_BYTES) {
        let n = 1
        let bytes = this.chunks[0]!.length
        while (bytes < HEADER_BYTES) bytes += this.chunks[n++]!.length
        this.chunks.splice(0, n, Buffer.concat(this.chunks.slice(0, n)))
      }
      const length = this.chunks[0]!.readInt32LE(0)
      if (length < HEADER_BYTES || length > MAX_FRAME_BYTES) {
        throw new Error(`wire: bad frame length ${length}`)
      }
      if (this.held < length) break
      const frame = this.take(length)
      frames.push({
        requestID: frame.readInt32LE(4),
        responseTo: frame.readInt32LE(8),
        opCode: frame.readInt32LE(12),
        body: frame.subarray(HEADER_BYTES),
      })
    }
    return frames
  }

  /** The next `length` bytes, in one buffer of their own. */
  private take(length: number): Buffer {
    const parts: Buffer[] = []
    let need = length
    while (need > 0) {
      const head = this.chunks[0]!
      if (head.length <= need) {
        parts.push(head)
        this.chunks.shift()
        need -= head.length
      } else {
        parts.push(head.subarray(0, need))
        this.chunks[0] = head.subarray(need)
        need = 0
      }
    }
    this.held -= length
    return parts.length === 1 ? Buffer.from(parts[0]!) : Buffer.concat(parts, length)
  }
}

/** How deep a document may nest before it is refused (MongoDB allows 100 levels; this is generous). */
const MAX_BSON_DEPTH = 200

/**
 * Security review 2026-10-13 (H2): the policy reads a command as JavaScript sees it, MongoDB as it
 * is on the wire. They differ when a field is there twice (JavaScript keeps the last, MongoDB the
 * first) and in order when a field name looks like a number (JavaScript puts it first). A document
 * with a field twice, at any depth, is refused; the first field's name is read from the bytes.
 */
export function checkBson(buf: Buffer, start = 0, depth = 0): string | undefined {
  if (depth > MAX_BSON_DEPTH) throw new Error('wire: document nested too deep')
  const size = buf.readInt32LE(start)
  const end = start + size
  if (size < 5 || end > buf.length || buf[end - 1] !== 0) throw new Error('wire: malformed document')
  const seen = new Set<string>()
  let first: string | undefined
  let p = start + 4
  const str = (at: number) => 4 + buf.readInt32LE(at)
  while (p < end - 1) {
    const type = buf[p]!
    const nameEnd = buf.indexOf(0, p + 1)
    if (nameEnd < 0 || nameEnd >= end) throw new Error('wire: malformed field name')
    const name = buf.toString('utf8', p + 1, nameEnd)
    if (seen.has(name)) throw new Error(`wire: field ${JSON.stringify(name)} given twice`)
    seen.add(name)
    first ??= name
    p = nameEnd + 1
    switch (type) {
      case 0x01:
      case 0x09:
      case 0x11:
      case 0x12:
        p += 8
        break
      case 0x02:
      case 0x0d:
      case 0x0e:
        p += str(p)
        break
      case 0x03:
      case 0x04:
        checkBson(buf, p, depth + 1)
        p += buf.readInt32LE(p)
        break
      case 0x05:
        p += 5 + buf.readInt32LE(p)
        break
      case 0x06:
      case 0x0a:
      case 0xff:
      case 0x7f:
        break
      case 0x07:
        p += 12
        break
      case 0x08:
        p += 1
        break
      case 0x0b:
        p = buf.indexOf(0, buf.indexOf(0, p) + 1) + 1
        break
      case 0x0c:
        p += str(p) + 12
        break
      case 0x0f: {
        const total = buf.readInt32LE(p)
        checkBson(buf, p + 4 + str(p + 4), depth + 1)
        p += total
        break
      }
      case 0x10:
        p += 4
        break
      case 0x13:
        p += 16
        break
      default:
        throw new Error(`wire: unknown BSON type ${type}`)
    }
    if (p > end - 1) throw new Error('wire: malformed document')
  }
  return first
}

/** Rebuild a frame's raw bytes. */
export function encodeFrame(frame: Omit<Frame, never>): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeInt32LE(HEADER_BYTES + frame.body.length, 0)
  header.writeInt32LE(frame.requestID, 4)
  header.writeInt32LE(frame.responseTo, 8)
  header.writeInt32LE(frame.opCode, 12)
  return Buffer.concat([header, frame.body])
}

export interface OpMsg {
  flags: number
  /** The command document (section kind 0). */
  command: Record<string, unknown>
  /** The command's name: its first field on the wire (review 2026-10-13, H2). */
  name: string
  /** Kind-1 sequences by identifier, e.g. `documents` for an insert. */
  sequences: Array<{ identifier: string; documents: Buffer[] }>
}

/** Parse an OP_MSG body into its command and any document sequences. */
export function parseOpMsg(body: Buffer): OpMsg {
  const flags = body.readUInt32LE(0)
  let offset = 4
  let command: Record<string, unknown> | null = null
  let name = ''
  const sequences: OpMsg['sequences'] = []
  while (offset < body.length) {
    const kind = body.readUInt8(offset)
    offset += 1
    if (kind === 0) {
      // One command section: a second would be read by one side and not the other.
      if (command) throw new Error('wire: OP_MSG had two command sections')
      const size = body.readInt32LE(offset)
      const section = body.subarray(offset, offset + size)
      name = checkBson(section) ?? ''
      command = deserializePlain(section)
      offset += size
    } else if (kind === 1) {
      const size = body.readInt32LE(offset)
      const end = offset + size
      let p = offset + 4
      const nul = body.indexOf(0, p)
      const identifier = body.toString('utf8', p, nul)
      p = nul + 1
      const documents: Buffer[] = []
      while (p < end) {
        const docSize = body.readInt32LE(p)
        const doc = Buffer.from(body.subarray(p, p + docSize))
        checkBson(doc)
        documents.push(doc)
        p += docSize
      }
      sequences.push({ identifier, documents })
      offset = end
    } else {
      throw new Error(`wire: unknown OP_MSG section kind ${kind}`)
    }
  }
  if (!command) throw new Error('wire: OP_MSG had no command section')
  return { flags, command, name, sequences }
}

/** Serialise an OP_MSG body from a command and its sequences. */
export function encodeOpMsg(msg: Pick<OpMsg, 'flags' | 'command' | 'sequences'>): Buffer {
  const parts: Buffer[] = [Buffer.alloc(4)]
  parts[0]!.writeUInt32LE(msg.flags, 0)
  const commandBytes = Buffer.from(BSON.serialize(msg.command))
  parts.push(Buffer.from([0]), commandBytes)
  for (const seq of msg.sequences) {
    const id = Buffer.from(`${seq.identifier}\0`, 'utf8')
    const docs = Buffer.concat(seq.documents)
    const size = 4 + id.length + docs.length
    const head = Buffer.alloc(5)
    head.writeUInt8(1, 0)
    head.writeInt32LE(size, 1)
    parts.push(head, id, docs)
  }
  return Buffer.concat(parts)
}

/** An OP_MSG reply frame carrying a MongoDB command error, so the worker's driver reports it. */
export function errorReply(
  responseTo: number,
  code: number,
  message: string,
  codeName = 'Unauthorized',
): Frame {
  const body = encodeOpMsg({
    flags: 0,
    command: { ok: 0, code, codeName, errmsg: message },
    sequences: [],
  })
  return { requestID: 0, responseTo, opCode: OP_MSG, body }
}

const HELLO_KEYS = ['hello', 'ismaster', 'isMaster']
/** Fields that may be set only once per connection, or that we never let the worker negotiate. */
const STRIP_FROM_HELLO = ['client', 'speculativeAuthenticate', 'saslSupportedMechs', 'compression']

export function isHello(command: Record<string, unknown>): boolean {
  return HELLO_KEYS.some((k) => k in command)
}

/**
 * The command document with any kind-1 document sequences folded in, for the policy to judge. The
 * driver sends an aggregate pipeline (and write payloads) inline, but a crafted worker could move a
 * `pipeline` with `$out`/`$merge` into a sequence to hide it from the policy; folding the sequences
 * back onto the command makes the policy see the real command (defense-in-depth, review M2).
 */
export function commandWithSequences(msg: OpMsg): Record<string, unknown> {
  if (!msg.sequences.length) return msg.command
  const merged: Record<string, unknown> = { ...msg.command }
  for (const seq of msg.sequences) {
    if (!(seq.identifier in merged)) merged[seq.identifier] = seq.documents.map((d) => deserializePlain(d))
  }
  return merged
}

/**
 * Security review 2026-10-16 (I-5): the bson parser turns any object whose only $-keys are
 * $ref/$id/$db into a DBRef — a whole command among them, which then showed the policy none of its
 * fields and no $db. The policy judges what MongoDB reads, so each DBRef is turned back into the
 * plain object it was on the wire ({ $ref, $id, $db, …its other fields }). Copy on write: a document
 * with none is returned as it is.
 */
function deserializePlain(bytes: Buffer): Record<string, unknown> {
  return plain(BSON.deserialize(bytes), 0) as Record<string, unknown>
}

function plain(value: unknown, depth: number): unknown {
  // Past MongoDB's own nesting limit nothing is changed (findServerJs refuses such depth anyway).
  if (value === null || typeof value !== 'object' || depth > 200) return value
  if (Array.isArray(value)) {
    let out: unknown[] | null = null
    value.forEach((item, i) => {
      const next = plain(item, depth + 1)
      if (next !== item) (out ??= [...value])[i] = next
    })
    return out ?? value
  }
  if ((value as { _bsontype?: unknown })._bsontype === 'DBRef' && value instanceof BSON.DBRef) {
    const fields = plain(value.fields, depth + 1) as Record<string, unknown>
    return {
      $ref: value.collection,
      $id: plain(value.oid, depth + 1),
      ...(value.db !== undefined ? { $db: value.db } : {}),
      ...fields,
    }
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value
  let out: Record<string, unknown> | null = null
  for (const [key, item] of Object.entries(value)) {
    const next = plain(item, depth + 1)
    if (next !== item) {
      out ??= { ...(value as Record<string, unknown>) }
      out[key] = next
    }
  }
  return out ?? value
}

/** Parse an OP_QUERY body: flags, fullCollectionName, skip, return, then the query document. */
function parseOpQuery(body: Buffer): { prefix: Buffer; query: Record<string, unknown>; suffix: Buffer } {
  let offset = 4 // flags
  const nul = body.indexOf(0, offset)
  offset = nul + 1 + 8 // cstring + numberToSkip + numberToReturn
  const size = body.readInt32LE(offset)
  const query = deserializePlain(body.subarray(offset, offset + size))
  return {
    prefix: Buffer.from(body.subarray(0, offset)),
    query,
    suffix: Buffer.from(body.subarray(offset + size)),
  }
}

export function stripHelloFields(command: Record<string, unknown>): boolean {
  let changed = false
  for (const key of STRIP_FROM_HELLO) {
    if (key in command) {
      delete command[key]
      changed = true
    }
  }
  return changed
}

/**
 * If a frame is an OP_MSG hello, remove the fields that would clash with the proxy's own handshake
 * (client metadata is set once) or let the worker negotiate compression/auth. Returns the frame
 * unchanged when it is not a hello.
 */
/**
 * Security review 2026-10-13 (H2): a legacy OP_QUERY is let through only as the driver's opening
 * hello on `<db>.$cmd` (stripped of its client metadata). Anything else — a command MongoDB before
 * 6.0 would run unchecked, or a legacy find — throws, and the proxy drops the connection.
 */
export function legacyHello(frame: Frame): Frame {
  const nameEnd = frame.body.indexOf(0, 4)
  const collection = frame.body.toString('utf8', 4, nameEnd)
  const at = Buffer.byteLength(collection) + 4 + 1 + 8
  // The command is its first field on the wire: hello itself, not a command carrying a hello field.
  const first = checkBson(frame.body.subarray(at, at + frame.body.readInt32LE(at)))
  if (!collection.endsWith('.$cmd') || !first || !HELLO_KEYS.includes(first))
    throw new Error('wire: a legacy query that is not hello')
  return rewriteWorkerFrame(frame)
}

export function rewriteWorkerFrame(frame: Frame): Frame {
  if (frame.opCode === OP_MSG) {
    const msg = parseOpMsg(frame.body)
    if (!isHello(msg.command)) return frame
    if (!stripHelloFields(msg.command)) return frame
    return { ...frame, body: encodeOpMsg(msg) }
  }
  if (frame.opCode === OP_QUERY) {
    // The driver's initial handshake is a legacy OP_QUERY hello on `<db>.$cmd`; client metadata may
    // appear only on the connection's first hello (the proxy's), so strip it here too.
    const { prefix, query, suffix } = parseOpQuery(frame.body)
    if (!isHello(query)) return frame
    if (!stripHelloFields(query)) return frame
    return { ...frame, body: Buffer.concat([prefix, Buffer.from(BSON.serialize(query)), suffix]) }
  }
  return frame
}
