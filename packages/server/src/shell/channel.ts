import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { MAX_IPC_MESSAGE_BYTES } from './ipc'

/**
 * Security audit 2026-10-16 (minor): how the server and a shell worker talk. Node's IPC channel
 * parsed every message the worker wrote — however large, on the server's main thread — before the
 * server could look at its size, and buffered a message with no end without limit. The worker now
 * talks over its plain stdin and stdout instead: one JSON message a line, and a line is refused the
 * moment it passes the cap, before it is parsed and without holding more than the cap in memory.
 * JSON.stringify never writes a raw newline (it escapes them in strings), so a line is a message.
 */

/** Splits a byte stream into lines of at most `max` bytes; a longer one ends the stream. */
export class LineSplitter {
  private parts: Buffer[] = []
  private size = 0
  private dead = false

  constructor(
    private readonly max: number,
    private readonly onLine: (line: string) => void,
    private readonly onOversize: () => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.dead) return
    let start = 0
    for (;;) {
      const end = chunk.indexOf(0x0a, start)
      if (end < 0) break
      const piece = chunk.subarray(start, end)
      if (this.size + piece.length > this.max) return this.kill()
      const line = this.size > 0 ? Buffer.concat([...this.parts, piece]) : piece
      this.parts = []
      this.size = 0
      this.onLine(line.toString('utf8'))
      if (this.dead) return
      start = end + 1
    }
    const rest = chunk.subarray(start)
    if (this.size + rest.length > this.max) return this.kill()
    if (rest.length > 0) {
      // A copy: the stream may reuse the chunk's memory.
      this.parts.push(Buffer.from(rest))
      this.size += rest.length
    }
  }

  private kill(): void {
    this.dead = true
    this.parts = []
    this.size = 0
    this.onOversize()
  }
}

/**
 * Every message line starts with this mark (ASCII record separator), so a line something else in the
 * worker writes to stdout — a library's console.log taken before the worker moved console to stderr
 * — is set aside as noise instead of corrupting the protocol (security review 2026-10-16, minor).
 * The protocol stays on stdout: an extra pipe (fd 3) did not carry data from a Node child on
 * Windows, and the SEA binary runs on Windows too.
 */
export const LINE_MARK = '\u001e'

/** One message as the line that carries it. */
export function encodeLine(message: unknown): string {
  return `${LINE_MARK}${JSON.stringify(message)}\n`
}

/**
 * How deep a message may nest: a document's 100 levels, its EJSON wrappers and the message's own,
 * with room to spare. Deeper JSON parses, and then throws out of JSON.stringify where it is passed
 * on (security review 2026-10-16, I-6), so it is refused before it is parsed.
 */
export const MAX_MESSAGE_DEPTH = 512

/** Whether JSON text nests no deeper than `max` (brackets inside strings do not count). */
export function jsonDepthWithin(text: string, max: number): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (inString) {
      if (c === 0x5c) i++
      else if (c === 0x22) inString = false
    } else if (c === 0x22) inString = true
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > max) return false
    } else if (c === 0x7d || c === 0x5d) depth--
  }
  return true
}

/** Parse a message line: its mark stripped and its depth checked first. Null for noise. */
export function decodeLine(
  line: string,
): ({ message: unknown } | { violation: true } | Record<never, never>) & { noise?: string } {
  // A message starts at its line's last mark: JSON never holds a raw one, and a stray write with no
  // line end before it is set aside, never the message with it (second review 2026-10-16).
  const at = line.lastIndexOf(LINE_MARK)
  if (at < 0) return { noise: line }
  const before = at > 0 ? { noise: line.slice(0, at) } : {}
  const text = line.slice(at + 1)
  if (!jsonDepthWithin(text, MAX_MESSAGE_DEPTH)) return { violation: true, ...before }
  try {
    return { message: JSON.parse(text) as unknown, ...before }
  } catch {
    return { violation: true, ...before }
  }
}

