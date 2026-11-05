// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Document } from 'mongodb'
import { MASK } from '../document'

const HIDDEN = { $literal: MASK }
/** An array element as an operator may see it: a document or an array becomes "***". */
const element = (v: string): Document => ({
  $cond: [{ $in: [{ $type: v }, ['object', 'array']] }, HIDDEN, v],
})

/**
 * Phase 3c §3.3: the value of `ref` when it is a scalar; a document becomes "***", an array keeps
 * its scalars and hides its documents and arrays. After it, no operator can reach a personal
 * value. Runs on MongoDB 6.0 and later.
 */
export function typeGuard(ref: string): Document {
  return {
    $switch: {
      branches: [
        { case: { $eq: [{ $type: ref }, 'object'] }, then: HIDDEN },
        {
          case: { $eq: [{ $type: ref }, 'array'] },
          then: { $map: { input: ref, as: 'mm_e', in: element('$$mm_e') } },
        },
      ],
      default: ref,
    },
  }
}

/** Any expression's value, guarded the same way (what $filter or $sortArray hand out). */
export const guardAny = (expr: unknown): Document => ({
  $let: { vars: { mm_v: expr }, in: typeGuard('$$mm_v') },
})
