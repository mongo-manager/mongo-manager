import type { DatabaseSync } from 'node:sqlite'
import type { SecretBox } from '../crypto/secret-box'
import type { PipelineAssistant } from '@mongo-manager/shared'
import { SealedItemRepo, type SealedItemKey, type SealedItemRow } from '../queries/sealed-items'

/** Per owner and collection (spec §3.2). */
export const MAX_SAVED_PER_NAMESPACE = 200
/** The stored pipeline text (canonical EJSON). */
export const MAX_SAVED_BYTES = 256 * 1024

export type SavedPipelineKey = SealedItemKey
export type SavedPipelineRow = SealedItemRow & { assistant?: PipelineAssistant }

/** Sealing context: a sealed pipeline copied to another row or collection no longer opens. */
export const savedContext = (r: SavedPipelineKey) =>
  `pipeline:${JSON.stringify([r.id, r.connection_id, r.db, r.coll])}`

/**
 * Phase 2a: pipelines saved per collection. The pipeline can hold personal data (filter values),
 * so it is sealed with the secret key and re-sealed by rotate-key; its name and tags are kept in
 * the clear, as collection names are in the audit log.
 */
export class SavedPipelineRepo extends SealedItemRepo {
  constructor(db: DatabaseSync, box: SecretBox, now: () => number) {
    super(db, box, now, { table: 'saved_pipelines', column: 'pipeline', context: savedContext })
  }

  override get(id: string): SavedPipelineRow | null {
    const row = super.get(id)
    return row ? unpack(row) : null
  }

  override list(filter: Parameters<SealedItemRepo['list']>[0]): SavedPipelineRow[] {
    return super.list(filter).map(unpack)
  }
}

/**
 * UI redesign R1 review: the sealed content is the pipeline (its stages, as before) or, with the
 * assistant's steps, `{ stages, assistant }`. Rows are given out with the stages as their text, so
 * everything that reads a saved pipeline (the library, rotate-key) sees what it always saw.
 */
function unpack(row: SealedItemRow): SavedPipelineRow {
  if (!row.text.startsWith('{')) return row
  try {
    const value = JSON.parse(row.text) as { stages?: unknown; assistant?: PipelineAssistant }
    if (!Array.isArray(value.stages)) return row
    return {
      ...row,
      text: JSON.stringify(value.stages),
      ...(value.assistant ? { assistant: value.assistant } : {}),
    }
  } catch {
    return row
  }
}

/** The content to seal: the stages alone, or with the assistant's steps. */
export function packPipeline(stagesText: string, assistant: PipelineAssistant | undefined): string {
  return assistant?.steps.length
    ? `{"stages":${stagesText},"assistant":${JSON.stringify(assistant)}}`
    : stagesText
}
