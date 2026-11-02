import type { PartialConfig } from '../../src/config'
import type { TestMongo } from './mongo'
import { transferHarness } from './transfer2'

/**
 * Phase 3d-3a: the 3d-2 harness (connections A, B and A2; users with roles, grants and the masked
 * flag; `call`, `get` and `raw`), under the name the backup tests use.
 */
export const backupHarness = (
  a: TestMongo,
  b: TestMongo,
  overrides: PartialConfig = {},
  extra: Parameters<typeof transferHarness>[3] = {},
) => transferHarness(a, b, overrides, extra)
