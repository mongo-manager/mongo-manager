import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRegularFile } from '../src/open-regular'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mm-open-'))
  dirs.push(d)
  return d
}

// CodeQL 2026-11-01 (file-system-race): a stored file is opened first and checked after, so no
// link can be swapped in between a check and the open.
describe('opening a stored file', () => {
  it('opens a regular file and reads it', async () => {
    const d = temp()
    writeFileSync(join(d, 'a'), 'hello')
    const h = (await openRegularFile(join(d, 'a')))!
    try {
      expect((await h.readFile()).toString()).toBe('hello')
    } finally {
      await h.close()
    }
  })

  it('gives nothing for a missing file or a folder', async () => {
    const d = temp()
    mkdirSync(join(d, 'folder'))
    expect(await openRegularFile(join(d, 'missing'))).toBeNull()
    expect(await openRegularFile(join(d, 'folder'))).toBeNull()
  })

  // Abuse case: a link to another file (the server's key, say) in a stored file's place.
  it('never follows a link in its place', async () => {
    const d = temp()
    writeFileSync(join(d, 'secret.key'), 'SECRET')
    try {
      symlinkSync(join(d, 'secret.key'), join(d, 'stored'), 'file')
    } catch (e) {
      // Windows without the right to make file links: a link cannot be planted here either.
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return
      throw e
    }
    expect(await openRegularFile(join(d, 'stored'))).toBeNull()
  })
})
