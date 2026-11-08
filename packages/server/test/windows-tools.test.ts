// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import {
  kernelRoot,
  powershellArgs,
  powershellEnv,
  systemRoot,
  windowsEnv,
  windowsTool,
} from '../src/windows-tools'

/**
 * CI 2026-10-18: Windows' own tools are run from their place, never by a bare name looked up in
 * the current folder or on the PATH, and Windows PowerShell gets its own modules only.
 */
describe("Windows' own tools", () => {
  it('are found in System32, PowerShell in its own folder', () => {
    expect(windowsTool('schtasks', 'D:\\Windows')).toBe('D:\\Windows\\System32\\schtasks.exe')
    expect(windowsTool('taskkill', 'D:\\Windows')).toBe('D:\\Windows\\System32\\taskkill.exe')
    expect(windowsTool('powershell', 'D:\\Windows')).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(windowsTool('net')).toBe(`${systemRoot()}\\System32\\net.exe`)
  })

  // Review of the CI fixes (minor 6): an account's own settings can name another folder for what it
  // starts elevated; where the kernel cannot say, only a Windows folder at a drive's root is taken
  // from the environment.
  it("are never looked for where the environment names another folder than Windows' own", () => {
    const none = () => null
    for (const named of [
      'C:\\fake',
      'C:\\Users\\a\\Windows',
      '\\\\server\\Windows',
      'C:\\Windows\\..\\x',
      'Windows',
      '',
    ])
      expect(systemRoot({ SystemRoot: named }, none), named).toBe('C:\\Windows')
    expect(systemRoot({ windir: 'D:\\x' }, none)).toBe('C:\\Windows')
    expect(systemRoot({ SystemRoot: 'd:\\WINDOWS' }, none)).toBe('d:\\WINDOWS')
    expect(powershellEnv({}, { SystemRoot: 'C:\\fake' }).PSModulePath).toMatch(
      /^[A-Za-z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\Modules$/i,
    )
  })

  // Second review (minor 2): a user may make D:\\Windows on a second drive and name it; the kernel's
  // own answer wins over any environment.
  it.runIf(process.platform === 'win32')('are asked of the kernel, whatever the environment names', () => {
    const real = realpathSync.native(process.env.SystemRoot ?? 'C:\\Windows').toLowerCase()
    expect(kernelRoot()?.toLowerCase()).toBe(real)
    expect(systemRoot({ SystemRoot: 'Z:\\Windows' }).toLowerCase()).toBe(real)
  })

  it('lay an environment over another by names compared without case, as Windows does', () => {
    expect(windowsEnv({ Path: 'a', psmodulepath: 'x', Keep: '1' }, { PATH: 'b', PSModulePath: 'y' })).toEqual(
      {
        Keep: '1',
        PATH: 'b',
        PSModulePath: 'y',
      },
    )
  })

  it("give Windows PowerShell its own module folder only, whatever the parent's was", () => {
    const env = {
      SystemRoot: 'C:\\Windows',
      PSMODULEPATH: 'C:\\pwsh7\\Modules;C:\\Users\\a\\Modules',
      Other: 'o',
    }
    expect(powershellEnv({ MM_IN: 'v' }, env)).toEqual({
      SystemRoot: 'C:\\Windows',
      Other: 'o',
      MM_IN: 'v',
      PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    })
    // What the caller gives cannot put another module path back.
    expect(powershellEnv({ PSModulePath: 'C:\\evil' }, env).PSModulePath).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    )
  })
})

/** The script `args` runs. */
const scriptOf = (args: string[]) =>
  Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le')

/** Windows PowerShell running `script` as powershellArgs has it run. */
const runScript = (script: string, more?: string[]) =>
  spawnSync(windowsTool('powershell'), powershellArgs(script, more), {
    encoding: 'utf8',
    windowsHide: true,
    env: powershellEnv(),
  })

/**
 * CI 2026-10-21 (Windows): without the module analysis cache GitHub's runner names in
 * PSModuleAnalysisCachePath, Windows PowerShell took 25 to 30 s to find a cmdlet by looking through
 * every module; a script of ours looks for none.
 */
