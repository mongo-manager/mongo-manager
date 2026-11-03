import { describe, expect, it } from 'vitest'
import {
  AI_CHAT_LIMITS,
  AI_KEY_REQUIRED,
  AI_KINDS,
  AiChatCollectionTurnSchema,
  AiChatRenameSchema,
  AiChatTurnSchema,
  AiProviderInputSchema,
  GEMINI_MODEL,
} from '../src/index'

describe('chat contracts (phase 4a-2 spec §2.5, §2.7)', () => {
  it('bounds a turn and fills its defaults', () => {
    expect(AiChatTurnSchema.parse({ message: ' hi ' })).toEqual({
      message: 'hi',
      language: 'en',
      retry: false,
    })
    expect(() => AiChatTurnSchema.parse({ message: '   ' })).toThrow()
    expect(() => AiChatTurnSchema.parse({ message: 'x'.repeat(AI_CHAT_LIMITS.message + 1) })).toThrow()
    expect(() => AiChatTurnSchema.parse({ message: 'x', chat: 'not-a-uuid' })).toThrow()
    expect(() => AiChatTurnSchema.parse({ message: 'x', parts: { current: true } })).toThrow()
    expect(AiChatCollectionTurnSchema.parse({ message: 'x' })).toEqual({
      message: 'x',
      language: 'en',
      retry: false,
      parts: { current: false, indexes: true, validator: false },
    })
    expect(() => AiChatCollectionTurnSchema.parse({ message: 'x', samples: { count: 9 } })).toThrow()
    expect(() => AiChatCollectionTurnSchema.parse({ message: 'x', extra: 1 })).toThrow()
  })

  it('bounds a title', () => {
    expect(AiChatRenameSchema.parse({ title: ' Orders ' })).toEqual({ title: 'Orders' })
    expect(() => AiChatRenameSchema.parse({ title: '' })).toThrow()
    expect(() => AiChatRenameSchema.parse({ title: 'x'.repeat(61) })).toThrow()
  })

  it('knows Gemini: a kind with a required key and a path-safe model name', () => {
    expect(AI_KINDS).toContain('gemini')
    expect(AI_KEY_REQUIRED.has('gemini')).toBe(true)
    expect(AI_KEY_REQUIRED.has('ollama')).toBe(false)
    expect(
      AiProviderInputSchema.parse({ name: 'G', kind: 'gemini', apiKey: 'k', model: 'gemini-2.5-pro' }).kind,
    ).toBe('gemini')
    for (const ok of ['gemini-2.5-pro', 'gemini-2.5-flash-lite', 'models.x_1'])
      expect(GEMINI_MODEL.test(ok)).toBe(true)
    for (const bad of ['', '.', '..', 'a/b', 'a?b', 'a#b', '%2e%2e', 'a b', 'x'.repeat(201), '../v1/files'])
      expect(GEMINI_MODEL.test(bad), bad).toBe(false)
  })
})
