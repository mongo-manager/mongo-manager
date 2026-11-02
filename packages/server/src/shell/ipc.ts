import { z } from 'zod'

/**
 * Phase 3a-1 spec §3.3: the messages between the server and a shell worker. Both sides parse
 * every message; anything else ends the worker. No secret ever travels here. They travel as JSON
 * lines over the worker's stdin and stdout, each bounded before it is parsed (channel.ts).
 */
export const MAX_COMMAND_BYTES = 256 * 1024
export const MAX_IPC_MESSAGE_BYTES = 1024 * 1024
/** The most output a command sends the page; past it, the rest is dropped (the worker stops too). */
export const OUTPUT_CAP_BYTES = 5 * 1024 * 1024
/** Phase 3a-2 spec §3.2: a completion reply is bounded in count and in bytes per item. */
export const MAX_COMPLETIONS = 200
export const MAX_COMPLETION_BYTES = 512
/** A script's piece named with its result: its first characters (user report 2026-10-12). */
export const MAX_PIECE_LABEL = 512

export const ShellToWorker = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('init'),
    proxyPort: z.number().int().min(1).max(65535),
    token: z.string().regex(/^[0-9a-f]{64}$/),
    /** The connection's hosts and topology options only: no user, password, TLS or SSH option. */
    uri: z.string().min(1).max(8192),
    db: z.string().min(1).max(64),
    appName: z.string().min(1).max(128),
    /** Milliseconds a synchronous stretch of user code may run. */
    syncTimeoutMs: z.number().int().min(10).max(3_600_000),
    /** The output cap of one command, as configured (spec §4; default OUTPUT_CAP_BYTES). */
    outputCapBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(64 * 1024 * 1024)
      .optional(),
  }),
  z.strictObject({
    type: z.literal('eval'),
    id: z.number().int().min(1),
    code: z.string().max(MAX_COMMAND_BYTES),
  }),
  z.strictObject({ type: z.literal('cancel'), id: z.number().int().min(1) }),
  z.strictObject({ type: z.literal('ping') }),
  // Phase 3a-2: complete the code up to the caret. The worker type-analyses it; it never runs it.
  z.strictObject({
    type: z.literal('complete'),
    id: z.number().int().min(1),
    code: z.string().max(MAX_COMMAND_BYTES),
  }),
])
export type ShellToWorker = z.infer<typeof ShellToWorker>

export const WorkerToShell = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), prompt: z.string().max(1024) }),
  z.strictObject({ type: z.literal('print'), id: z.number().int().min(1), text: z.string() }),
  z.strictObject({
    type: z.literal('result'),
    id: z.number().int().min(1),
    resultType: z.string().max(128).nullable(),
    /** Canonical EJSON. */
    value: z.unknown(),
    /** Phase 3a-2: whether a cursor result has more to show (mongosh's cursorHasMore). */
    hasMore: z.boolean().optional(),
    /** The piece of a script this result is of, when the script had more than one. */
    command: z.string().max(MAX_PIECE_LABEL).optional(),
  }),
  z.strictObject({
    type: z.literal('error'),
    id: z.number().int().min(0),
    code: z.string().max(128),
    message: z.string().max(64 * 1024),
    /** The pieces of the script left unrun after this error. */
    skipped: z.number().int().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('done'),
    id: z.number().int().min(1),
    prompt: z.string().max(1024),
    // Phase 3a-2: the shell's current database, for completion (final review M6).
    db: z.string().min(1).max(64).optional(),
  }),
  // Security audit 2026-10-16: a result held back because it would not fit in a message or would
  // pass the output cap; the parent says the output was cut.
  z.strictObject({ type: z.literal('truncated'), id: z.number().int().min(1) }),
  z.strictObject({ type: z.literal('pong'), rss: z.number().min(0), heapUsed: z.number().min(0) }),
  z.strictObject({
    type: z.literal('completions'),
    id: z.number().int().min(1),
    items: z
      .array(z.string().refine((s) => Buffer.byteLength(s) <= MAX_COMPLETION_BYTES))
      .max(MAX_COMPLETIONS),
  }),
])
export type WorkerToShell = z.infer<typeof WorkerToShell>

/** The exit code of a worker started outside its sandbox: it evaluates nothing. */
export const EXIT_NO_SANDBOX = 78
