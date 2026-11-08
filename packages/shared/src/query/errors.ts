// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
export class QueryParseError extends Error {
  readonly code = 'QUERY_PARSE_ERROR' as const

  constructor(
    message: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(message)
    this.name = 'QueryParseError'
  }
}

export function lineColumn(src: string, offset: number): { line: number; column: number } {
  let line = 1
  let column = 1
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') {
      line++
      column = 1
    } else {
      column++
    }
  }
  return { line, column }
}

export function errorAt(src: string, offset: number, message: string): QueryParseError {
  const clamped = Math.max(0, Math.min(offset, src.length))
  const { line, column } = lineColumn(src, clamped)
  return new QueryParseError(message, clamped, line, column)
}
