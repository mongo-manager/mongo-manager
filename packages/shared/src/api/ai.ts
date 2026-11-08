// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { UiLanguageSchema } from '../languages'

/** Phase 4a-1 spec §1.1: the one-shot actions. */
export const AI_ACTIONS = ['query', 'pipeline', 'explain', 'optimise', 'validation', 'describe'] as const
export type AiAction = (typeof AI_ACTIONS)[number]
/** Actions whose words are required (the others may run on the context alone). */
export const AI_PROMPTED: ReadonlySet<AiAction> = new Set(['query', 'pipeline', 'validation'])

export const AI_KINDS = ['anthropic', 'openai', 'ollama', 'gemini'] as const
export type AiKind = (typeof AI_KINDS)[number]
export const AI_POLICIES = ['off', 'local', 'any'] as const
export type AiPolicy = (typeof AI_POLICIES)[number]
export const AiPolicySchema = z.enum(AI_POLICIES)

export const AI_DEFAULT_BASE_URL: Readonly<Record<AiKind, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434',
  gemini: 'https://generativelanguage.googleapis.com',
}
export const AI_DEFAULT_MODEL = 'claude-sonnet-5'
/** Phase 4a-2 spec §2.7: the kinds that cannot work without a key. */
export const AI_KEY_REQUIRED: ReadonlySet<AiKind> = new Set(['anthropic', 'gemini'])
/**
 * Phase 4a-2 spec §2.7, C11: a Gemini model name travels in the URL path, so it is one plain segment —
 * letters, digits, ".", "_" and "-", never "." or ".." alone.
 */
export const GEMINI_MODEL = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/

/** Spec §1.3, §2.1, §2.2. */
export const AI_LIMITS = {
  providers: 10,
  prompt: 2000,
  /** Earlier requests sent with a change (UI redesign R1 review). */
  history: 8,
  currentBytes: 16 * 1024,
  samples: 5,
  maskPaths: 50,
  maxTokensMin: 256,
  maxTokensMax: 8192,
  maxTokensDefault: 2048,
  schemaSample: 200,
  schemaPaths: 300,
  sampleBytes: 4 * 1024,
  contextBytes: 48 * 1024,
  answerBytes: 512 * 1024,
  lineBytes: 64 * 1024,
  stages: 100,
  indexes: 5,
} as const

/** Why a request did not run or did not end well, worded by the web (spec §2.3, §3.4). */
export const AI_REASONS = [
  'ai_off',
  'ai_local_only',
  'no_provider',
  'samples_refused',
  'prompt_required',
  'credential_collection',
  'write_pipeline',
  'too_large',
  'rate_limited',
  'busy',
  'key_refused',
  'model_unknown',
  'overloaded',
  'too_long',
  'address_refused',
  'unreachable',
  'timeout',
  'provider_error',
  'aborted',
  // Phase 4a-2.
  'blocked',
  'model_invalid',
  'chat_busy',
  'chat_full',
  'nothing_to_retry',
  'history_local',
  // Review M1: a general turn's local-only collection names, and a provider answering from outside.
  'names_local',
  // W6.3: agent mode is off for this person.
  'agent_off',
] as const
export type AiReason = (typeof AI_REASONS)[number]

/** Spec §1.4: what a parsed result carries before it may be inserted. */
export const AI_WARNINGS = ['write_stage', 'server_js', 'dropped_keys', 'masked_values'] as const
export type AiWarning = (typeof AI_WARNINGS)[number]

const MaxTokens = z.number().int().min(AI_LIMITS.maxTokensMin).max(AI_LIMITS.maxTokensMax)
const Name = z.string().trim().min(1).max(60)
const BaseUrl = z.string().trim().min(1).max(2048)
const Model = z.string().trim().min(1).max(200)
const ApiKey = z.string().min(1).max(4096)

