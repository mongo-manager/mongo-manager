// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Phase 2a spec §4.2: the stage operators the builder offers, each with a starting template (the
 * stage's value as shell text) and its page in the MongoDB manual. Descriptions are in the web
 * app's locale files (aggregation.stageHelp.<operator without $>).
 */
export interface StageInfo {
  operator: string
  template: string
  docsUrl: string
  /** $out and $merge: never previewed, confirmed before they run. */
  write?: true
}

const MANUAL = 'https://www.mongodb.com/docs/manual/reference/operator/aggregation/'

const stage = (operator: string, template: string, write?: true): StageInfo => ({
  operator,
  template,
  docsUrl: `${MANUAL}${operator.slice(1).toLowerCase()}/`,
  ...(write ? { write } : {}),
})

export const STAGES: readonly StageInfo[] = [
  stage('$match', '{ field: "value" }'),
  stage('$project', '{ _id: 0, field: 1 }'),
  stage('$addFields', '{ newField: "$field" }'),
  stage('$set', '{ newField: "$field" }'),
  stage('$unset', '"field"'),
  stage('$group', '{ _id: "$field", count: { $sum: 1 } }'),
  stage('$sort', '{ field: -1 }'),
  stage('$limit', '10'),
  stage('$skip', '10'),
  stage('$unwind', '{ path: "$array", preserveNullAndEmptyArrays: false }'),
  stage('$lookup', '{ from: "collection", localField: "field", foreignField: "_id", as: "joined" }'),
  stage(
    '$graphLookup',
    '{ from: "collection", startWith: "$field", connectFromField: "field", connectToField: "_id", as: "graph" }',
  ),
  stage('$facet', '{ first: [{ $limit: 5 }], total: [{ $count: "n" }] }'),
  stage('$bucket', '{ groupBy: "$field", boundaries: [0, 100, 1000], default: "other" }'),
  stage('$bucketAuto', '{ groupBy: "$field", buckets: 5 }'),
  stage('$count', '"count"'),
  stage('$sortByCount', '"$field"'),
  stage('$replaceRoot', '{ newRoot: "$field" }'),
  stage('$replaceWith', '"$field"'),
  stage('$sample', '{ size: 100 }'),
  stage('$unionWith', '{ coll: "collection", pipeline: [] }'),
  stage('$densify', '{ field: "date", range: { step: 1, unit: "day", bounds: "full" } }'),
  stage('$fill', '{ sortBy: { date: 1 }, output: { value: { method: "linear" } } }'),
  stage(
    '$setWindowFields',
    '{ partitionBy: "$field", sortBy: { date: 1 }, output: { total: { $sum: "$value", window: { documents: ["unbounded", "current"] } } } }',
  ),
  stage('$out', '"collection"', true),
  stage('$merge', '{ into: "collection", whenMatched: "replace", whenNotMatched: "insert" }', true),
  stage('$geoNear', '{ near: { type: "Point", coordinates: [0, 0] }, distanceField: "distance" }'),
  stage('$search', '{ index: "default", text: { query: "word", path: "field" } }'),
  // W2 (2026-10-16): with the search indexes the Indexes tab now manages.
  stage(
    '$searchMeta',
    '{ index: "default", facet: { facets: { byField: { type: "string", path: "field" } } } }',
  ),
  stage(
    '$vectorSearch',
    '{ index: "vector_index", path: "embedding", queryVector: [0.1, 0.2, 0.3], numCandidates: 100, limit: 10 }',
  ),
]

const BY_OPERATOR = new Map(STAGES.map((s) => [s.operator, s]))

/** The starting value of a stage, as shell text; null for an operator the catalogue lacks. */
export function templateFor(operator: string): string | null {
  return BY_OPERATOR.get(operator)?.template ?? null
}
