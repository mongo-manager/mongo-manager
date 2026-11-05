// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { GEMINI_MODEL, type AiKind, type AiModel } from '@mongo-manager/shared'
import type { Egress } from '../net/egress'
import { ProviderError, reasonOfStatus } from './wire'

/**
 * User review 2026-10-09 ("yapay zeka sağlayıcılarına model seçimi ekle"): the models a provider
 * offers, read from its own list — OpenAI-compatible /models, Anthropic /v1/models, Gemini's models
 * that write text, Ollama's local tags. Only names leave: never the key, never the provider's words.
 */
const MAX_MODELS = 500
/** No control character (a name or label is shown, and a name is sent back as a model). */
const printable = (s: string) => [...s].every((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f)
/** A name that can be shown and sent back as a model: printable, no spaces, bounded. */
const NAME = { test: (s: string) => s.length >= 1 && s.length <= 200 && printable(s) && !/\s/.test(s) }
const LABEL = { test: (s: string) => s.length >= 1 && s.length <= 200 && printable(s) }
/** The list is small; anything larger is not a model list. */
const LIST_LIMIT = 2 * 1024 * 1024

export function modelsRequest(
  kind: AiKind,
  baseUrl: string,
  apiKey: string | null,
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { accept: 'application/json' }
  switch (kind) {
    case 'anthropic':
      if (apiKey) headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      return { url: `${baseUrl}/v1/models?limit=1000`, headers }
    case 'openai':
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      return { url: `${baseUrl}/models`, headers }
    case 'ollama':
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      return { url: `${baseUrl}/api/tags`, headers }
    case 'gemini':
      // The key travels in its header only, never in the URL.
      if (apiKey) headers['x-goog-api-key'] = apiKey
      return { url: `${baseUrl}/v1beta/models?pageSize=1000`, headers }
  }
}

const text = (v: unknown, re: { test(s: string): boolean }): string | null =>
  typeof v === 'string' && re.test(v) ? v : null
const items = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The models in a provider's answer, as names it can be asked for (and a label when it gives one). */
export function parseModels(kind: AiKind, body: unknown): AiModel[] {
  const root = (body ?? {}) as Record<string, unknown>
  const found: AiModel[] = []
  const add = (id: string | null, label: string | null) => {
    if (id) found.push(label && label !== id ? { id, label } : { id })
  }
  switch (kind) {
    case 'anthropic':
      for (const m of items(root.data)) {
        const o = (m ?? {}) as Record<string, unknown>
        add(text(o.id, NAME), text(o.display_name, LABEL))
      }
      break
    case 'openai':
      for (const m of items(root.data)) add(text(((m ?? {}) as Record<string, unknown>).id, NAME), null)
      break
    case 'ollama':
      for (const m of items(root.models)) add(text(((m ?? {}) as Record<string, unknown>).name, NAME), null)
      break
    case 'gemini':
      for (const m of items(root.models)) {
        const o = (m ?? {}) as Record<string, unknown>
        // Only the models that write text (generateContent), named as a request names them.
        const methods = items(o.supportedGenerationMethods)
        if (!methods.includes('generateContent')) continue
        const name = text(o.name, NAME)?.replace(/^models\//, '') ?? null
        add(name && GEMINI_MODEL.test(name) ? name : null, text(o.displayName, LABEL))
      }
      break
  }
  const unique = new Map(found.map((m) => [m.id, m]))
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_MODELS)
}

export async function listModels(
  egress: Egress,
  target: { kind: AiKind; baseUrl: string; apiKey: string | null },
  deadlineMs: number,
): Promise<AiModel[]> {
  const { url, headers } = modelsRequest(target.kind, target.baseUrl, target.apiKey)
  const r = await egress.buffer({ method: 'GET', url, headers, deadlineMs, privateOnly: false }, LIST_LIMIT)
  const raw = r.body.toString('utf8')
  if (r.status < 200 || r.status >= 300)
    throw new ProviderError(reasonOfStatus(r.status, raw), `The provider answered ${r.status}`)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ProviderError('provider_error', 'The provider’s list is not JSON')
  }
  return parseModels(target.kind, body)
}
