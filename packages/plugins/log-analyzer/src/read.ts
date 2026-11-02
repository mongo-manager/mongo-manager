/**
 * Plugins wave 3 (spec §7): a log file read line by line as a stream — a gzipped one through the
 * browser's own DecompressionStream — so a file of gigabytes never sits in memory whole. It is read
 * in the frame and goes nowhere: the frame has no network.
 */
export const MAX_FILE_BYTES = 2 * 1024 ** 3
/**
 * The longest line read, in characters (wave 3 review): a longer one — a dump with no line break —
 * is skipped to its end and counted, never held whole. A line's carriage return is not counted.
 */
export const MAX_LINE = 1024 * 1024

export interface ReadOptions {
  /** The longest line read (MAX_LINE). */
  maxLine?: number
  /** The most bytes read, the file's and a gzipped file's once inflated (MAX_FILE_BYTES). */
  maxBytes?: number
  /** Told of each line over `maxLine`, skipped. */
  onTooLong?: () => void
}

/** Whether the file starts as gzip does. */
async function gzipped(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer())
  return head[0] === 0x1f && head[1] === 0x8b
}

/** The smallest gzip member: a 10-byte header, an empty block, an 8-byte trailer. */
const MIN_MEMBER = 18
/** How far before the bytes fed the member's end is looked for (a browser takes input in pieces). */
const LOOK = 8 * 1024 * 1024
/** How many places that look like a member's end are tried, at most, before the file is called broken. */
const TRIES = 16

/**
 * Inflates gzip bytes through a stream of its own, telling each piece of output past the first `skip`
 * bytes. It says whether it ended cleanly, how much input it took in and how much it gave — only
 * what was read before any error: a stream that failed may have dropped output it had made (wave 3
 * third review), so nothing is counted on after its error.
 */
async function inflate(
  source: Blob,
  skip: number,
  onBytes: (bytes: Uint8Array) => void,
  signal: AbortSignal,
  onFed: (fed: number) => void = () => undefined,
): Promise<{ clean: boolean; out: number; fed: number }> {
  let fed = 0
  const counted = source.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(piece, controller) {
        fed += piece.byteLength
        controller.enqueue(piece)
      },
    }),
  )
  const reader = counted
    .pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)
    .getReader()
  let out = 0
  try {
    for (;;) {
      if (signal.aborted) throw new Error('stopped')
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch {
        // A member's end followed by more (another member), cut short, or not gzip after all:
        // which one is told by the caller; the browser's words are not shown.
        return { clean: false, out, fed }
      }
      if (next.done) return { clean: true, out, fed }
      const piece = next.value
      const from = Math.max(0, skip - out)
      out += piece.byteLength
      if (from < piece.byteLength) onBytes(from ? piece.subarray(from) : piece)
      onFed(fed)
    }
  } finally {
    // Stopped, failed or done: the file's stream is let go (wave 3 review: a Stop left it read on).
    await reader.cancel().catch(() => undefined)
  }
}

/**
 * Wave 3 third review: where a gzip member that starts at `start` ends, once a browser's reader
 * called what follows it junk. Chromium reads one member of a file of several joined (logrotate and
 * `cat a.gz b.gz` make them) and drops the output it made in the step the error came in, so the end
 * is found from the bytes: a place where gzip's header starts (1f 8b 08, its reserved flags clear)
 * and the member before it, inflated alone by `tryEnd`, ends cleanly having given as many bytes as
 * its trailer says (ISIZE, modulo 2^32). A few such places are tried, the earliest first.
 */
