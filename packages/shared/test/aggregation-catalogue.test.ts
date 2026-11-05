// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { STAGES, parseShellExpression, stageOperator, templateFor } from '../src'

describe('the stage catalogue (phase 2a spec §4.2)', () => {
  it('lists the operators of the spec and the search stages of W2, once each', () => {
    const operators = STAGES.map((s) => s.operator)
    expect(new Set(operators).size).toBe(operators.length)
    expect(operators).toEqual(
      [
        '$match',
        '$project',
        '$addFields',
        '$set',
        '$unset',
        '$group',
        '$sort',
        '$limit',
        '$skip',
        '$unwind',
        '$lookup',
        '$graphLookup',
        '$facet',
        '$bucket',
        '$bucketAuto',
        '$count',
        '$sortByCount',
        '$replaceRoot',
        '$replaceWith',
        '$sample',
        '$unionWith',
        '$densify',
        '$fill',
        '$setWindowFields',
        '$out',
        '$merge',
        '$geoNear',
        '$search',
        '$searchMeta',
        '$vectorSearch',
      ].filter((op) => operators.includes(op)),
    )
    expect(operators).toHaveLength(30)
  })

  it('gives every operator a template that parses, as the value of that stage', () => {
    for (const stage of STAGES) {
      const value = parseShellExpression(stage.template)
      expect(stageOperator({ [stage.operator]: value }), stage.operator).toBe(stage.operator)
      expect(templateFor(stage.operator)).toBe(stage.template)
    }
    expect(templateFor('$nope')).toBeNull()
  })

  it('links each operator to its page in the MongoDB manual, and marks the write stages', () => {
    for (const stage of STAGES) {
      expect(stage.docsUrl).toBe(
        `https://www.mongodb.com/docs/manual/reference/operator/aggregation/${stage.operator.slice(1).toLowerCase()}/`,
      )
    }
    expect(STAGES.filter((s) => s.write).map((s) => s.operator)).toEqual(['$out', '$merge'])
  })
})
