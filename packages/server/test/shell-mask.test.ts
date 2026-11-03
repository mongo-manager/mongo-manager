import { describe, expect, it } from 'vitest'
import { maskCode } from '../src/shell/mask'

describe('audit masking of shell code (phase 3a-1 §8)', () => {
  it('masks passwords, tokens, credentialed URIs and long opaque strings', () => {
    expect(maskCode("db.auth('u', 'secret123')")).not.toContain('secret123')
    expect(maskCode('const password = "hunter2"')).not.toContain('hunter2')
    expect(maskCode("connect('mongodb://user:p4ssw0rd@host/db')")).not.toContain('p4ssw0rd')
    expect(maskCode('x = "deadbeefdeadbeefdeadbeefdeadbeef12345678"')).toContain('***')
  })

  // Security review 2026-10-13 (low): a password given by position, or in backquotes, reached the
  // audit log as typed.
  it('masks passwords given by position and in backquotes', () => {
    expect(maskCode("db.changeUserPassword('ada', 'n3w-Secret')")).toBe("db.changeUserPassword('ada', '***')")
    expect(maskCode('db.changeUserPassword("ada", `n3w-Secret`)')).not.toContain('n3w-Secret')
    expect(maskCode("db.auth('ada', `hunter22`)")).not.toContain('hunter22')
    expect(maskCode('db.createUser({ user: "ada", pwd: `hunter22`, roles: [] })')).not.toContain('hunter22')
    expect(maskCode("db.getSiblingDB('admin').auth( 'ada' , 'hunter22' )")).not.toContain('hunter22')
    // The user named by a variable (review, minor 7).
    expect(maskCode("db.changeUserPassword(u, 'S3cret-pass')")).toBe("db.changeUserPassword(u, '***')")
    expect(maskCode("db.auth(name, 'S3cret-pass')")).not.toContain('S3cret-pass')
    expect(maskCode('db.auth(users[0].name, `S3cret-pass`)')).not.toContain('S3cret-pass')
    // A password only one argument along is not masked when the call is not a sign-in.
    expect(maskCode("db.users.find({ name: 'ada' }, 'name')")).toBe("db.users.find({ name: 'ada' }, 'name')")
  })

  it('leaves ordinary code intact', () => {
    expect(maskCode('db.orders.find({ total: { $gt: 100 } })')).toBe(
      'db.orders.find({ total: { $gt: 100 } })',
    )
    expect(maskCode('const n = 42')).toBe('const n = 42')
  })
})
