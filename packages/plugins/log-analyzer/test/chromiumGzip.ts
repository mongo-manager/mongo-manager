import { constants, gunzipSync, inflateRawSync } from 'node:zlib'

/**
 * Wave 3 third review: a DecompressionStream that behaves as Chromium's does, for tests — it inflates
 * one gzip member only; bytes after that member are junk, and the error it then raises comes in the
 * same step as the member's last output, so that output is dropped with everything queued (an
 * errored stream's queue is cleared). Earlier output comes out as it is inflated. Node's own
 * DecompressionStream reads joined members whole, so it never shows what a browser does.
 */
const GZIP_HEADER = [0x1f, 0x8b, 0x08]
const PIECE = 16 * 1024
const LAG = 4 * 1024

/** Where gzip's first member ends in these bytes: the smallest end that inflates whole, if any. */
function firstMemberEnd(bytes: Uint8Array): number | null {
  const ends: number[] = []
  for (let i = 18; i + 2 < bytes.length; i++)
    if (GZIP_HEADER.every((b, k) => bytes[i + k] === b)) ends.push(i)
  ends.push(bytes.length)
  for (const end of ends) {
    try {
      gunzipSync(bytes.subarray(0, end))
      return end
    } catch {
      // Not a member's end.
    }
  }
  return null
}

/** The length of a member's header (its optional extra field, name, comment and header check). */
function headerLength(bytes: Uint8Array): number | null {
  if (bytes.length < 10) return null
  const flags = bytes[3]!
  let at = 10
  if (flags & 4) {
    if (bytes.length < at + 2) return null
    at += 2 + (bytes[at]! | (bytes[at + 1]! << 8))
  }
  for (const flag of [8, 16])
    if (flags & flag) {
      const zero = bytes.indexOf(0, at)
      if (zero < 0) return null
      at = zero + 1
    }
  if (flags & 2) at += 2
  return at <= bytes.length ? at : null
}

/** What the first member inflates to so far (a prefix of its output). */
function inflatedSoFar(bytes: Uint8Array): Uint8Array {
  const head = headerLength(bytes)
  if (head === null) return new Uint8Array()
  try {
    return inflateRawSync(bytes.subarray(head), { finishFlush: constants.Z_SYNC_FLUSH })
  } catch {
    return new Uint8Array()
  }
}

export class ChromiumLikeDecompressionStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(format: string) {
    if (format !== 'gzip') throw new TypeError('gzip only')
    let input = new Uint8Array()
    let told = 0
    // In pieces of 16 KB, as Chromium writes them: a read waiting takes the first, the rest wait in
    // the queue — and go when the stream errors.
    const tell = (out: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) => {
      for (let at = told; at < out.length; at += PIECE)
        controller.enqueue(out.slice(at, Math.min(out.length, at + PIECE)))
      told = Math.max(told, out.length)
    }
    super({
      transform(piece, controller) {
        const joined = new Uint8Array(input.length + piece.length)
        joined.set(input)
        joined.set(piece, input.length)
        input = joined
        const end = firstMemberEnd(input)
        if (end !== null && end < input.length) {
          // The member's last output and the junk error in one step: queued behind a reader still
          // busy with what came before, that output goes with the error — none of it is read.
          controller.error(new TypeError('Junk found after end of compressed data.'))
          return
        }
        // What the last few KB of input inflate to waits for the next step (as a browser's buffers
        // do), so a member's end always falls in the step the junk error comes in.
        tell(inflatedSoFar(input.subarray(0, Math.max(0, input.length - LAG))), controller)
      },
      flush(controller) {
        if (firstMemberEnd(input) === input.length) tell(gunzipSync(input), controller)
        else controller.error(new TypeError('The compressed data was not valid.'))
      },
    })
  }
}

/**
 * A reader that reads joined members on, one after another (as zlib's gunzip does), and fails only
 * where a member is cut short — after telling what it inflated of it. A file read with it has told
 * lines of the next members before the error: they are never told again.
 */
export class ReadsOnDecompressionStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(format: string) {
    if (format !== 'gzip') throw new TypeError('gzip only')
    let input = new Uint8Array()
    let told = 0
    const output = (): { bytes: Uint8Array; whole: boolean } => {
      const parts: Uint8Array[] = []
      let at = 0
      for (;;) {
        const rest = input.subarray(at)
        if (!rest.length) return { bytes: Buffer.concat(parts), whole: true }
        const end = firstMemberEnd(rest)
        if (end === null) {
          parts.push(inflatedSoFar(rest))
          return { bytes: Buffer.concat(parts), whole: false }
        }
        parts.push(gunzipSync(rest.subarray(0, end)))
        at += end
      }
    }
    super({
      transform(piece, controller) {
        const joined = new Uint8Array(input.length + piece.length)
        joined.set(input)
        joined.set(piece, input.length)
        input = joined
        const { bytes } = output()
        if (bytes.length > told) controller.enqueue(bytes.slice(told))
        told = Math.max(told, bytes.length)
      },
      flush(controller) {
        if (!output().whole) controller.error(new TypeError('unexpected end of file'))
      },
    })
  }
}
