// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  AI_DEFAULT_BASE_URL,
  AI_DEFAULT_MODEL,
  AI_KEY_REQUIRED,
  AI_LIMITS,
  GEMINI_MODEL,
  type AiKind,
  type AiProviderInput,
  type AiProviderPatch,
  type AiProviderView,
} from '@mongo-manager/shared'
import type { SecretBox } from '../crypto/secret-box'
import { Errors } from '../errors'
import { transaction } from '../store/db'

export const aiKeyContext = (id: string) => `ai-provider:${id}`

export type AiProviderRecord = Omit<AiProviderView, 'price'> & { createdAt: number; updatedAt: number }

interface Row {
  id: string
  name: string
  kind: AiKind
  base_url: string
  model: string
  api_key: string | null
  max_tokens: number
  samples: number
  enabled: number
  is_default: number
  last_local: number | null
  last_tested_at: number | null
  last_test: string | null
  created_by: string | null
  created_at: number
  updated_at: number
}

/** Spec §2.1: an http(s) address without credentials, query or fragment; no trailing slash. */
export function normaliseBaseUrl(text: string): string {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw Errors.validation('The address is not valid', { reason: 'bad_url' })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw Errors.validation('Only http:// and https:// addresses are allowed', { reason: 'bad_url' })
  if (url.username || url.password || url.search || url.hash)
    throw Errors.validation('The address may not carry credentials, a query or a fragment', {
      reason: 'bad_url',
    })
  return url.href.replace(/\/+$/, '')
}

/** Spec §2.7, C11: a Gemini model name is one plain path segment. */
function checkModel(kind: AiKind, model: string): void {
  if (kind === 'gemini' && !GEMINI_MODEL.test(model))
    throw Errors.validation('The model name may hold letters, digits, ".", "_" and "-" only', {
      reason: 'model_invalid',
    })
}

const keyRequired = () =>
  Errors.validation('Enter the key again: it belongs to the previous address', { reason: 'key_required' })