/**
 * User review 2026-10-09: the models a provider offers, read from it for the provider editor. A saved
 * provider's key is used only for its own kind and address (providerId); a typed key travels as is.
 */
export const AiModelsRequestSchema = z.strictObject({
  kind: z.enum(AI_KINDS),
  baseUrl: z.string().min(1).max(2048).optional(),
  apiKey: ApiKey.optional(),
  providerId: z.uuid().optional(),
})
export type AiModelsRequest = z.infer<typeof AiModelsRequestSchema>
export interface AiModel {
  id: string
  label?: string
}
export interface AiModelsResult {
  outcome: 'ok' | AiReason
  models: AiModel[]
}

/** User review 2026-10-09: a provider's price per million tokens, as an administrator enters it. */
export const AI_CURRENCIES = ['USD', 'EUR', 'GBP', 'TRY'] as const
export type AiCurrency = (typeof AI_CURRENCIES)[number]
export const AiPriceSchema = z.strictObject({
  input: z.number().min(0).max(100_000),
  output: z.number().min(0).max(100_000),
  currency: z.enum(AI_CURRENCIES),
})
export type AiPrice = z.infer<typeof AiPriceSchema>

export const AiProviderInputSchema = z.strictObject({
  name: Name,
  kind: z.enum(AI_KINDS),
  baseUrl: BaseUrl.optional(),
  model: Model.optional(),
  apiKey: ApiKey.optional(),
  maxTokens: MaxTokens.default(AI_LIMITS.maxTokensDefault),
  /** Absent: on for a local provider, off otherwise (decided when it is saved: §2.1). */
  samples: z.boolean().optional(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  price: AiPriceSchema.optional(),
})
export type AiProviderInput = z.output<typeof AiProviderInputSchema>

export const AiProviderPatchSchema = z
  .strictObject({
    name: Name.optional(),
    kind: z.enum(AI_KINDS).optional(),
    baseUrl: BaseUrl.optional(),
    model: Model.optional(),
    /** null removes the stored key. */
    apiKey: ApiKey.nullable().optional(),
    maxTokens: MaxTokens.optional(),
    samples: z.boolean().optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    /** null removes the price. */
    price: AiPriceSchema.nullable().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'Nothing to update')
export type AiProviderPatch = z.output<typeof AiProviderPatchSchema>

/** An administrator's view of a provider: never the key. */
export interface AiProviderView {
  id: string
  name: string
  kind: AiKind
  baseUrl: string
  model: string
  keyStored: boolean
  maxTokens: number
  samples: boolean
  enabled: boolean
  isDefault: boolean
  /** Local or cloud, as the last test or request found it; null before one. */
  lastLocal: boolean | null
  lastTestedAt: number | null
  /** The last test's outcome: 'ok' or a reason. */
  lastTest: string | null
  /** User review 2026-10-09: its price per million tokens, or null when none was entered. */
  price: AiPrice | null
}

/** Spec §3.4: what a user's pages need to offer the assistant. */
export interface AiStatus {
  enabled: boolean
  allowServerJs: boolean
  providers: Array<{
    id: string
    name: string
    kind: AiKind
    model: string
    local: boolean | null
    samples: boolean
    isDefault: boolean
  }>
  limits: { perMinute: number; perDay: number; perUser: number; concurrent: number }
  /** Phase 4a-2 plan ruling 14: how long chats are kept (0: memory only) and their caps. */
  chat?: { days: number; chats: number; messages: number }
}

const Doc = z.record(z.string(), z.unknown())
/** The editor's content as canonical EJSON (plan ruling 3). */
export const AiCurrentSchema = z.strictObject({
  filter: Doc.optional(),
  projection: Doc.optional(),
  sort: Doc.optional(),
  pipeline: z.array(Doc).max(AI_LIMITS.stages).optional(),
})
export const AiSamplesSchema = z.strictObject({
  count: z.number().int().min(1).max(AI_LIMITS.samples),
  mask: z.array(z.string().trim().min(1).max(512)).max(AI_LIMITS.maskPaths).default([]),
})
export const AiRequestSchema = z.strictObject({
  action: z.enum(AI_ACTIONS),
  prompt: z.string().max(AI_LIMITS.prompt).default(''),
  /** Plan ruling 16: the reader's language, for the prose. */
  language: UiLanguageSchema.default('en'),
  provider: z.uuid().optional(),
  current: AiCurrentSchema.optional(),
  samples: AiSamplesSchema.optional(),
  /**
   * UI redesign R1 review: change the current query or pipeline as the prompt says, rather than write
   * a new one; `history` holds the earlier requests that led to it, oldest first.
   */
  refine: z.boolean().optional(),
  history: z.array(z.string().max(AI_LIMITS.prompt)).max(AI_LIMITS.history).optional(),
  /**
   * User review 2026-10-09: the chain a request belongs to — a pipeline's first request and the
   * changes asked of it after — so the AI history shows them together. The browser picks it.
   */
  thread: z.uuid().optional(),
})
export type AiRequest = z.output<typeof AiRequestSchema>
/** The bodies the browser sends, before defaults. */
export type AiRequestBody = z.input<typeof AiRequestSchema>
export type AiProviderInputBody = z.input<typeof AiProviderInputSchema>
export type AiProviderPatchBody = z.input<typeof AiProviderPatchSchema>

/** Spec §1.3: the schema without values. */
export interface AiSchemaSummary {
  sampled: number
  count: number | null
  fields: Array<{ path: string; types: Record<string, number>; share: number; personal?: true }>
  /** Paths left out over the cap. */
  more: number
}

/** Exactly what left the server (the sheet's "What was sent"). */
export interface AiSent {
  namespace: string
  schema: AiSchemaSummary | null
  current: string | null
  plan: unknown
  indexes: unknown
  validator: string | null
  samples: string[]
  /** What the 48 KiB cap left out: "schema_paths:120", "samples:2". */
  leftOut: string[]
  /**
   * UI redesign R1 review: the collections a request may need, by their schema only — paths and
   * types, never values. Sent for a query or a pipeline. By default "via" is a field of this
   * collection that holds the _id of a document in "namespace" (customerId → customers).
   */
  related?: Array<{
    namespace: string
    /** The referring field's MongoDB path (items.productId). */
    via: string
    /** The field sits in an array of documents (each element refers to one document). */
    inArray?: true
    /** User review 2026-10-08: "via" is a field of "namespace" that holds the _id of this collection's documents. */
    refersHere?: true
    /** User review 2026-10-08: "via" is a field of this other collection that refers to "namespace". */
    from?: string
    schema: AiSchemaSummary
  }>
}

type EjsonDoc = Record<string, unknown>
export type AiResult =
  | { kind: 'query'; filter: EjsonDoc; projection?: EjsonDoc; sort?: EjsonDoc }
  | { kind: 'pipeline'; stages: EjsonDoc[] }
  | { kind: 'validation'; validator: EjsonDoc }
  | { kind: 'optimise'; indexes: Array<{ keys: EjsonDoc; options: EjsonDoc }> }

/** The NDJSON lines of an action's answer (spec §3.4). */
export type AiLine =
  | {
      type: 'context'
      sent: AiSent
      provider: { id: string; name: string; model: string; kind: AiKind }
    }
  | { type: 'text'; delta: string }
  | {
      type: 'done'
      result: AiResult | null
      warnings: AiWarning[]
      reason?: 'unparsable' | 'wrong_shape' | 'server_js' | 'needs_pipeline'
      usage: { input: number; output: number }
      /** Local or cloud, from the address the request connected to. */
      local: boolean | null
    }
  | {
      type: 'error'
      reason: AiReason
      retryAfterMs?: number
      /** Final review I4: the request failed before anything left the server. */
      nothingSent?: true
    }
