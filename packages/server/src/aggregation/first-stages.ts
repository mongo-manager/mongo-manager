// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Stages MongoDB accepts only in first place: a preview's sample goes after them (final review 2a,
 * I3), and the gate's order leaves them theirs.
 */
export const FIRST_STAGES: ReadonlySet<string> = new Set([
  '$geoNear',
  '$search',
  '$searchMeta',
  '$vectorSearch',
  '$collStats',
  '$indexStats',
  '$documents',
  '$listSearchIndexes',
  '$planCacheStats',
  '$listSampledQueries',
  // It lists the catalog, not the collection's documents: a sample before it is refused.
  '$listCatalog',
  '$listClusterCatalog',
  '$shardedDataDistribution',
  '$rankFusion',
  '$scoreFusion',
])
