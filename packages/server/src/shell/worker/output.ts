import { MAX_IPC_MESSAGE_BYTES, OUTPUT_CAP_BYTES, type WorkerToShell } from '../ipc'
import { MAX_MESSAGE_DEPTH, jsonDepthWithin } from '../channel'

/**
 * What a command sends the parent — what it prints and its results — kept within the parent's caps
 * (second review 2026-10-12, I2 and I3: a print could pass the 1 MiB message cap, and output past the
 * 5 MiB cap was still sent, passing the 1000 messages a second; the session was reset either way):
 *
 * - prints go together, a line each, in a message at most every 30 ms or when it is full; a message
 *   never passes the cap however its characters are escaped;
 * - past the output cap nothing more is sent (the message that passes it is, so the parent says the
 *   output was cut);
 * - results are paced under the parent's message rate (a script of thousands of statements).
 *
 * A print outside a command — late, from code still running after it ended — is dropped.
 */

/** Characters of print in one message: escaped as JSON one takes at most six bytes. */
const MAX_PRINT_CHARS = Math.floor((MAX_IPC_MESSAGE_BYTES - 4096) / 6)
/** The largest result message, with room to spare under the parent's message cap. */
const MAX_RESULT_BYTES = MAX_IPC_MESSAGE_BYTES - 4096
const FLUSH_MS = 30
/** Results a second, well under the parent's 1000 messages. */
const RATE_MAX = 400
const RATE_WINDOW_MS = 1000

export interface OutputDeps {
  send: (message: WorkerToShell) => void
  now: () => number
  wait: (ms: number) => Promise<void>
  /** Runs `run` after `ms`; returns what cancels it. */
  schedule: (run: () => void, ms: number) => () => void
}

export interface ResultPart {
  resultType: string | null
  value: unknown
  hasMore: boolean
  command?: string
}

export class Output {
  private id: number | null = null
  private lines: string[] = []
  private chars = 0
  private cancelFlush: (() => void) | null = null
  /** Bytes of output sent for this command; past the cap, none more. */
  private bytes = 0
  private over = false
  /** The output cap of one command: the server's configured one once init gives it (spec §4). */
  private cap = OUTPUT_CAP_BYTES
  private sentAt: number[] = []

  constructor(private readonly deps: OutputDeps) {}

  setCap(bytes: number): void {
    this.cap = bytes
  }

  /** A command starts: what it prints and returns is sent under its id. */
  begin(id: number): void {
    this.end()
    this.id = id
    this.bytes = 0
    this.over = false
  }

  /** The command ends: what it printed is sent, and nothing more under its id. */
  end(): void {
    this.flush()
    this.id = null
  }

  /** A line the command printed (one print or printjson); a line too long for a message is cut. */
  print(text: string): void {
    if (this.id === null || this.over) return
    const line = text.length > MAX_PRINT_CHARS ? `${text.slice(0, MAX_PRINT_CHARS - 1)}…` : text
    if (this.lines.length > 0 && this.chars + 1 + line.length > MAX_PRINT_CHARS) this.flush()
    this.chars += (this.lines.length > 0 ? 1 : 0) + line.length
    this.lines.push(line)
    this.cancelFlush ??= this.deps.schedule(() => this.flush(), FLUSH_MS)
  }

  /** Sends what was printed and not sent yet. */
  flush(): void {
    this.cancelFlush?.()
    this.cancelFlush = null
    if (this.id === null || this.lines.length === 0) return
    const text = this.lines.join('\n')
    this.lines = []
    this.chars = 0
    if (this.over) return
    this.count(Buffer.byteLength(text))
    this.deps.send({ type: 'print', id: this.id, text })
  }

  /**
   * A piece's result: after what it printed, paced; none for no value (mongosh shows nothing). One
   * that would not fit in a message, or would pass the output cap, is held back and the parent told
   * the output was cut (security audit 2026-10-16: it was sent whole, however large).
   */
  async result(part: ResultPart): Promise<void> {
    if (this.id === null) return
    this.flush()
    if (this.over || part.value === undefined) return
    await this.pace()
    if (this.id === null || this.over) return
    const message: WorkerToShell = { type: 'result', id: this.id, ...part }
    // Too deep for the server to take (it refuses such a message whole: security review
    // 2026-10-16, I-6), or too deep to write at all: held back like one too large.
    let text: string | null
    try {
      text = JSON.stringify(message)
    } catch {
      text = null
    }
    const bytes = text === null ? Infinity : Buffer.byteLength(text)
    if (
      text === null ||
      bytes > MAX_RESULT_BYTES ||
      this.bytes + bytes > this.cap ||
      !jsonDepthWithin(text, MAX_MESSAGE_DEPTH)
    ) {
      this.over = true
      this.deps.send({ type: 'truncated', id: this.id })
      return
    }
    this.count(bytes)
    this.deps.send(message)
  }

  private count(bytes: number): void {
    this.bytes += bytes
    if (this.bytes > this.cap) this.over = true
  }

  private async pace(): Promise<void> {
    const now = this.deps.now()
    this.sentAt = this.sentAt.filter((at) => now - at < RATE_WINDOW_MS)
    if (this.sentAt.length >= RATE_MAX) await this.deps.wait(RATE_WINDOW_MS - (now - this.sentAt[0]!))
    this.sentAt.push(this.deps.now())
  }
}
