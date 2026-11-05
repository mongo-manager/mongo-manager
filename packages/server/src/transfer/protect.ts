// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { ImportRequest } from '@mongo-manager/shared'
import { newCtx, type GateDeps } from '../masking/gate/context'
import { sourceShape } from '../masking/gate/pipeline'
import { personalField, personalWrite } from '../masking/gate'
import { touchesPersonal } from '../masking/gate/write'

const split = (p: string) => p.split('.')

/**
 * Phase 3d-1 §8.2: what a restricted caller's import may write, checked before the job starts. Mapped
 * paths and constants may not be personal; keys may not even hold personal data (they are queried);
 * an upsert (a full replace) is refused where rules apply, since it would remove stored personal values.
 */
export async function checkImportPlan(
  db: string,
  coll: string,
  plan: { paths: string[]; keys: string[]; mode: ImportRequest['mode'] },
  gate: GateDeps,
): Promise<void> {
  const shape = await sourceShape(db, coll, newCtx(gate, db))
  for (const p of plan.paths) if (touchesPersonal(split(p), shape)) throw personalWrite(p, shape.ns)
  for (const k of plan.keys)
    if (touchesPersonal(split(k), shape) || shape.mayHold(split(k))) throw personalField(k, shape.ns)
  if (plan.mode === 'upsert' && shape.any) throw personalWrite('the whole document (upsert)', shape.ns)
}
