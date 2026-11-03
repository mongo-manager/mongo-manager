import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type RmOptions,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sign } from 'node:crypto'
import {
  cleanIncoming,
  listVersions,
  pruneVersions,
  readLastUpdate,
  readUpdateState,
  readUpdateStateChecked,
  writeLastUpdate,
  verifyVersionDir,
  writeUpdateState,
  type UpdateState,
} from '../src/index'
import { makeVersionDir, testKey } from './versionFixture'

let appDir: string
const key = testKey()
const keys = [key.pub]

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), 'mm-app-'))
})
afterEach(() => rmSync(appDir, { recursive: true, force: true }))

const verify = (dir: string, kind: 'package' | 'standalone' = 'package', target?: string) =>
  verifyVersionDir(dir, { kind, target, keys })
const reason = (r: ReturnType<typeof verify>) => (r.ok ? 'ok' : r.reason)

describe('verifyVersionDir: a package', () => {
  it('accepts a signed, untouched folder and names its entry', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key)
    const r = verify(dir)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.version).toBe('1.2.0')
    expect(r.info.version).toBe('1.2.0')
    expect(r.entry).toBe(join(dir, 'package', 'dist', 'cli.cjs'))
  })

  it('refuses a changed byte of an extracted file', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key)
    writeFileSync(join(dir, 'package', 'dist', 'cli.cjs'), 'process.exit(1)\n')
    expect(reason(verify(dir))).toBe('files')
  })

  it('refuses an added file, in the package or beside it', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key)
    writeFileSync(join(dir, 'package', 'dist', 'extra.js'), 'x')
    expect(reason(verify(dir))).toBe('files')
    rmSync(join(dir, 'package', 'dist', 'extra.js'))
    expect(reason(verify(dir))).toBe('ok')
    writeFileSync(join(dir, 'notes.txt'), 'x')
    expect(reason(verify(dir))).toBe('files')
  })

  it('refuses a missing extracted file', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key)
    rmSync(join(dir, 'package', 'package.json'))
    expect(reason(verify(dir))).toBe('files')
  })

  it('refuses a swapped package.tgz', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key)
    const other = makeVersionDir(join(appDir, 'other'), '1.2.0', 'package', key, {
      files: { 'dist/cli.cjs': 'evil()' },
    })
    writeFileSync(join(dir, 'package.tgz'), readFileSync(join(other, 'package.tgz')))
    expect(reason(verify(dir))).toBe('digest')
  })

  it('refuses a signature by another key', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key)
    const sums = readFileSync(join(dir, 'SHA256SUMS'))
    writeFileSync(join(dir, 'SHA256SUMS.sig'), sign(null, sums, testKey().privateKey).toString('base64'))
    expect(reason(verify(dir))).toBe('signature')
  })

  it('refuses a release.json naming another version', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key, { infoVersion: '1.3.0' })
    expect(reason(verify(dir))).toBe('info')
  })

  it('refuses a folder with no signature or no sums', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key)
    rmSync(join(dir, 'SHA256SUMS.sig'))
    expect(reason(verify(dir))).toBe('missing')
    expect(reason(verify(join(appDir, '9.9.9')))).toBe('missing')
  })

  it('refuses a link inside the package', (ctx) => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key)
    rmSync(join(dir, 'package', 'package.json'))
    try {
      symlinkSync(join(appDir, 'elsewhere.json'), join(dir, 'package', 'package.json'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw e
    }
    writeFileSync(
      join(appDir, 'elsewhere.json'),
      JSON.stringify({ name: '@mongo-manager/app', version: '1.2.0' }),
    )
    expect(reason(verify(dir))).toBe('files')
  })

  it('refuses everything when no key is listed', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key)
    expect(verifyVersionDir(dir, { kind: 'package', keys: [] }).ok).toBe(false)
  })
})

describe('verifyVersionDir: what a file browser leaves (final review, minor)', () => {
  it('ignores .DS_Store, Thumbs.db and desktop.ini, anywhere, and nothing else', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'package', key)
    writeFileSync(join(dir, '.DS_Store'), 'x')
    writeFileSync(join(dir, 'package', 'dist', 'Thumbs.db'), 'x')
    writeFileSync(join(dir, 'package', 'desktop.ini'), 'x')
    expect(reason(verify(dir))).toBe('ok')
    writeFileSync(join(dir, 'package', 'dist', 'thumbs.js'), 'x')
    expect(reason(verify(dir))).toBe('files')
  })
})

describe('verifyVersionDir: a standalone binary', () => {
  it('accepts the binary of its target', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'standalone', key, { target: 'linux-x64' })
    const r = verify(dir, 'standalone', 'linux-x64')
    expect(r.ok && r.entry).toBe(join(dir, 'mongo-manager-1.2.0-linux-x64'))
  })

  it('refuses an extra file, a changed binary and another target', () => {
    const dir = makeVersionDir(appDir, '1.2.0', 'standalone', key, { target: 'win-x64' })
    expect(reason(verify(dir, 'standalone', 'win-x64'))).toBe('ok')
    expect(reason(verify(dir, 'standalone', 'linux-x64'))).toBe('missing')
    writeFileSync(join(dir, 'x.dll'), 'x')
    expect(reason(verify(dir, 'standalone', 'win-x64'))).toBe('files')
    rmSync(join(dir, 'x.dll'))
    writeFileSync(join(dir, 'mongo-manager-1.2.0-win-x64.exe'), 'other')
    expect(reason(verify(dir, 'standalone', 'win-x64'))).toBe('digest')
  })
})