describe('Windows PowerShell scripts', () => {
  it('go encoded, with no profile, and import the modules they use from PowerShell’s own folder', () => {
    const args = powershellArgs("'hello'", ['CimCmdlets'])
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(args).toHaveLength(4)
    expect(scriptOf(args)).toBe(
      [
        "$ProgressPreference = 'SilentlyContinue'",
        "$ErrorActionPreference = 'Stop'",
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        "$PSModuleAutoLoadingPreference = 'None'",
        'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Management", ' +
          '"$PSHOME\\Modules\\Microsoft.PowerShell.Security", "$PSHOME\\Modules\\Microsoft.PowerShell.Utility", ' +
          '"$PSHOME\\Modules\\CimCmdlets"',
        "'hello'",
      ].join('\n'),
    )
    expect(scriptOf(powershellArgs("'hello'"))).not.toContain('CimCmdlets')
  })

  // Review of the module imports (minor 2): a name goes into the script as code.
  it('take a module of PowerShell’s own by its plain name only', () => {
    for (const name of [
      'Microsoft.PowerShell.Diagnostics',
      'CimCmdlets',
      'PSReadLine',
      'Hyper-V',
      'Get-NetView',
    ])
      expect(() => powershellArgs("'x'", [name]), name).not.toThrow()
    for (const name of [
      '',
      '-a',
      'a b',
      'a"; Remove-Item x; "',
      '..',
      '..\\..\\x',
      'C:\\x',
      'a/b',
      '$x',
      '.a',
      'a.',
    ])
      expect(() => powershellArgs("'x'", [name]), name).toThrow(/module/)
  })

  it.runIf(process.platform === 'win32')(
    'load those modules from its own folder alone, and look for no other',
    () => {
      const ask = (more?: string[]) => {
        const res = runScript(
          "Get-Module | ForEach-Object { $_.Name + ' ' + $_.ModuleBase }\n" +
            // Review of the module imports (minor 4): Get-Disk is there to be found.
            'Test-Path -LiteralPath "$PSHOME\\Modules\\Storage"\n' +
            "try { Get-Disk | Out-Null; 'searched' } catch [System.Management.Automation.CommandNotFoundException] { 'not searched' }",
          more,
        )
        expect(res.stderr).toBe('')
        expect(res.status).toBe(0)
        return res.stdout.trim().split(/\r?\n/)
      }
      // A module of PowerShell's own is in its folder ($PSHOME) or in a folder of its Modules.
      const home = `${win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0')}\\`.toLowerCase()
      const loaded = (lines: string[]) =>
        lines.slice(0, -2).map((l) => {
          const name = l.slice(0, l.indexOf(' '))
          expect(`${l.slice(name.length + 1)}\\`.toLowerCase().startsWith(home), l).toBe(true)
          return name
        })
      const plain = ask()
      expect(loaded(plain).sort()).toEqual([
        'Microsoft.PowerShell.Management',
        'Microsoft.PowerShell.Security',
        'Microsoft.PowerShell.Utility',
      ])
      expect(plain.slice(-2)).toEqual(['True', 'not searched'])
      expect(loaded(ask(['CimCmdlets']))).toContain('CimCmdlets')
    },
    60_000,
  )

  // Review of the module imports (minor 1): what powershellArgs prints is UTF-8 from its first line.
  // That the encoding comes before the imports, so a failing import is said in UTF-8 too, the exact
  // text above pins (second review, nit 2).
  it.runIf(process.platform === 'win32')('say what they print in UTF-8 from the start', () => {
    const res = runScript("[Console]::Out.Write('çğüşöı İ')")
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('çğüşöı İ')
  })

  // Review of the module imports (minor 3; second review, nits 3 to 5; third to fifth reviews): read
  // as code, so comments and the modules a file imports (./powershell) count for nothing. Any string
  // that names Windows PowerShell or PowerShell 7, however (alone, by a path with spaces, inside a
  // command line, a message or a link), is in one of the files below, or the test fails:
  // - `exempt`, with its reason: a file that names it for another reason (a message, a link) goes
  //   there;
  // - sys.ts, which finds the program and its environment for what its callers run, only compares a
  //   name with it;
  // - in `runs` each naming is the program of a run whose arguments the imported powershellArgs
  //   makes, as the next argument or as `args` beside `file`, and nothing there is named so.
  // Seen only as those files are reviewed: a run that reuses a program path such a file names, a
  // program name built at run time, and a name sys.ts compares and then runs (sixth review, nit 3).
  it('are run as powershellArgs makes them, wherever a package or the repository names one', () => {
    const repo = join(__dirname, '..', '..', '..')
    const packages = join(repo, 'packages')
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.name === 'node_modules' || e.name === 'dist'
          ? []
          : e.isDirectory()
            ? sources(join(dir, e.name))
            : /\.[cm]?[jt]s$/.test(e.name)
              ? [join(dir, e.name)]
              : [],
      )
    const roots = [
      join(repo, 'scripts'),
      ...readdirSync(packages).flatMap((p) =>
        (p === 'plugins'
          ? readdirSync(join(packages, p)).map((q) => join(packages, p, q))
          : [join(packages, p)]
        ).flatMap((d) => [join(d, 'src'), join(d, 'scripts')]),
      ),
    ]
    const files = roots.filter((r) => existsSync(r)).flatMap(sources)
    expect(files.length).toBeGreaterThan(100)
    const tools = join(packages, 'server', 'src', 'windows-tools.ts')
    const exempt = new Map([[tools, 'finds Windows PowerShell and makes its arguments']])
    const finds = join(packages, 'cli', 'src', 'service', 'sys.ts')
    const runs = [
      join(packages, 'server', 'src', 'store', 'datadir.ts'),
      join(packages, 'cli', 'src', 'service', 'powershell.ts'),
      // The updater's launcher lists the service account's processes (2026-11-03).
      join(packages, 'cli', 'src', 'launcher', 'isolate.ts'),
    ]
    const calleeName = (call: ts.CallExpression) => {
      const callee = call.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword) return 'import'
      if (ts.isIdentifier(callee)) return callee.text
      if (ts.isPropertyAccessExpression(callee))
        return `${ts.isIdentifier(callee.expression) ? callee.expression.text : ''}.${callee.name.text}`
      return ''
    }
    const isArgs = (node: ts.Node | undefined) =>
      node !== undefined && ts.isCallExpression(node) && calleeName(node) === 'powershellArgs'
    const isModule = (node: ts.Node) => {
      const parent = node.parent
      return (
        ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        ts.isExternalModuleReference(parent) ||
        (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
        (ts.isCallExpression(parent) && ['import', 'require', 'require.resolve'].includes(calleeName(parent)))
      )
    }
    /** `program` is what a run starts, and powershellArgs makes that run's arguments. */
    const runsByArgs = (program: ts.Node): boolean => {
      const parent = program.parent
      if (
        ts.isCallExpression(parent) &&
        calleeName(parent) === 'windowsTool' &&
        parent.arguments.length === 1
      )
        return runsByArgs(parent)
      if (ts.isCallExpression(parent)) {
        const at = parent.arguments.indexOf(program as ts.Expression)
        return at >= 0 && isArgs(parent.arguments[at + 1])
      }
      if (
        ts.isPropertyAssignment(parent) &&
        parent.initializer === program &&
        ts.isObjectLiteralExpression(parent.parent)
      )
        return parent.parent.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === 'args' &&
            isArgs(p.initializer),
        )
      return false
    }
    /**
     * `specifier`, imported by `file`, is windows-tools.ts itself (not another exempt file; with or
     * without .js or .ts) or the server package (sixth and seventh reviews).
     */
    const isOwn = (file: string, specifier: string) =>
      specifier === '@mongo-manager/server' ||
      // The module alone, as the launcher imports it (it must not load the server; 2026-11-03).
      specifier === '@mongo-manager/server/windows-tools' ||
      (specifier.startsWith('.') && `${join(dirname(file), specifier.replace(/\.[jt]s$/, ''))}.ts` === tools)
    /** `name` is one side of a comparison. */
    const compared = (name: ts.Node) =>
      ts.isBinaryExpression(name.parent) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        name.parent.operatorToken.kind,
      )
    // A word of its own, so 'xPWSHy' or a blob is not one (fifth review, nit 4).
    const naming = /(?<![A-Za-z])(?:powershell|pwsh)(?![A-Za-z])/i
    const wrong: string[] = []
    for (const f of files) {
      if (exempt.has(f)) continue
      const source = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true)
      let imported = false
      const visit = (node: ts.Node) => {
        if (
          (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
          !isModule(node) &&
          naming.test(node.text) &&
          !(runs.includes(f) && runsByArgs(node)) &&
          !(f === finds && compared(node))
        )
          wrong.push(`${f}: ${node.text.slice(0, 80)}`)
        if (
          ts.isImportSpecifier(node) &&
          node.name.text === 'powershellArgs' &&
          !node.propertyName &&
          ts.isStringLiteral(node.parent.parent.parent.moduleSpecifier) &&
          isOwn(f, node.parent.parent.parent.moduleSpecifier.text)
        )
          imported = true
        // Fifth review (nit 2): one of its own, under that name, would pass for it.
        else if (
          (ts.isVariableDeclaration(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isParameter(node) ||
            ts.isImportSpecifier(node) ||
            ts.isImportClause(node) ||
            ts.isNamespaceImport(node) ||
            ts.isBindingElement(node)) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'powershellArgs'
        )
          wrong.push(`${f}: a powershellArgs of its own`)
        ts.forEachChild(node, visit)
      }
      visit(source)
      if (runs.includes(f) && !imported) wrong.push(`${f}: powershellArgs is not imported`)
    }
    expect(wrong).toEqual([])
  })
})
