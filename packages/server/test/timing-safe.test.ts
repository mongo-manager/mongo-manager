// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { safeEqual } from '../src/http/security'

const SRC = join(import.meta.dirname, '..', 'src')
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const path = join(dir, f)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })

/** Names of values an attacker must not learn a byte of by timing a comparison (S3). */
const SECRET =
  /(csrf|token|secret|recovery|apikey|password|passphrase|mac\b|hmac|hash|digest|otp|sid\b|challenge|sha\d*\b|sha256|md5|checksum)/i

/**
 * Comparisons that name a secret-looking value but compare nothing secret. Each entry is the file
 * and the exact expression, with the reason it is safe.
 */
const ALLOWED = new Map<string, string>([
  // The claims were already verified in constant time (readPreview); this digest is of the caller's own body.
  ['routes/data/bulk.ts: claims.r !== requestDigest(body)', 'digest of the request body, not a secret'],
  [
    'routes/data/aggregate.ts: claims.r !== digest(stages)',
    'digest of the pipeline inside an HMAC-verified token, not a secret',
  ],
  [
    'routes/destinations.ts: r.secretFields.includes(f)',
    'the names of the stored secret fields (phase 3d-3b DTO), never their values',
  ],
  [
    'transfer/same-deployment.ts: a.processId === b.processId',
    "a server process's id from hello (phase 3d-2 same-deployment check), not a secret",
  ],
])

/** Operands that make a comparison about presence or type, never about a secret's content. */
function harmless(node: ts.Expression): boolean {
  return (
    ts.isLiteralExpression(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined') ||
    ts.isTypeOfExpression(node) ||
    (ts.isPropertyAccessExpression(node) && node.name.text === 'length') ||
    ts.isPrefixUnaryExpression(node)
  )
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

/** Every non-constant-time comparison of a secret-looking value in a source text. */
export function findSecretComparisons(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const report = (node: ts.Node) => {
    const expr = node.getText(source).replace(/\s+/g, ' ')
    if (!ALLOWED.has(`${file}: ${expr}`)) found.push(`${file}: ${expr}`)
  }
  const secret = (node: ts.Node) => SECRET.test(node.getText(source))
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      if (!harmless(node.left) && !harmless(node.right) && (secret(node.left) || secret(node.right)))
        report(node)
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['includes', 'equals', 'indexOf', 'startsWith', 'endsWith'].includes(node.expression.name.text) &&
      node.arguments.length > 0 &&
      !harmless(node.arguments[0]!) &&
      (secret(node.expression.expression) || secret(node.arguments[0]!))
    ) {
      report(node)
    } else if (ts.isSwitchStatement(node) && secret(node.expression)) {
      report(node.expression)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('secrets are compared in constant time (S3)', () => {
  it('safeEqual is right for equal, different and differently long values', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('şifre', 'şifre')).toBe(true)
    expect(safeEqual('şifre', 'sifre')).toBe(false)
  })

  it('finds the shapes a line check missed (final review 1g-3, Important 3)', () => {
    const shapes = [
      "if (typeof token !== 'string' || token !== principal.csrfToken) deny()",
      'const ok = header.slice(7) === opts.token',
      'const ok =\n  mac ===\n  expected',
      'if (a.csrfToken == b) x()',
      'if (tokens.includes(candidate)) x()',
      'if (expectedMac.equals(mac)) x()',
      'switch (request.token) { default: }',
      // Phase 3d-3b final review B22: digests a provider or a file must match.
      'if (sha && sha !== row.sha256) x()',
      'if (md !== md5) x()',
      'if (got.checksum === expected) x()',
    ]
    for (const shape of shapes) expect(findSecretComparisons('x.ts', shape), shape).toHaveLength(1)
    for (const fine of [
      "if (typeof token !== 'string') x()",
      'if (token === null) x()',
      "if (e.code === 'X') x()",
      'if (tokens.length === 0) x()',
    ])
      expect(findSecretComparisons('x.ts', fine), fine).toEqual([])
  })

  it('no source file compares a secret with ===, ==, includes, equals or switch', () => {
    const found = files(SRC).flatMap((f) =>
      findSecretComparisons(relative(SRC, f).split(sep).join('/'), readFileSync(f, 'utf8')),
    )
    expect(found).toEqual([])
  })
})
