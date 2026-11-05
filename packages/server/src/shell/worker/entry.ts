// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { Console } from 'node:console'
import { maskShellSecrets, shellCommand } from '@mongo-manager/shared'
import { LineSplitter, decodeLine, encodeLine } from '../channel'
import {
  ShellToWorker,
  WorkerToShell,
  EXIT_NO_SANDBOX,
  MAX_COMMAND_BYTES,
  MAX_COMPLETIONS,
  MAX_COMPLETION_BYTES,
  MAX_PIECE_LABEL,
} from '../ipc'
import { lockNetwork } from './network'
import { Output } from './output'
import { ShellRuntime } from './runtime'
import { labelOf, splitScript } from './script'
import { quietFlagWarnings } from './warnings'

/** A script asked to stop between its pieces. */
class Stopped extends Error {
  readonly code = 'STOPPED'
  constructor() {
    super('Stopped.')
  }
}

/**
 * Shell commands this shell does not run (review 2026-10-12, I12): `exit` and `quit` closed the
 * shell's MongoDB client and left it so; `cls` did nothing. The page clears its screen and ends its
 * session itself; in a script they are refused, the page saying why in the user's language.
 */
const NOT_HERE = new Set(['exit', 'quit', 'cls'])
class NotHere extends Error {
  readonly code = 'NOT_AVAILABLE'
}

/** The client's connection closed under the shell (`db.getMongo().close()`): only a restart helps. */
const DISCONNECTED = /Client must be connected/i
/** The proxy's codeName for refused server-side JavaScript (proxy.ts SERVER_JS_CODE_NAME). */
const SERVER_JS_CODE_NAME = 'MongoManagerServerJsDisabled'

/**
 * Phase 3a-1 spec §3.1 and §3.2: the shell worker. It refuses to run outside its sandbox, scrubs its
 * environment, locks the network to the session proxy, then runs mongosh. It holds no secret. Every
 * IPC message is validated; anything unexpected is ignored (the parent kills a misbehaving worker).
 */

/**
 * Messages go to the parent as JSON lines on stdout, and come from it on stdin (security audit
 * 2026-10-16: the parent bounds each line before parsing it; Node's IPC channel could not be).
 */
function send(message: WorkerToShell): void {
  process.stdout.write(encodeLine(message))
}

/** The longest line the parent sends: a command of 256 KiB, escaped as JSON (six bytes a character at most). */
const MAX_INCOMING_BYTES = 6 * MAX_COMMAND_BYTES + 4096

/**
 * stdout carries the messages, so nothing else may write there: anything that logs in this
 * process (a library's console.log) goes to stderr, which the parent keeps and caps.
 */
function keepStdoutForMessages(): void {
  const toStderr = new Console({ stdout: process.stderr, stderr: process.stderr })
  Object.defineProperty(globalThis, 'console', { value: toStderr, writable: true, configurable: true })
}

/** Only strings within the IPC cap are sent, at most 200: a hostile or huge set cannot flood the parent. */
function boundedItems(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  return items
    .filter((i): i is string => typeof i === 'string' && Buffer.byteLength(i) <= MAX_COMPLETION_BYTES)
    .slice(0, MAX_COMPLETIONS)
}

/** The sandbox must be on: the permission model, and no code generation from strings. */
function sandboxActive(): boolean {
  if (!process.permission) return false
  try {
    // eslint-disable-next-line no-new-func
    new Function('return 1')()
    return false // code generation is allowed — not sandboxed
  } catch {
    return true
  }
}

/** Keep only the environment the platform needs; the parent already passes a minimal set. */
function scrubEnv(): void {
  const keep = new Set(process.platform === 'win32' ? ['SystemRoot'] : [])
  for (const key of Object.keys(process.env)) {
    if (!keep.has(key)) delete process.env[key]
  }
}

