import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { KeyPath, PresetBodySchema, type Preset, type PresetInput } from '@mongo-manager/shared'
import type { SecretBox } from '../crypto/secret-box'
import { Errors } from '../errors'

export const MAX_PRESETS = 200
export const MAX_PRESET_BYTES = 64 * 1024

interface Row {
  id: string
  owner: string
  kind: 'import' | 'export' | 'copy'
  name: string
  namespace: string | null
  body: string
  created_at: number
  updated_at: number
}

/** Sealing context: a sealed body copied to another row or owner no longer opens. */
export const presetContext = (id: string, owner: string) => `transfer-preset:${JSON.stringify([id, owner])}`
const context = presetContext
const nameTaken = () => Errors.conflict('Saved settings with this name exist', { reason: 'preset_name' })
const isUnique = (e: unknown) => String(e).includes('UNIQUE')

/**
 * A preset body without keys a request may no longer name: all of them, so the form falls back to
 * _id, never to some of a compound key, which would match more (eighteenth review, M-3).
 */
function withoutBadKeys(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.keys) || raw.keys.every((k) => KeyPath.safeParse(k).success)) return raw
  const { keys: _dropped, ...rest } = raw
  return rest
}

/** Spec §4.4: saved import and export settings, sealed, since a filter can hold personal data. */
export class TransferPresets {
  constructor(
    private readonly db: DatabaseSync,
    private readonly box: SecretBox,
    private readonly now: () => number,
  ) {}

  private toPreset(r: Row): Preset | null {
    try {
      const raw = JSON.parse(this.box.open(r.body, context(r.id, r.owner))) as Record<string, unknown>
      // Seventeenth review of explain masking (M-3): keys saved before an operator was refused in
      // them are dropped, not the whole preset (which could then be neither seen nor deleted).
      const parsed = PresetBodySchema.safeParse(raw)
      const body = parsed.success ? parsed.data : PresetBodySchema.parse(withoutBadKeys(raw))
      return {
        id: r.id,
        kind: r.kind,
        name: r.name,
        namespace: r.namespace,
        body,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }
    } catch {
      return null // A row that does not open is never shown.
    }
  }

  private seal(id: string, owner: string, input: PresetInput): string {
    const text = JSON.stringify(input.body)
    if (Buffer.byteLength(text) > MAX_PRESET_BYTES)
      throw Errors.validation('These settings are too large to save', { reason: 'preset_size' })
    return this.box.seal(text, context(id, owner))
  }

  private row(owner: string, id: string): Row {
    const row = this.db
      .prepare('SELECT * FROM transfer_presets WHERE id = ? AND owner = ?')
      .get(id, owner) as Row | undefined
    if (!row) throw Errors.notFound('Saved settings not found')
    return row
  }

  list(owner: string, kind?: 'import' | 'export' | 'copy'): Preset[] {
    const rows = (kind
      ? this.db
          .prepare('SELECT * FROM transfer_presets WHERE owner = ? AND kind = ? ORDER BY name COLLATE NOCASE')
          .all(owner, kind)
      : this.db
          .prepare('SELECT * FROM transfer_presets WHERE owner = ? ORDER BY name COLLATE NOCASE')
          .all(owner)) as unknown as Row[]
    return rows.map((r) => this.toPreset(r)).filter((p): p is Preset => p !== null)
  }

  create(owner: string, input: PresetInput): Preset {
    const count = (
      this.db.prepare('SELECT COUNT(*) AS n FROM transfer_presets WHERE owner = ?').get(owner) as {
        n: number
      }
    ).n
    if (count >= MAX_PRESETS)
      throw Errors.conflict(`You can keep at most ${MAX_PRESETS} saved settings`, { reason: 'preset_limit' })
    const id = randomUUID()
    const now = this.now()
    try {
      this.db
        .prepare(
          'INSERT INTO transfer_presets (id, owner, kind, name, namespace, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, owner, input.kind, input.name, input.namespace, this.seal(id, owner, input), now, now)
    } catch (e) {
      if (isUnique(e)) throw nameTaken()
      throw e
    }
    return { id, ...input, createdAt: now, updatedAt: now }
  }

  update(owner: string, id: string, input: PresetInput): Preset {
    const row = this.row(owner, id)
    const now = this.now()
    try {
      this.db
        .prepare(
          'UPDATE transfer_presets SET kind = ?, name = ?, namespace = ?, body = ?, updated_at = ? WHERE id = ? AND owner = ?',
        )
        .run(input.kind, input.name, input.namespace, this.seal(id, owner, input), now, id, owner)
    } catch (e) {
      if (isUnique(e)) throw nameTaken()
      throw e
    }
    return { id, ...input, createdAt: row.created_at, updatedAt: now }
  }

  delete(owner: string, id: string): void {
    this.row(owner, id)
    this.db.prepare('DELETE FROM transfer_presets WHERE id = ? AND owner = ?').run(id, owner)
  }

  deleteAllFor(owner: string): void {
    this.db.prepare('DELETE FROM transfer_presets WHERE owner = ?').run(owner)
  }
}
