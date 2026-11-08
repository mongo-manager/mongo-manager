// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// node:vm runs mongosh in a context whose code generation is disabled, on top of the process-wide
// --disallow-code-generation-from-strings. vm is not trusted as the boundary here (spec §3.2): the
// process, the permission model and the disabled code generation are. This is the shell sandbox.
// eslint-disable-next-line no-restricted-imports
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { inspect } from 'node:util'
import { deserializeValue, formatShell } from '@mongo-manager/shared'
import { EJSON } from 'bson'
import { OpenContextRuntime } from '@mongosh/browser-runtime-core'
import { NodeDriverServiceProvider } from '@mongosh/service-provider-node-driver'

/**
 * Phase 3a-1 spec §3.2: the mongosh runtime on a locked-down vm context. User code cannot generate
 * code from strings, cannot run longer than the command budget synchronously, and the editor,
 * loader and telemetry features are removed.
 */

/**
 * Shell API members that read files, spawn editors, install code, or prompt: removed. `exit()` and
 * `quit()` closed the shell's MongoDB client and left it so (second review 2026-10-12, I1).
 */
const REMOVED = [
  'load',
  'edit',
  'requireCmd',
  'enableTelemetry',
  'disableTelemetry',
  'passwordPrompt',
  'cls',
  'exit',
  'quit',
]
/** MongoDB's limit on a database name. */
const MAX_DB_NAME = 64
/** The result types whose printable value is a batch of documents ({ cursorHasMore, documents }). */
const CURSOR_TYPES = new Set([
  'Cursor',
  'AggregationCursor',
  'CursorIterationResult',
  'ChangeStreamCursor',
  'RunCommandCursor',
])

export interface EvalResult {
  resultType: string | null
  /** Canonical EJSON of the printable value, or its string form when it cannot be serialised. */
  value: unknown
  /** A cursor result with more to show (mongosh's cursorHasMore). */
  hasMore: boolean
}

/** How a printed value that is not a string is written: as mongosh writes it (util.inspect). */
const INSPECT = { depth: 6, breakLength: 100, compact: 3, maxArrayLength: 100, maxStringLength: 10_000 }

export class ShellRuntime {
  /** What the code prints (print, printjson…), a line of text per call. */
  onPrint: ((text: string) => void) | null = null
  private runtime: OpenContextRuntime | null = null
  private context: vm.Context | null = null
  private timeoutMs = 60_000