/** Phase 4a-1 spec §2.1, plan rulings 8 and 9. */
export class AiProviderRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  private toRecord(r: Row): AiProviderRecord {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      baseUrl: r.base_url,
      model: r.model,
      keyStored: r.api_key !== null,
      maxTokens: r.max_tokens,
      samples: r.samples === 1,
      enabled: r.enabled === 1,
      isDefault: r.is_default === 1,
      lastLocal: r.last_local === null ? null : r.last_local === 1,
      lastTestedAt: r.last_tested_at,
      lastTest: r.last_test,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id) as Row | undefined
  }

  list(): AiProviderRecord[] {
    return (
      this.db.prepare('SELECT * FROM ai_providers ORDER BY created_at, name').all() as unknown as Row[]
    ).map((r) => this.toRecord(r))
  }

  get(id: string): AiProviderRecord | undefined {
    const r = this.row(id)
    return r && this.toRecord(r)
  }

  /** The default provider, when it is enabled. */
  byDefault(): AiProviderRecord | undefined {
    return this.list().find((p) => p.isDefault && p.enabled)
  }

  /** The stored key, or null (none stored, or it cannot be opened with this server's key). */
  key(id: string): string | null {
    const r = this.row(id)
    if (!r?.api_key) return null
    try {
      return this.box.open(r.api_key, aiKeyContext(id))
    } catch {
      return null
    }
  }

  private sealed(id: string, key: string | null | undefined): string | null {
    return key ? this.box.seal(key, aiKeyContext(id)) : null
  }

  private unique<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      if (/UNIQUE/.test(String((e as Error).message)))
        throw Errors.conflict('A provider with this name already exists', { reason: 'name_taken' })
      throw e
    }
  }

  /** At most one default, never a disabled one; the oldest enabled provider when none is left. */
  private settleDefault(preferred: string | null): void {
    const list = this.list()
    const keep =
      (preferred && list.find((p) => p.id === preferred && p.enabled)) ||
      list.find((p) => p.isDefault && p.enabled) ||
      list.find((p) => p.enabled)
    this.db
      .prepare('UPDATE ai_providers SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END')
      .run(keep?.id ?? '')
  }

  create(input: AiProviderInput, createdBy: string | null): AiProviderRecord {
    if (this.list().length >= AI_LIMITS.providers)
      throw Errors.conflict(`At most ${AI_LIMITS.providers} providers`, { reason: 'too_many' })
    const baseUrl = normaliseBaseUrl(input.baseUrl ?? AI_DEFAULT_BASE_URL[input.kind])
    const model = input.model ?? (input.kind === 'anthropic' ? AI_DEFAULT_MODEL : undefined)
    if (!model) throw Errors.validation('Name the model to use', { reason: 'model_required' })
    checkModel(input.kind, model)
    if (AI_KEY_REQUIRED.has(input.kind) && !input.apiKey)
      throw Errors.validation('Enter the API key', { reason: 'key_required' })
    // Final review minor 11: as update refuses it.
    if (input.isDefault && !input.enabled)
      throw Errors.validation('A disabled provider cannot be the default', { reason: 'default_disabled' })
    const id = randomUUID()
    const t = this.now()
    transaction(this.db, () => {
      this.unique(() =>
        this.db
          .prepare(
            `INSERT INTO ai_providers (id, name, kind, base_url, model, api_key, max_tokens, samples, enabled,
               is_default, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(
            id,
            input.name,
            input.kind,
            baseUrl,
            model,
            this.sealed(id, input.apiKey),
            input.maxTokens,
            // Spec §2.1: samples off for a provider that may be a cloud, on for Ollama.
            (input.samples ?? input.kind === 'ollama') ? 1 : 0,
            input.enabled ? 1 : 0,
            createdBy,
            t,
            t,
          ),
      )
      this.settleDefault(input.isDefault ? id : null)
    })
    return this.get(id)!
  }

  update(id: string, patch: AiProviderPatch): AiProviderRecord {
    const row = this.row(id)
    if (!row) throw Errors.notFound('Provider not found')
    if (patch.isDefault && (patch.enabled === false || (patch.enabled === undefined && row.enabled === 0)))
      throw Errors.validation('A disabled provider cannot be the default', { reason: 'default_disabled' })
    const kind = patch.kind ?? row.kind
    checkModel(kind, patch.model ?? row.model)
    const baseUrl =
      patch.baseUrl !== undefined
        ? normaliseBaseUrl(patch.baseUrl)
        : patch.kind && patch.kind !== row.kind
          ? AI_DEFAULT_BASE_URL[kind]
          : row.base_url
    const moved = kind !== row.kind || baseUrl !== row.base_url
    let key: string | null
    if (patch.apiKey !== undefined) key = patch.apiKey
    else if (moved) key = null
    else key = this.key(id)
    if (moved && AI_KEY_REQUIRED.has(kind) && !key) throw keyRequired()
    // Final review minor 11: an Anthropic provider never loses its key (create requires one).
    if (AI_KEY_REQUIRED.has(kind) && !key)
      throw Errors.validation('This provider needs its API key', { reason: 'key_required' })
    transaction(this.db, () => {
      this.unique(() =>
        this.db
          .prepare(
            `UPDATE ai_providers SET name = ?, kind = ?, base_url = ?, model = ?, api_key = ?, max_tokens = ?,
               samples = ?, enabled = ?, last_local = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            patch.name ?? row.name,
            kind,
            baseUrl,
            patch.model ?? row.model,
            this.sealed(id, key),
            patch.maxTokens ?? row.max_tokens,
            (patch.samples ?? row.samples === 1) ? 1 : 0,
            (patch.enabled ?? row.enabled === 1) ? 1 : 0,
            moved ? null : row.last_local,
            this.now(),
            id,
          ),
      )
      this.settleDefault(patch.isDefault ? id : null)
    })
    return this.get(id)!
  }

  remove(id: string): boolean {
    return transaction(this.db, () => {
      const gone = this.db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id).changes > 0
      if (gone) this.settleDefault(null)
      return gone
    })
  }

  setTest(id: string, t: { outcome: string; local: boolean | null }): void {
    this.db
      .prepare(
        'UPDATE ai_providers SET last_test = ?, last_tested_at = ?, last_local = COALESCE(?, last_local) WHERE id = ?',
      )
      .run(t.outcome, this.now(), t.local === null ? null : t.local ? 1 : 0, id)
  }

  setLocal(id: string, local: boolean): void {
    this.db.prepare('UPDATE ai_providers SET last_local = ? WHERE id = ?').run(local ? 1 : 0, id)
  }
}