describe('the folder of versions', () => {
  it('lists release folders newest first, nothing else', () => {
    for (const v of ['1.2.0', '1.10.0', '1.9.3']) mkdirSync(join(appDir, v))
    mkdirSync(join(appDir, '.incoming-ab12'))
    mkdirSync(join(appDir, 'v3.1.0'))
    writeFileSync(join(appDir, '3.0.0'), 'a file, not a folder')
    expect(listVersions(appDir)).toEqual(['1.10.0', '1.9.3', '1.2.0'])
    expect(listVersions(join(appDir, 'none'))).toEqual([])
  })

  it('removes the folders being staged, and only those', () => {
    mkdirSync(join(appDir, '.incoming-a1b2', 'package'), { recursive: true })
    mkdirSync(join(appDir, '1.1.0'))
    cleanIncoming(appDir)
    expect(readdirSync(appDir)).toEqual(['1.1.0'])
    cleanIncoming(join(appDir, 'none'))
  })

  it('prunes all but the kept versions', () => {
    for (const v of ['1.1.0', '1.2.0', '1.3.0']) mkdirSync(join(appDir, v))
    pruneVersions(appDir, ['1.3.0', '1.1.0'])
    expect(listVersions(appDir)).toEqual(['1.3.0', '1.1.0'])
  })

  it('skips a folder still in use and goes on (Windows: a running program)', () => {
    for (const v of ['1.1.0', '1.2.0', '1.3.0']) mkdirSync(join(appDir, v))
    const busy = (path: string, opts: RmOptions) => {
      if (path.endsWith('1.2.0')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      rmSync(path, opts)
    }
    expect(() => pruneVersions(appDir, ['1.3.0'], busy)).not.toThrow()
    expect(listVersions(appDir)).toEqual(['1.3.0', '1.2.0'])
  })
})

describe('state.json', () => {
  const state: UpdateState = {
    schema: 1,
    settled: '1.1.1',
    pending: { version: '1.1.2', from: '1.1.1', dbCopy: 'mongo-manager.db.before-1.1.2' },
    failed: ['1.1.3'],
  }
  const empty: UpdateState = { schema: 1, settled: null, pending: null, failed: [] }

  it('reads back what was written', () => {
    writeUpdateState(appDir, state)
    expect(readUpdateState(appDir)).toEqual(state)
  })

  // Final review (I7): a later server's field is kept through this launcher's own writes.
  it('keeps a field a later version wrote', () => {
    writeFileSync(join(appDir, 'state.json'), JSON.stringify({ ...state, later: { x: 1 } }))
    const read = readUpdateState(appDir)
    writeUpdateState(appDir, { ...read, failed: [] })
    expect(JSON.parse(readFileSync(join(appDir, 'state.json'), 'utf8')).later).toEqual({ x: 1 })
  })

  // Final review (minor): a state that is there but cannot be read is said so, unlike none.
  it('tells a damaged state from a missing one', () => {
    expect(readUpdateStateChecked(appDir).damaged).toBe(false)
    writeFileSync(join(appDir, 'state.json'), '{"schema":1,"sett')
    expect(readUpdateStateChecked(appDir)).toEqual({ state: empty, damaged: true })
  })

  it('reads a missing, cut or foreign state as empty', () => {
    expect(readUpdateState(appDir)).toEqual(empty)
    writeUpdateState(appDir, state)
    const text = readFileSync(join(appDir, 'state.json'), 'utf8')
    writeFileSync(join(appDir, 'state.json'), text.slice(0, 20))
    expect(readUpdateState(appDir)).toEqual(empty)
    writeFileSync(
      join(appDir, 'state.json'),
      JSON.stringify({ ...state, pending: { ...state.pending, dbCopy: '../x' } }),
    )
    expect(readUpdateState(appDir)).toEqual(empty)
  })

  it('keeps the last whole state when a write was cut before its rename', () => {
    writeUpdateState(appDir, state)
    writeFileSync(join(appDir, 'state.json.tmp-0123456789abcdef'), '{"schema":1,"sett')
    expect(readUpdateState(appDir)).toEqual(state)
    writeUpdateState(appDir, empty)
    expect(readUpdateState(appDir)).toEqual(empty)
  })

  it('creates the folder, and leaves no temporary file behind', () => {
    const dir = join(appDir, 'app')
    writeUpdateState(dir, state)
    expect(readdirSync(dir)).toEqual(['state.json'])
    expect(existsSync(join(dir, 'state.json'))).toBe(true)
  })
})

describe('last-update.json', () => {
  it('reads back how the last update ended, and nothing from a foreign file', () => {
    expect(readLastUpdate(appDir)).toBeNull()
    writeLastUpdate(appDir, {
      version: '1.3.0',
      outcome: 'refused',
      code: 'files',
      reason: 'its files do not match',
      at: 6,
    })
    expect(readLastUpdate(appDir)).toMatchObject({ outcome: 'refused', code: 'files' })
    writeLastUpdate(appDir, {
      version: '1.2.0',
      outcome: 'rolled_back',
      reason: 'it stopped with code 1',
      at: 5,
    })
    expect(readLastUpdate(appDir)).toEqual({
      version: '1.2.0',
      outcome: 'rolled_back',
      reason: 'it stopped with code 1',
      at: 5,
    })
    writeFileSync(
      join(appDir, 'last-update.json'),
      JSON.stringify({ version: '1.2', outcome: 'updated', at: 1 }),
    )
    expect(readLastUpdate(appDir)).toBeNull()
  })
})
