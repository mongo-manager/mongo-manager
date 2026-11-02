import { describe, expect, it } from 'vitest'
import { aclSids, prepareStateRoot } from '../../src/service/acl'
import { fakeSys } from './fake-sys'

/** The decoded script and its JSON input, as the fake records them. */
const split = (line: string) => {
  const at = line.lastIndexOf(' INPUT=')
  return { script: line.slice(0, at), input: JSON.parse(line.slice(at + ' INPUT='.length)) }
}
const HOSTILE = "C:\\ProgramData\\Mongo Manager'; Remove-Item C:\\ -Recurse; $(calc)"

describe('Windows ACLs (Review Focus 3; second review Y1, Y2)', () => {
  it('create the state folder with its final security in one step, the path only as data', () => {
    const sys = fakeSys('win32')
    prepareStateRoot(sys, HOSTILE, [`${HOSTILE}\\data`, `${HOSTILE}\\logs`])
    const { script, input } = split(sys.commands[0]!)
    expect(input).toEqual({ root: HOSTILE, writable: [`${HOSTILE}\\data`, `${HOSTILE}\\logs`] })
    expect(script).not.toContain('Remove-Item')
    // A fresh, protected ACL: owner Administrators; SYSTEM and Administrators full; LocalService read only.
    expect(script).toMatch(/SetOwner\(\(& \$sidOf 'S-1-5-32-544'\)\)/)
    expect(script).toMatch(/SetAccessRuleProtection\(\$true, \$false\)/)
    expect(script).toMatch(
      /@\('S-1-5-18', 'FullControl'\), @\('S-1-5-32-544', 'FullControl'\), @\('S-1-5-19', 'ReadAndExecute'\)/,
    )
    expect(script).toMatch(/\[System\.IO\.Directory\]::CreateDirectory\(\$root, \$sec\)/)
    // Everything already inside is checked again after the folder is locked.
    expect(script.indexOf('Set-Acl -LiteralPath $root')).toBeLessThan(script.lastIndexOf('& $scan'))
    expect(script).toMatch(/'S-1-5-19'\), 'Modify'/)
    expect(script).toMatch(/\$ErrorActionPreference = 'Stop'/)
  })

  it('fails closed when the script does not finish', () => {
    const sys = fakeSys('win32')
    sys.responses.push({ match: /mm:prepare/, status: 1 })
    expect(() => prepareStateRoot(sys, 'C:\\ProgramData\\Mongo Manager', [])).toThrow(/cannot be used/)
  })

  it('reads SIDs with the path only as data', () => {
    const sys = fakeSys('win32')
    sys.responses.push({ match: /mm:acl-sids/, status: 0, stdout: 'S-1-5-18\r\nS-1-5-32-545\r\n' })
    expect(aclSids(sys, HOSTILE)).toEqual(['S-1-5-18', 'S-1-5-32-545'])
    const { script, input } = split(sys.commands[0]!)
    expect(input).toEqual({ path: HOSTILE })
    expect(script).not.toContain('Remove-Item')
    sys.responses.unshift({ match: /mm:acl-sids/, status: 1 })
    expect(aclSids(sys, HOSTILE)).toBeNull()
  })
})

describe.skipIf(process.platform !== 'win32')('real ACL reading on Windows', () => {
  it('lists the SIDs of a folder and sees a grant to Users', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { realSys } = await import('../../src/service/sys')
    const dir = mkdtempSync(join(tmpdir(), 'mm-acl-'))
    try {
      const sys = realSys()
      const before = aclSids(sys, dir)!
      expect(before.length).toBeGreaterThan(0)
      expect(before.every((s) => /^S-1-/.test(s))).toBe(true)
      expect(sys.run('icacls', [dir, '/grant', '*S-1-5-32-545:(R)']).status).toBe(0)
      expect(aclSids(sys, dir)).toContain('S-1-5-32-545')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform !== 'win32')(
  'real trust and ownership checks on Windows (Review Critical 1, 2)',
  () => {
    it('trusts an administrator-installed Node.js and flags a file in the user profile', async () => {
      const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const { realSys } = await import('../../src/service/sys')
      const { trustProblems } = await import('../../src/service/trust')
      const { inspectStateRoot } = await import('../../src/service/acl')
      const sys = realSys()
      // Program Files belongs to administrators and TrustedInstaller.
      const windir = process.env.SystemRoot ?? 'C:\\Windows'
      expect(trustProblems(sys, join(windir, 'System32', 'cmd.exe'))).toEqual([])
      const dir = mkdtempSync(join(tmpdir(), 'mm-trust-'))
      try {
        const file = join(dir, 'node.exe')
        writeFileSync(file, '')
        expect(trustProblems(sys, file).length).toBeGreaterThan(0)
        // A folder the current (non-SYSTEM) user created is not an administrators' state folder.
        const { mySid, ownedByMe } = await import('../support')
        ownedByMe(dir)
        expect(inspectStateRoot(sys, dir, []).join()).toContain(`is owned by ${mySid()}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  },
)
