import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { looseParentOn, serviceMayChangeOn, walkPath } from '../../src/service/sandbox'
import { realSys } from '../../src/service/sys'
import { cleanTempDirs, tempDir } from '../support'

afterEach(cleanTempDirs)

// Whole-branch re-review (important 1): the walk on a real file system, as the kernel walks it.
describe.skipIf(process.platform === 'win32')('walking a folder root on a real file system', () => {
  const sys = realSys()

  it('follows a link in a link, and gives the folder each one is in', () => {
    const dir = realpathSync(tempDir())
    mkdirSync(join(dir, 'outer'))
    mkdirSync(join(dir, 'app'))
    symlinkSync(join(dir, 'app'), join(dir, 'outer', 'daily'))
    symlinkSync(join(dir, 'outer', 'daily'), join(dir, 'daily'))
    const walk = walkPath(join(dir, 'daily'), sys)
    expect(walk.real).toBe(join(dir, 'app'))
    expect(walk.hops.map((h) => h.at)).toEqual([join(dir, 'daily'), join(dir, 'outer', 'daily')])
    expect(walk.dangling).toBeUndefined()
  })

  it("follows relative links from each one's own folder", () => {
    const dir = realpathSync(tempDir())
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    mkdirSync(join(dir, 'app'))
    symlinkSync('a/b/inner', join(dir, 'rel'))
    symlinkSync('../../app', join(dir, 'a', 'b', 'inner'))
    const walk = walkPath(join(dir, 'rel'), sys)
    expect(walk.real).toBe(join(dir, 'app'))
    expect(walk.hops.map((h) => h.at)).toEqual([join(dir, 'rel'), join(dir, 'a', 'b', 'inner')])
  })

  it("gives a link's own owner, not its target's", () => {
    const dir = realpathSync(tempDir())
    symlinkSync('/', join(dir, 'to-root'))
    const walk = walkPath(join(dir, 'to-root'), sys)
    expect(walk.real).toBe('/')
    expect(walk.hops[0]!.owner.uid).toBe(process.getuid!())
    expect((walk.hops[0]!.owner.mode & 0o170000) === 0o120000).toBe(true)
  })

  it('says which link leads nowhere: to a folder not there, or round in a loop', () => {
    const dir = realpathSync(tempDir())
    symlinkSync(join(dir, 'missing', 'deeper'), join(dir, 'later'))
    expect(walkPath(join(dir, 'later', 'x'), sys).dangling).toBe(join(dir, 'later'))
    symlinkSync(join(dir, 'loop'), join(dir, 'loop'))
    expect(walkPath(join(dir, 'loop'), sys)).toMatchObject({ dangling: join(dir, 'loop'), why: 'loop' })
    // The same link met again with less of the way left is no loop: a long way, refused as that.
    mkdirSync(join(dir, 'd'))
    symlinkSync('.', join(dir, 'd', 'here'))
    expect(walkPath(join(dir, 'd', ...Array(41).fill('here')), sys).tooMany).toBe(join(dir, 'd', 'here'))
  })

  it("takes '..' past / as /, and a link through /proc/self as the kernel does", () => {
    const dir = realpathSync(tempDir())
    symlinkSync('../../../../../../../../../srv', join(dir, 'up'))
    expect(walkPath(join(dir, 'up'), sys).real).toBe('/srv')
    symlinkSync('/proc/self/root/etc', join(dir, 'etc'))
    expect(walkPath(join(dir, 'etc'), sys).real).toBe('/etc')
  })

  it('follows 40 links, and gives up at the 41st, naming the first', () => {
    const dir = realpathSync(tempDir())
    mkdirSync(join(dir, 'ok'))
    for (let i = 0; i < 41; i++)
      symlinkSync(i === 40 ? join(dir, 'ok') : join(dir, `l${i + 1}`), join(dir, `l${i}`))
    expect(walkPath(join(dir, 'l1'), sys).real).toBe(join(dir, 'ok'))
    expect(walkPath(join(dir, 'l0'), sys).tooMany).toBe(join(dir, 'l0'))
  })

  it('goes no further than a file on the way', () => {
    const dir = realpathSync(tempDir())
    mkdirSync(join(dir, 'ok'))
    writeFileSync(join(dir, 'file'), '')
    // Not join, which takes the '..' as text: through the file it would lead to ok, which is there.
    symlinkSync(`${join(dir, 'file')}/../ok`, join(dir, 'via'))
    expect(walkPath(join(dir, 'via'), sys).dangling).toBe(join(dir, 'via'))
  })

  // Whole-branch re-re-review (important 1): the swap after the walk, on a real file system.
  it('finds a folder on the way that turned into a link after the walk', () => {
    const dir = realpathSync(tempDir())
    mkdirSync(join(dir, 'svcdir', 'backups'), { recursive: true })
    mkdirSync(join(dir, 'other', 'backups'), { recursive: true })
    const walk = walkPath(join(dir, 'svcdir', 'backups'), sys)
    renameSync(join(dir, 'svcdir'), join(dir, 'was'))
    symlinkSync(join(dir, 'other'), join(dir, 'svcdir'))
    const account = { uid: 4242, groups: [] }
    expect(serviceMayChangeOn(walk, sys, account)).toEqual({
      dir: join(dir, 'svcdir'),
      why: "is a link now, put in a folder's place while the folder root was judged",
      changed: true,
    })
    expect(looseParentOn(walk, sys)?.dir).toBe(join(dir, 'svcdir'))
  })

  it('takes a root not made yet as its nearest folder and the rest as written', () => {
    const dir = realpathSync(tempDir())
    mkdirSync(join(dir, 'there'))
    symlinkSync(join(dir, 'there'), join(dir, 'link'))
    const walk = walkPath(join(dir, 'link', 'not', 'yet'), sys)
    expect(walk.real).toBe(join(dir, 'there', 'not', 'yet'))
    expect(walk.dangling).toBeUndefined()
  })
})
