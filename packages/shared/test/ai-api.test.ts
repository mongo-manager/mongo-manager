// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  AI_LIMITS,
  AiProviderInputSchema,
  AiProviderPatchSchema,
  AiRequestSchema,
  ConnectionMetaSchema,
  ConnectionPatchSchema,
} from '../src/index'

describe('AI contracts (phase 4a-1 spec §2–§3)', () => {
  it('fills a provider’s defaults and bounds its fields', () => {
    expect(AiProviderInputSchema.parse({ name: ' Claude ', kind: 'anthropic', apiKey: 'k' })).toEqual({
      name: 'Claude',
      kind: 'anthropic',
      apiKey: 'k',
      maxTokens: 2048,
      enabled: true,
      isDefault: false,
    })
    expect(() => AiProviderInputSchema.parse({ name: 'x', kind: 'mistral' })).toThrow()
    expect(() => AiProviderInputSchema.parse({ name: 'x', kind: 'ollama', maxTokens: 9000 })).toThrow()
    expect(() => AiProviderInputSchema.parse({ name: 'x', kind: 'ollama', maxTokens: 100 })).toThrow()
    expect(() => AiProviderInputSchema.parse({ name: '', kind: 'ollama' })).toThrow()
    expect(() => AiProviderInputSchema.parse({ name: 'x', kind: 'ollama', extra: 1 })).toThrow()
  })

  it('lets a patch remove the key with null and refuses an empty patch', () => {
    expect(AiProviderPatchSchema.parse({ apiKey: null })).toEqual({ apiKey: null })
    expect(() => AiProviderPatchSchema.parse({})).toThrow()
  })

  it('bounds a request: action, prompt, samples and mask paths', () => {
    expect(AiRequestSchema.parse({ action: 'describe' })).toEqual({
      action: 'describe',
      prompt: '',
      language: 'en',
    })
    expect(() => AiRequestSchema.parse({ action: 'run' })).toThrow()
    expect(() =>
      AiRequestSchema.parse({ action: 'query', prompt: 'x'.repeat(AI_LIMITS.prompt + 1) }),
    ).toThrow()
    expect(() => AiRequestSchema.parse({ action: 'query', samples: { count: 6 } })).toThrow()
    expect(() =>
      AiRequestSchema.parse({
        action: 'query',
        samples: { count: 1, mask: Array.from({ length: 51 }, (_, i) => `f${i}`) },
      }),
    ).toThrow()
    expect(
      AiRequestSchema.parse({ action: 'query', prompt: 'big orders', samples: { count: 2 } }).samples,
    ).toEqual({ count: 2, mask: [] })
    expect(() => AiRequestSchema.parse({ action: 'query', current: { pipeline: [], eval: 1 } })).toThrow()
  })

  it('carries a connection’s AI policy, any by default', () => {
    expect(ConnectionMetaSchema.parse({ name: 'x' }).aiPolicy).toBe('any')
    expect(ConnectionPatchSchema.parse({ aiPolicy: 'local' })).toEqual({ aiPolicy: 'local' })
    expect(() => ConnectionPatchSchema.parse({ aiPolicy: 'cloud' })).toThrow()
  })
})