/**
 * Bytes a second read from workers, all together (second review 2026-10-16): each worker's own budget
 * times twenty workers was still too much for one main thread. `take` counts a chunk in and says how
 * long to wait (ms) before reading more, 0 when there is room.
 */
export class ByteBudget {
  private windowStart = 0
  private used = 0

  constructor(private readonly perSecond: number) {}

  take(bytes: number, now = Date.now()): number {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now
      this.used = 0
    }
    this.used += bytes
    return this.used >= this.perSecond ? Math.max(1, 1000 - (now - this.windowStart)) : 0
  }
}

/** What the server reads from all workers together, a second. */
export const ALL_WORKERS_BYTES_PER_SECOND = 32 * 1024 * 1024
const SHARED_BUDGET = new ByteBudget(ALL_WORKERS_BYTES_PER_SECOND)

/**
 * A running worker as the manager sees it: `message` for each parsed message, `violation` for a
 * message the channel refused (too large, too deep, or not JSON), `noise` for a line that is no
 * message, `exit` once when it is gone.
 */
export interface WorkerProcess extends EventEmitter {
  readonly pid?: number
  readonly stderr: NodeJS.ReadableStream | EventEmitter | null
  send(message: unknown): boolean
  kill(signal?: NodeJS.Signals | number): boolean
}

/**
 * Bytes a second the server reads from one worker before it waits for the next second (security
 * review 2026-10-16, I-7): what a command may print and return, many times over, and far below what
 * would keep the server's main thread parsing.
 */
export const WORKER_BYTES_PER_SECOND = 16 * 1024 * 1024

/** A worker spawned with pipes: messages are lines on its stdin and stdout. */
export class PipeWorker extends EventEmitter implements WorkerProcess {
  private exited = false

  constructor(
    private readonly child: ChildProcess,
    options: { maxBytes?: number; bytesPerSecond?: number; shared?: ByteBudget } = {},
  ) {
    super()
    const splitter = new LineSplitter(
      options.maxBytes ?? MAX_IPC_MESSAGE_BYTES,
      (line) => {
        const decoded = decodeLine(line)
        if (decoded.noise !== undefined) this.emit('noise', decoded.noise)
        if ('violation' in decoded) return void this.emit('violation')
        if (!('message' in decoded)) return
        // A listener that cannot take it (a value too deep to pass on, say) is the worker's fault,
        // and never an uncaught error in the server.
        try {
          this.emit('message', decoded.message)
        } catch {
          this.emit('violation')
        }
      },
      () => this.emit('violation'),
    )
    const own = new ByteBudget(options.bytesPerSecond ?? WORKER_BYTES_PER_SECOND)
    const shared = options.shared ?? SHARED_BUDGET
    const stdout = child.stdout
    stdout?.on('data', (chunk: Buffer) => {
      const now = Date.now()
      // Both budgets count every chunk: this worker's own, and all workers' together.
      const wait = Math.max(own.take(chunk.length, now), shared.take(chunk.length, now))
      splitter.push(chunk)
      if (wait > 0 && !stdout.isPaused()) {
        // The pipe fills and the worker's writes wait: nothing is dropped, nothing piles up here.
        stdout.pause()
        setTimeout(() => {
          if (!this.exited) stdout.resume()
        }, wait).unref?.()
      }
    })
    // A pipe to a worker that is gone fails with EPIPE or a reset: never an uncaught error.
    child.stdin?.on('error', () => undefined)
    stdout?.on('error', () => undefined)
    const gone = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.exited) return
      this.exited = true
      this.emit('exit', code, signal)
    }
    child.on('exit', gone)
    // A worker that could not start is gone as well.
    child.on('error', () => gone(null, null))
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get stderr(): NodeJS.ReadableStream | null {
    return this.child.stderr
  }

  send(message: unknown): boolean {
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) return false
    stdin.write(encodeLine(message))
    return true
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    return this.child.kill(signal)
  }
}
