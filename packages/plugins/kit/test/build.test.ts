import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { bsonWithoutWasm, withoutWasm } from '../tooling/bsonWithoutWasm'

// User report 2026-10-11: the SQL plugin's scan said "1 to review" — bson's Long tries a small
// WebAssembly module, which the frame's policy never lets run. Built without it, nothing changes
// but the scan.
const bsonMjs = join(
  dirname(createRequire(join(__dirname, '..', '..', '..', 'shared', 'package.json')).resolve('bson')),
  'bson.mjs',
)

describe('bson built without its WebAssembly helper', () => {
  it('leaves the helper undefined, as the frame always had it', () => {
    const source = readFileSync(bsonMjs, 'utf8')
    expect(source).toContain('new WebAssembly.Module(')
    const out = withoutWasm(source, bsonMjs)
    expect(out).not.toContain('WebAssembly')
    expect(out).toContain('wasm = undefined;')
    // Only that expression: the rest of bson is as it was.
    expect(out.length).toBeGreaterThan(source.length - 2000)
  })

  it('stops the build when bson no longer has the form it removes', () => {
    expect(() => withoutWasm('export const Long = 1', '/x/node_modules/bson/lib/bson.mjs')).toThrow(/bson/)
  })

  it('touches no other module', () => {
    const plugin = bsonWithoutWasm()
    const transform = (code: string, id: string) => plugin.transform(code, id)
    expect(transform('new WebAssembly.Module(x)', '/src/main.ts')).toBeNull()
    expect(transform(readFileSync(bsonMjs, 'utf8'), bsonMjs)).not.toContain('WebAssembly')
  })
})