function run(): void {
  quietFlagWarnings()
  if (!sandboxActive()) {
    process.stderr.write('mongo-manager shell worker: refusing to run without the sandbox\n')
    process.exit(EXIT_NO_SANDBOX)
  }
  scrubEnv()
  keepStdoutForMessages()

  const runtime = new ShellRuntime()
  let initialised = false
  /** The id of the command running, or false. */
  let running: number | false = false
  /** The running command was asked to stop: what is left of its script is not run. */
  let stopped = false
  /** What the command prints and returns, sent within the parent's caps. */
  const output = new Output({
    send,
    now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    schedule: (later, ms) => {
      const timer = setTimeout(later, ms)
      return () => clearTimeout(timer)
    },
  })
  runtime.onPrint = (text) => output.print(text)
  let completing: Promise<void> | null = null

  const incoming = new LineSplitter(
    MAX_INCOMING_BYTES,
    (line) => {
      const decoded = decodeLine(line)
      // The parent never sends anything else; ignored.
      if (!('message' in decoded)) return
      const parsed = ShellToWorker.safeParse(decoded.message)
      if (!parsed.success) return // The parent validates too and will end the worker.
      void handle(parsed.data)
    },
    () => process.exit(1),
  )
  process.stdin.on('data', (chunk: Buffer) => incoming.push(chunk))
  // The parent is gone (its end of the pipe closed): so is this worker, never left running alone.
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))

  /** A command's end: the prompt, and the current database (after `use`, not the one opened). */
  async function doneMessage(id: number): Promise<WorkerToShell> {
    const db = runtime.currentDb()
    return { type: 'done', id, prompt: await runtime.getPrompt(), ...(db ? { db } : {}) }
  }

  async function handle(message: ShellToWorker): Promise<void> {
    switch (message.type) {
      case 'init': {
        if (initialised) return
        initialised = true
        try {
          lockNetwork(message.proxyPort, message.token)
          runtime.setTimeout(message.syncTimeoutMs)
          if (message.outputCapBytes) output.setCap(message.outputCapBytes)
          await runtime.connect(message.uri, message.appName)
          send({ type: 'ready', prompt: await runtime.getPrompt() })
        } catch (e) {
          send({ type: 'error', id: 0, code: 'CONNECT_FAILED', message: errText(e) })
        }
        return
      }
      case 'eval': {
        if (!initialised || running) return
        running = message.id
        stopped = false
        output.begin(message.id)
        // A script runs piece by piece, as mongosh runs what is typed (user report 2026-10-12): each
        // result named by its piece when there are several; an error, or a stop, ends it there.
        let pieces: string[] = []
        let at = 0
        try {
          // A command never runs alongside a completion (whose sample queries would otherwise mix
          // with the command's): it waits for a pending completion to finish (final review I2).
          await completing
          pieces = splitScript(message.code)
          for (; at < pieces.length; at++) {
            if (stopped) throw new Stopped()
            const piece = pieces[at]!
            const command = shellCommand(piece)
            if (command && NOT_HERE.has(command)) throw new NotHere(command)
            const result = await runtime.evaluate(piece)
            await output.result({
              resultType: result.resultType,
              value: result.value,
              hasMore: result.hasMore,
              // Its name masked before it is cut: a secret cut in half would show (second review
              // 2026-10-12, minor 8).
              ...(pieces.length > 1
                ? { command: maskShellSecrets(labelOf(piece)).slice(0, MAX_PIECE_LABEL) }
                : {}),
            })
          }
        } catch (e) {
          output.flush()
          // Stopped before a piece ran: that piece is left unrun too.
          const skipped = Math.max(0, pieces.length - at - (e instanceof Stopped ? 0 : 1))
          const text = errText(e)
          const code =
            e instanceof Stopped || e instanceof NotHere
              ? e.code
              : DISCONNECTED.test(text)
                ? 'DISCONNECTED'
                : codeNameOf(e) === SERVER_JS_CODE_NAME
                  ? 'SERVER_JS'
                  : 'EVAL_ERROR'
          send({ type: 'error', id: message.id, code, message: text, ...(skipped > 0 ? { skipped } : {}) })
        } finally {
          output.flush()
          const done = await doneMessage(message.id)
          output.end()
          send(done)
          running = false
        }
        return
      }
      case 'complete': {
        // No completion while a command runs or another completion is in flight; never evaluate.
        if (!initialised || running || completing) {
          send({ type: 'completions', id: message.id, items: [] })
          return
        }
        // The completion counts as in flight until it has really finished (no race that answers
        // early and lets it run on): the parent resets a worker whose completion overruns
        // (final review I2).
        completing = (async () => {
          try {
            const items = await runtime.complete(message.code)
            send({ type: 'completions', id: message.id, items: boundedItems(items) })
          } catch {
            send({ type: 'completions', id: message.id, items: [] })
          }
        })().finally(() => {
          completing = null
        })
        return
      }
      case 'ping':
        send({ type: 'pong', rss: process.memoryUsage.rss(), heapUsed: process.memoryUsage().heapUsed })
        return
      case 'cancel':
        // Best effort: the proxy kills the operation and the parent restarts the worker if needed;
        // what is left of a script is not run.
        if (running === message.id) stopped = true
        return
    }
  }
}

/** A server error's codeName, read as plain data (no getter of user code runs). */
function codeNameOf(e: unknown): unknown {
  if (!e || typeof e !== 'object') return undefined
  try {
    return Object.getOwnPropertyDescriptor(e, 'codeName')?.value
  } catch {
    return undefined
  }
}

function errText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.slice(0, 4096)
}

run()