  async connect(uri: string, appName: string): Promise<void> {
    const bus = new EventEmitter()
    // Security audit 2026-10-16 (dependencies): no proxy option, ever — devtools-connect would load
    // pac-proxy-agent > get-uri > basic-ftp (CPU DoS in <= 6.2.0) only for one (shell-no-proxy test).
    const provider = await NodeDriverServiceProvider.connect(
      uri,
      { productName: 'mongo-manager-shell', productDocsLink: 'https://github.com/', appName },
      {},
      bus,
    )
    // A fresh context with code generation from strings and WASM refused, on top of the
    // process-wide --disallow-code-generation-from-strings.
    const context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
    })
    this.context = context
    this.runtime = new OpenContextRuntime(
      provider,
      {
        // A synchronous stretch of user code cannot outrun the command budget.
        sloppyEval: (code: string) => vm.runInContext(code, context, { timeout: this.timeoutMs }),
        getContextObject: () => context,
      },
      bus,
    )
    // Second review 2026-10-16 (N-2): mongosh prefetches collection and database names on every
    // `use` without waiting for them, so they reached the proxy after the command had ended and were
    // refused (code left running). Completion fetches them itself, while it counts as running.
    const state = (
      this.runtime as unknown as {
        instanceState?: { setPreFetchCollectionAndDatabaseNames?(on: boolean): void }
      }
    ).instanceState
    state?.setPreFetchCollectionAndDatabaseNames?.(false)
    // Found 2026-10-12: print() and printjson() showed nothing — mongosh hands them to this listener.
    this.runtime.setEvaluationListener({
      onPrint: (values: Array<{ printable?: unknown; type?: string | null }>) => {
        this.onPrint?.(values.map((v) => this.printed(v)).join(' '))
      },
    })
    // Prime the shell API, then remove the dangerous members from the exposed context.
    await this.runtime.getShellPrompt()
    this.harden()
  }

  private harden(): void {
    const ctx = this.context as Record<string, unknown> | null
    if (!ctx) return
    for (const name of REMOVED) {
      try {
        Object.defineProperty(ctx, name, {
          value: () => {
            throw new Error(`${name} is disabled in the shell`)
          },
          writable: false,
          configurable: false,
        })
      } catch {
        // If a member is not present it need not be removed.
      }
    }
  }

  setTimeout(ms: number): void {
    this.timeoutMs = ms
  }

  async getPrompt(): Promise<string> {
    if (!this.runtime) throw new Error('not connected')
    try {
      return await this.runtime.getShellPrompt()
    } catch {
      return '>'
    }
  }

  /**
   * The shell's current database, from mongosh's own state rather than the `db` code can shadow; read
   * as a plain data property, so no getter runs (final review M6). Null when it cannot be told.
   */
  currentDb(): string | null {
    try {
      const state = (this.runtime as unknown as { instanceState?: { currentDb?: object } } | null)
        ?.instanceState
      const current = state?.currentDb
      if (!current) return null
      const name = Object.getOwnPropertyDescriptor(current, '_name')?.value as unknown
      return typeof name === 'string' && name.length > 0 && name.length <= MAX_DB_NAME ? name : null
    } catch {
      return null
    }
  }

  /**
   * Phase 3a-2 spec §3.2: mongosh's completer type-analyses the code up to the caret. It never runs
   * it — this path must not call evaluate. Each item is a whole completed line.
   */
  async complete(code: string): Promise<string[]> {
    if (!this.runtime) return []
    const list = await this.runtime.getCompletions(code)
    return list.map((c) => c.completion)
  }

  async evaluate(code: string): Promise<EvalResult> {
    if (!this.runtime) throw new Error('not connected')
    const result = await this.runtime.evaluate(code)
    // A cursor batch comes as { cursorHasMore, documents }: send the documents themselves, as mongosh
    // prints them, and whether there is more (phase 3a-2 spec §3.3).
    const printable = result.printable as { cursorHasMore?: unknown; documents?: unknown } | null | undefined
    // Only a cursor's result is a batch: an object the code returns that merely looks like one is
    // shown as written (final review M4).
    const batch =
      CURSOR_TYPES.has(result.type ?? '') &&
      printable &&
      Array.isArray(printable.documents) &&
      'cursorHasMore' in printable
    return {
      resultType: result.type ?? null,
      // No value (a declaration, print's own): nothing to show, as in mongosh.
      value:
        result.printable === undefined
          ? undefined
          : this.serialise(batch ? printable.documents : result.printable),
      hasMore: batch ? printable.cursorHasMore === true : false,
    }
  }

  /**
   * A printed value as mongosh writes it (second review 2026-10-12, minor 23): a string as it is, a
   * cursor as its documents, a value in shell syntax (ObjectId(…), ISODate(…)) through the same
   * formatter as results; anything it cannot take, as Node shows it.
   */
  private printed(value: { printable?: unknown; type?: string | null }): string {
    const printable = value.printable as { cursorHasMore?: unknown; documents?: unknown } | string | undefined
    if (typeof printable === 'string') return printable
    const shown =
      CURSOR_TYPES.has(value.type ?? '') && printable && Array.isArray(printable.documents)
        ? printable.documents
        : printable
    try {
      return formatShell(deserializeValue(this.serialise(shown)), { indent: 2 })
    } catch {
      return inspect(shown, INSPECT)
    }
  }

  private serialise(printable: unknown): unknown {
    try {
      // Canonical EJSON keeps BSON types exact for the browser to render.
      return JSON.parse(
        EJSON.stringify(printable as Parameters<typeof EJSON.stringify>[0], { relaxed: false }),
      )
    } catch {
      try {
        return String(printable)
      } catch {
        return '[unprintable]'
      }
    }
  }
}