async function memberEnd(
  file: Blob,
  start: number,
  fed: number,
  tryEnd: (end: number) => Promise<number | null>,
): Promise<{ end: number; size: number } | null> {
  const from = Math.max(start + MIN_MEMBER, start + fed - LOOK)
  const to = Math.min(file.size, start + fed + 4)
  if (to - from < 3) return null
  const bytes = new Uint8Array(await file.slice(from - 4, to).arrayBuffer())
  let tries = 0
  for (let i = 4; i + 2 < bytes.length; i++) {
    if (bytes[i] !== 0x1f || bytes[i + 1] !== 0x8b || bytes[i + 2] !== 0x08) continue
    if (i + 3 < bytes.length && (bytes[i + 3]! & 0xe0) !== 0) continue
    if (++tries > TRIES) return null
    const isize = (bytes[i - 4]! | (bytes[i - 3]! << 8) | (bytes[i - 2]! << 16) | (bytes[i - 1]! << 24)) >>> 0
    const end = from - 4 + i
    const size = await tryEnd(end)
    if (size !== null && size >>> 0 === isize) return { end, size }
  }
  return null
}

/**
 * Calls `onLine` for each line (without its line break), `onProgress` with the bytes of the file read
 * so far; rejects with "stopped" once `signal` is aborted, "too_large" for a file over the cap (a
 * gzipped one as it inflates past it) and "bad_gzip" for a gzipped file cut short or not gzip after
 * all — the lines before are told first. A gzipped file of several members joined is read to its
 * end, whichever way the browser reads one. `chunk` sets how much is read at a time (tests read in
 * small pieces to cross line boundaries).
 */
export async function readLines(
  file: Blob,
  onLine: (line: string) => void,
  onProgress: (bytesRead: number) => void,
  signal: AbortSignal,
  chunk = 1024 * 1024,
  opts: ReadOptions = {},
): Promise<void> {
  const maxLine = opts.maxLine ?? MAX_LINE
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES
  if (file.size > maxBytes) throw new Error('too_large')
  const zipped = await gzipped(file)
  const decoder = new TextDecoder('utf-8')
  let carry = ''
  // Inside a line over the cap: everything up to its line break is skipped.
  let skipping = false
  // A line's length without the carriage return a Windows log ends it with (wave 3 second review).
  const length = (s: string) => (s.endsWith('\r') ? s.length - 1 : s.length)
  const emit = (line: string) => {
    if (signal.aborted) throw new Error('stopped')
    if (length(line) > maxLine) return opts.onTooLong?.()
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  }
  const lines = (text: string) => {
    if (skipping) {
      const end = text.indexOf('\n')
      if (end < 0) return
      skipping = false
      text = text.slice(end + 1)
    }
    const parts = (carry + text).split('\n')
    carry = parts.pop() ?? ''
    for (const part of parts) emit(part)
    if (length(carry) > maxLine) {
      opts.onTooLong?.()
      carry = ''
      skipping = true
    }
  }
  if (!zipped) {
    for (let offset = 0; offset < file.size; offset += chunk) {
      if (signal.aborted) throw new Error('stopped')
      const piece = new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer())
      lines(decoder.decode(piece, { stream: true }))
      onProgress(Math.min(file.size, offset + chunk))
    }
  } else {
    // Each member in turn; a gzipped file's progress is told by the compressed bytes taken in, its
    // cap by the inflated. Output is told once: what a member gives is the same however far it is
    // read, so each read tells only what lies past what was told already (`told`, counted from the
    // member's start — and past its end, when a reader read on into the next members).
    let total = 0
    let told = 0
    const tell = (bytes: Uint8Array) => {
      told += bytes.byteLength
      if (total + told > maxBytes) throw new Error('too_large')
      lines(decoder.decode(bytes, { stream: true }))
    }
    for (let start = 0; start < file.size;) {
      const at = start
      const whole = await inflate(at === 0 ? file : file.slice(at), told, tell, signal, (n) =>
        onProgress(Math.min(file.size, at + n)),
      )
      // Read to the end: one member, or a reader that reads joined members itself (Node's does).
      if (whole.clean) break
      const found = await memberEnd(file, at, whole.fed, async (end) => {
        const part = await inflate(file.slice(at, end), told, tell, signal)
        return part.clean ? part.out : null
      })
      // Cut short, or not gzip after all: the lines before were told.
      if (!found) throw new Error('bad_gzip')
      total += found.size
      told = Math.max(0, told - found.size)
      start = found.end
    }
  }
  const rest = carry + decoder.decode()
  if (rest && !skipping) emit(rest)
  onProgress(file.size)
}
