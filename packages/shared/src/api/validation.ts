// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { z } from 'zod'
import { EjsonObjectSchema } from './data'

/** Phase 2b spec §2.2: a collection's validation rules. */
export const VALIDATION_LEVELS = ['off', 'strict', 'moderate'] as const
export const VALIDATION_ACTIONS = ['error', 'warn', 'errorAndLog'] as const
/** errorAndLog arrived in MongoDB 8.1. */
export const ERROR_AND_LOG_SINCE = '8.1'

export const ValidationBodySchema = z.object({
  validator: EjsonObjectSchema.nullable(),
  validationLevel: z.enum(VALIDATION_LEVELS),
  validationAction: z.enum(VALIDATION_ACTIONS),
  /** The version the user read (GET): a save is refused when the rules changed since. */
  expected: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})
export type ValidationBody = z.infer<typeof ValidationBodySchema>

export const ValidationTestSchema = z.object({
  validator: EjsonObjectSchema,
  maxTimeMS: z.number().int().min(100).max(120_000).default(30_000),
})

export interface ValidationState {
  /** Canonical EJSON; null when the collection has no rules. */
  validator: Record<string, unknown> | null
  validationLevel: (typeof VALIDATION_LEVELS)[number]
  validationAction: (typeof VALIDATION_ACTIONS)[number]
  /** Identifies these rules: a save sends it back as expected. */
  version: string
  kind: 'collection' | 'view' | 'timeseries'
  /** The server's version, so the editor offers only what it supports. */
  serverVersion: string
}

export interface ValidationTestResult {
  total: number
  /** Null when counting took too long; failingAtLeast then holds a lower bound. */
  failing: number | null
  failingAtLeast?: number
  /** The examples stopped at their size limit. */
  sampleTruncated?: boolean
  sample: Array<{ document: unknown; hash: string } | { unsupported: { _id: unknown; reason: string } }>
}

/** What a save answers: the rules now, and the ones it replaced (for Restore). */
export type ValidationSaved = ValidationState & {
  previous: Pick<ValidationState, 'validator' | 'validationLevel' | 'validationAction'>
}
