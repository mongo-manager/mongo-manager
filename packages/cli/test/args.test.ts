// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { windowsTool } from '@mongo-manager/server'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMANDS, OPTIONS, loadConfig, parseCli } from '../src/args'
import { main } from '../src/main'
import { browserCommand } from '../src/open'
import { cleanTempDirs, fakeIo, tempDir } from './support'

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version

afterEach(cleanTempDirs)

describe('command line', () => {
  it('defaults to start and maps options onto the server config', () => {
    const parsed = parseCli([
      '-p',
      '8080',
      '--no-open',
      '--auth',
      '--trusted-proxies',
      '10.0.0.1, 10.0.0.2',
      '--base-path',
      '/mm/',
    ])
    expect(parsed.command).toBe('start')
    const config = loadConfig(parsed.values, fakeIo())
    expect(config).toMatchObject({
      webPort: 8080,
      open: false,
      auth: true,
      basePath: '/mm/',
      trustedProxies: ['10.0.0.1', '10.0.0.2'],
    })
  })

  it('layers config file < environment < command line', () => {
    const dir = tempDir()
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ webPort: 1000, host: '127.0.0.2', readOnly: true }))
    const io = fakeIo({ env: { MM_WEB_PORT: '2000', MM_CONFIG: file } })
    expect(loadConfig(parseCli(['--web-port', '3000']).values, io)).toMatchObject({
      webPort: 3000,
      host: '127.0.0.2',
      readOnly: true,
    })
    expect(loadConfig(parseCli([]).values, io).webPort).toBe(2000)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a config file with a secret key that others can read',
    () => {
      const dir = tempDir()
      const file = join(dir, 'config.json')
      writeFileSync(file, JSON.stringify({ secretKey: Buffer.alloc(32, 1).toString('base64') }))
      chmodSync(file, 0o644)
      expect(() => loadConfig(parseCli(['--config', file]).values, fakeIo())).toThrow(
        /readable by other users/,
      )
      chmodSync(file, 0o600)
      expect(() => loadConfig(parseCli(['--config', file]).values, fakeIo())).not.toThrow()
    },
  )

  it('refuses a config file with a metrics token that others can read (final review 1g-3, Minor 5)', () => {
    const dir = tempDir()
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ metricsToken: 'm'.repeat(40) }))
    // Windows reports 0o666 for any writable file, so a POSIX platform sees it as readable by others.
    if (process.platform !== 'win32') chmodSync(file, 0o644)
    expect(() => loadConfig(parseCli(['--config', file]).values, { ...fakeIo(), platform: 'linux' })).toThrow(
      /metricsToken but is readable by other users/,
    )
  })

  it.each([
    [['--nope'], /Unknown option/],
    [['--web-port', 'http'], /--web-port/],
    [['--web-port', '70000'], /--web-port/],
    [['launch'], /Unknown command "launch"/],
    [['start', '--role', 'admin'], /--role/],
    [['start', 'extra'], /Unexpected argument/],
  ])('rejects %j as a usage error (exit 2)', async (argv, message) => {
    const io = fakeIo()
    expect(await main(argv, io)).toBe(2)
    expect(io.err()).toMatch(message)
    expect(io.err()).toMatch(/mongo-manager --help/)
  })

  it('resolves --log-file against the working directory', () => {
    const config = loadConfig(parseCli(['--log-file', 'logs/mm.log']).values, fakeIo())
    expect(config.logFile).toBe(join(process.cwd(), 'logs', 'mm.log'))
  })

  it('prints the version and the help', async () => {
    const io = fakeIo()
    expect(await main(['version'], io)).toBe(0)
    // The package's own version, never a number written here (CI 2026-11-01).
    expect(io.out().split(' ').slice(0, 2).join(' ')).toBe(`mongo-manager ${PACKAGE_VERSION}`)
    expect(io.out()).toMatch(/ \(node \d+\./)
    const help = fakeIo()
    expect(await main(['--help'], help)).toBe(0)
    for (const word of ['start', 'user add', 'rotate-key', 'doctor', '--web-port', '--password-stdin']) {
      expect(help.out()).toContain(word)
    }
    // User request 2026-10-31: a new project, with nothing to import from an earlier one.
    expect(help.out()).not.toContain('import-legacy')
    expect(help.out()).not.toContain('1.x')
  })

  // Review of the CLI docs: --no-shell parsed as shell=false, which the config read as "not given".
  it('turns the shell off with --no-shell; the last of --shell and --no-shell wins', () => {
    const shell = (...argv: string[]) => loadConfig(parseCli(argv).values, fakeIo()).shell.enabled
    expect(shell()).toBe(true)
    expect(shell('--no-shell')).toBe(false)
    expect(shell('--shell')).toBe(true)
    expect(shell('--shell', '--no-shell')).toBe(false)
    expect(shell('--no-shell', '--shell')).toBe(true)
  })

  it('names every command and option in the help, and every command in the README', async () => {
    const help = fakeIo()
    await main(['--help'], help)
    // --web-root serves a development build of the web app; nobody running a release needs it.
    // --isolate-account is written by `service install` into the unit it makes (updater, 2026-11-03).
    const hidden = ['web-root', 'isolate-account']
    for (const option of Object.keys(OPTIONS).filter((o) => !hidden.includes(o))) {
      // The whole name: --key is not found in --key-file.
      const missing = !new RegExp(`(^|[\\s/[])--${option}(?![\\w-])`, 'm').test(help.out())
      expect(missing ? option : '').toBe('')
    }
    const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')
    for (const command of COMMANDS.filter((c) => c !== 'help')) {
      expect(help.out()).toMatch(new RegExp(`^  ${command}\\b`, 'm'))
      expect(readme).toMatch(new RegExp(`^\\| \`${command}\\b`, 'm'))
    }
  })
})

describe('browser opener', () => {
  it('passes the URL as one argument without a shell', () => {
    expect(browserCommand('http://127.0.0.1:4321/', 'win32')).toEqual({
      cmd: windowsTool('rundll32'),
      args: ['url.dll,FileProtocolHandler', 'http://127.0.0.1:4321/'],
    })
    expect(browserCommand('http://127.0.0.1:4321/', 'darwin')).toEqual({
      cmd: 'open',
      args: ['http://127.0.0.1:4321/'],
    })
    expect(browserCommand('http://127.0.0.1:4321/', 'linux')).toEqual({
      cmd: 'xdg-open',
      args: ['http://127.0.0.1:4321/'],
    })
    expect(() => browserCommand('http://x/" & calc', 'win32')).toThrow()
    expect(() => browserCommand('file:///etc/passwd', 'linux')).toThrow()
  })
})
