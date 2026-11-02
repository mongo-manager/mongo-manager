import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { OPERATORS, SHELL_COMMANDS, SHELL_TYPES, SHOW_TARGETS } from '@mongo-manager/shared'

/**
 * Phase 3a-2 spec §3.1: the browser's static completion catalogue is generated from the installed
 * mongosh (shell-api signatures) and mongodb-constants. An upgrade that is not regenerated fails here.
 */
const script = join(import.meta.dirname, '..', 'scripts', 'gen-shell-catalogue.mjs')

describe('the static shell catalogue', () => {
  it('is up to date with the installed mongosh', () => {
    const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('knows the return types that chain completion follows', () => {
    expect(SHELL_TYPES.Collection!.find!.returnType).toBe('Cursor')
    expect(SHELL_TYPES.Collection!.aggregate!.returnType).toBe('AggregationCursor')
    expect(SHELL_TYPES.Database!.getCollection!.returnType).toBe('Collection')
    expect(SHELL_TYPES.Cursor!.limit!.returnType).toBe('Cursor')
  })

  it('lists the operators and the shell commands', () => {
    expect(OPERATORS.query).toContain('$in')
    expect(OPERATORS.stage).toContain('$match')
    expect(OPERATORS.expression).toContain('$add')
    expect(SHELL_COMMANDS).toEqual(['it', 'show', 'use'])
    expect(SHOW_TARGETS).toContain('collections')
  })
})
