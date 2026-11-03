import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  ConfigError,
  defaultConfig,
  assertSafeBind,
  isLoopbackHost,
  readConfigFile,
  PartialConfigSchema,
  resolveConfig,
  startupWarnings,
} from '../src/config'

/** A config file's section as the server reads it: parsed, its own defaults filled in. */
const readPartial = (file: unknown) => PartialConfigSchema.parse(file)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('resolveConfig', () => {
  it('has safe defaults', () => {
    expect(resolveConfig({})).toEqual({
      webPort: 4321,
      host: '127.0.0.1',
      auth: false,
      dataDir: join(homedir(), '.mongo-manager'),
      readOnly: false,
      allowServerJs: false,
      requireAdmin2fa: false,
      requireAll2fa: false,
      gridfsMaxMb: 512,
      // W6.4 review (minor 13): the documents one data model samples in all.
      modelMaxDocs: 20_000,
      plugins: true,
      // User request 2026-10-12: installs from GitHub are off unless a server turns them on.
      pluginsGithub: false,
      trustedProxies: [],
      allowedHosts: [],
      basePath: '/',
      unsafeNoAuth: false,
      // The updater (2026-11-03): on, its daily check off until an administrator turns it on.
      updates: { enabled: true },
      open: true,
      logLevel: 'info',
      apiRateLimit: 600,
      maxConnections: 1000,
      maxConnectionsPerIp: 256,
      transfer: { maxUploadMb: 1024, quotaMb: 5120, ttlHours: 24, maxJobHours: 6 },
      backup: {
        quotaMb: 20480,
        totalQuotaMb: 102400,
        maxUploadMb: 20480,
        ttlHours: 24,
        maxJobHours: 12,
        chunkMb: 64,
        folderRoots: [],
        privateNetworks: [],
        destPartMb: 64,
        destTransfers: 2,
        schedules: true,
        scheduleConcurrency: 2,
      },
      shell: {
        enabled: true,
        maxPerUser: 3,
        maxTotal: 20,
        commandTimeoutMs: 60_000,
        idleMs: 0,
        lifetimeMs: 43_200_000,
        rssMb: 384,
        outputMb: 5,
        commandsPerSecond: 20,
      },
      // Phase 3e-1: change-stream feeds.
      watch: { enabled: true, maxFeeds: 50 },
      liveSync: { enabled: true, maxSyncs: 10 },
      ai: {
        enabled: true,
        privateNetworks: [],
        perMinute: 10,
        agentPerMinute: 30,
        perDay: 200,
        maxConcurrent: 8,
        chatDays: 30,
      },
      // W3.3: alerts (on), reaching public mail servers and webhooks only unless networks are listed.
      alerts: { enabled: true, privateNetworks: [] },
      // W7, W8: nothing signs in as the server in team mode unless an administrator allows it; the
      // identity providers and key management services are public unless networks are listed.
      allowKerberos: false,
      allowWorkloadIdentity: false,
      oidc: { privateNetworks: [] },
      encryption: { privateNetworks: [], allowedHosts: [] },
    })
  })

  it('reads the alerts switch and the networks they may reach (W3.3)', () => {
    const c = resolveConfig({
      env: { MM_ALERTS: '0', MM_ALERTS_PRIVATE_NETWORKS: '10.0.0.0/8, 192.168.1.0/24' },
    })
    expect(c.alerts).toEqual({ enabled: false, privateNetworks: ['10.0.0.0/8', '192.168.1.0/24'] })
    // Metadata and link-local addresses can never be listed.
    expect(() => resolveConfig({ env: { MM_ALERTS_PRIVATE_NETWORKS: '169.254.169.254/32' } })).toThrow()
  })

  it('reads the backup limits (phase 3d-3a)', () => {
    // A full path where the tests run (on Windows, /opt/tools is on the current drive).
    const tools = process.platform === 'win32' ? 'C:\\tools' : '/opt/tools'
    const c = resolveConfig({
      env: {
        MM_BACKUP_QUOTA: '1024',
        MM_BACKUP_TOTAL_QUOTA: '4096',
        MM_BACKUP_MAX_UPLOAD: '512',
        MM_BACKUP_TTL_HOURS: '48',
        MM_BACKUP_MAX_JOB_HOURS: '3',
        MM_BACKUP_CHUNK_MB: '128',
        MM_MONGODB_TOOLS_PATH: tools,
      },
    })
    expect(c.backup).toEqual({
      quotaMb: 1024,
      totalQuotaMb: 4096,
      maxUploadMb: 512,
      ttlHours: 48,
      maxJobHours: 3,
      chunkMb: 128,
      toolsPath: tools,
      folderRoots: [],
      privateNetworks: [],
      destPartMb: 64,
      destTransfers: 2,
      schedules: true,
      scheduleConcurrency: 2,
    })
    expect(() => resolveConfig({ env: { MM_BACKUP_CHUNK_MB: '48' } })).toThrow()
  })

  it('reads the API rate limit per client from MM_API_RATE_LIMIT, within bounds', () => {
    // Required 2FA (2026-10-28): both requirements are read from the environment.
    expect(resolveConfig({ env: { MM_REQUIRE_2FA: '1' } })).toMatchObject({
      requireAll2fa: true,
      requireAdmin2fa: false,
    })
    expect(resolveConfig({ env: { MM_REQUIRE_ADMIN_2FA: 'true' } }).requireAdmin2fa).toBe(true)
    expect(() => resolveConfig({ env: { MM_REQUIRE_2FA: 'sometimes' } })).toThrow()
    expect(resolveConfig({ env: { MM_API_RATE_LIMIT: '5000' } }).apiRateLimit).toBe(5000)
    expect(() => resolveConfig({ env: { MM_API_RATE_LIMIT: '10' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_API_RATE_LIMIT: 'lots' } })).toThrow()
  })

  // W6.4 review (minor 13).
  it('reads the data model cap from MM_MODEL_MAX_DOCS, within bounds', () => {
    expect(resolveConfig({ env: { MM_MODEL_MAX_DOCS: '5000' } }).modelMaxDocs).toBe(5000)
    expect(() => resolveConfig({ env: { MM_MODEL_MAX_DOCS: '10' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_MODEL_MAX_DOCS: '2000000' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_MODEL_MAX_DOCS: 'all' } })).toThrow()
  })

  it('applies precedence cli > env > file > defaults', () => {
    const c = resolveConfig({
      file: { webPort: 1000, host: '10.0.0.1', readOnly: true },
      env: { MM_WEB_PORT: '2000', MM_HOST: '10.0.0.2' },
      cli: { webPort: 3000 },
    })
    expect([c.webPort, c.host, c.readOnly]).toEqual([3000, '10.0.0.2', true])
  })

  // Review of the CLI docs: a section given in one layer replaced the whole section of the layers
  // below, so one shell limit in the environment switched a shell the config file had turned off
  // back on, and one backup setting dropped the file's folder roots.
  it('merges a section setting by setting across the layers, never re-enabling what one turned off', () => {
    const root = join(tmpdir(), 'mm-backups')
    const file = { shell: { enabled: false }, backup: { folderRoots: [root] } }
    const c = resolveConfig({
      file: readPartial(file),
      env: { MM_SHELL_MAX_PER_USER: '5', MM_BACKUP_CHUNK_MB: '16' },
    })
    expect([c.shell.enabled, c.shell.maxPerUser]).toEqual([false, 5])
    expect([c.backup.folderRoots, c.backup.chunkMb]).toEqual([[root], 16])

    const cli = resolveConfig({
      file: readPartial({ shell: { maxPerUser: 7 } }),
      cli: { shell: { enabled: false } as never },
    })
    expect([cli.shell.enabled, cli.shell.maxPerUser]).toEqual([false, 7])
    // A list is a value: the higher layer's replaces the lower one's, it is not added to it.
    const other = join(tmpdir(), 'mm-other')
    const lists = resolveConfig({ file: readPartial(file), env: { MM_BACKUP_FOLDER_ROOTS: other } })
    expect(lists.backup.folderRoots).toEqual([other])
  })

  // Review 2026-10-18 (minor 5): the config file's folder roots are read as the env's are, and as
  // service install reads them for the systemd unit: a space around one is no part of it.
  it("trims the config file's folder roots", () => {
    const root = join(tmpdir(), 'mm-backups')
    const c = resolveConfig({ file: readPartial({ backup: { folderRoots: [` ${root} `] } }) })
    expect(c.backup.folderRoots).toEqual([root])
  })

  // Re-review of the merge (Minor 1): a config file naming a section gets that section's schema
  // defaults, which then sit over defaultConfig()'s; the two must say the same, or naming a section
  // would quietly change the settings it leaves out.
  it('has the same defaults in defaultConfig() as a config file section gets from the schema', () => {
    const sections = ['shell', 'transfer', 'backup', 'watch', 'liveSync', 'ai'] as const
    const filled = PartialConfigSchema.parse(Object.fromEntries(sections.map((s) => [s, {}])))
    const defaults = defaultConfig()
    for (const s of sections) expect(filled[s], s).toEqual(defaults[s])
  })

  it('never lets a layer reach the prototype of the merged settings', () => {
    // Settings with no default, so nothing of the merged object's own hides what a prototype holds.
    const file = JSON.parse('{"__proto__":{"uri":"mongodb://elsewhere"},"shell":{"__proto__":{"uid":0}}}')
    const c = resolveConfig({ file, env: { MM_SHELL_MAX_PER_USER: '4' } })
    expect([c.uri, c.shell.uid, c.shell.maxPerUser]).toEqual([undefined, undefined, 4])
    expect(({} as { uri?: string }).uri).toBeUndefined()
  })

  it('parses every environment variable', () => {
    const c = resolveConfig({
      env: {
        MM_WEB_PORT: '8080',
        MM_HOST: '0.0.0.0',
        MM_AUTH: 'true',
        MM_DATA_DIR: '/data',
        MM_READ_ONLY: '1',
        MM_TRUSTED_PROXIES: '10.0.0.0/8, 127.0.0.1',
        MM_ALLOWED_HOSTS: 'mm.example.com,localhost',
        MM_BASE_PATH: '/mm/',
        MM_UNSAFE_NO_AUTH: 'no',
        MM_OPEN: 'off',
        MM_URI: 'mongodb://localhost:27017',
        MM_SECRET_KEY: 'a2V5',
        MM_LOG_LEVEL: 'debug',
        MM_PLUGINS_GITHUB: '1',
      },
    })
    expect(c).toMatchObject({
      webPort: 8080,
      host: '0.0.0.0',
      auth: true,
      dataDir: '/data',
      readOnly: true,
      trustedProxies: ['10.0.0.0/8', '127.0.0.1'],
      allowedHosts: ['mm.example.com', 'localhost'],
      basePath: '/mm/',
      unsafeNoAuth: false,
      open: false,
      uri: 'mongodb://localhost:27017',
      secretKey: 'a2V5',
      logLevel: 'debug',
      plugins: true,
      pluginsGithub: true,
    })
  })

  // User request 2026-10-12: GitHub installs are off unless turned on; both words of the switch read.
  it('reads the GitHub install switch both ways', () => {
    const read = (value: string) => resolveConfig({ env: { MM_PLUGINS_GITHUB: value } }).pluginsGithub
    expect(read('true')).toBe(true)
    expect(read('on')).toBe(true)
    expect(read('0')).toBe(false)
    expect(read('false')).toBe(false)
    expect(read('')).toBe(false)
  })

  it('ignores empty environment variables', () => {
    expect(resolveConfig({ env: { MM_WEB_PORT: '', MM_HOST: '' } }).webPort).toBe(4321)
  })

  // User report 2026-10-12: a shell its page holds is never closed for idling unless the operator
  // sets a limit; 0 is none, a limit stays within its bounds. Security audit 2026-10-16: a shell
  // lives at most 12 hours by default, as spec §4 says (0 still turns that off).
  it('sets no shell idle limit and a 12-hour lifetime unless told otherwise, 0 meaning none', () => {
    expect(resolveConfig({}).shell).toMatchObject({ idleMs: 0, lifetimeMs: 43_200_000 })
    expect(resolveConfig({ env: { MM_SHELL_IDLE_MS: '0', MM_SHELL_LIFETIME_MS: '0' } }).shell).toMatchObject({
      idleMs: 0,
      lifetimeMs: 0,
    })
    expect(resolveConfig({ env: { MM_SHELL_IDLE_MS: '900000' } }).shell.idleMs).toBe(900_000)
    expect(() => resolveConfig({ env: { MM_SHELL_IDLE_MS: '5000' } })).toThrow(/idleMs/)
    expect(() => resolveConfig({ env: { MM_SHELL_LIFETIME_MS: '30000' } })).toThrow(/lifetimeMs/)
  })

  // Security audit 2026-10-16 (minor): spec §4 says every shell limit is configurable; the memory
  // cap, the output cap and the command rate were fixed in code.
  it('reads the shell memory cap, output cap and command rate, within their bounds', () => {
    expect(resolveConfig({}).shell).toMatchObject({ rssMb: 384, outputMb: 5, commandsPerSecond: 20 })
    const c = resolveConfig({
      env: { MM_SHELL_RSS_MB: '512', MM_SHELL_OUTPUT_MB: '10', MM_SHELL_COMMANDS_PER_SECOND: '5' },
    })
    expect(c.shell).toMatchObject({ rssMb: 512, outputMb: 10, commandsPerSecond: 5 })
    // Below what a worker needs to start, or past what the server would let through.
    expect(() => resolveConfig({ env: { MM_SHELL_RSS_MB: '64' } })).toThrow(/rssMb/)
    expect(() => resolveConfig({ env: { MM_SHELL_RSS_MB: '99999' } })).toThrow(/rssMb/)
    expect(() => resolveConfig({ env: { MM_SHELL_OUTPUT_MB: '0' } })).toThrow(/outputMb/)
    expect(() => resolveConfig({ env: { MM_SHELL_OUTPUT_MB: '65' } })).toThrow(/outputMb/)
    expect(() => resolveConfig({ env: { MM_SHELL_COMMANDS_PER_SECOND: '0' } })).toThrow(/commandsPerSecond/)
  })

  it('rejects invalid values with a ConfigError naming the setting', () => {
    expect(() => resolveConfig({ env: { MM_WEB_PORT: 'abc' } })).toThrow(/MM_WEB_PORT/)
    expect(() => resolveConfig({ env: { MM_AUTH: 'maybe' } })).toThrow(/MM_AUTH/)
    expect(() => resolveConfig({ cli: { webPort: 70000 } })).toThrow(ConfigError)
    expect(() => resolveConfig({ cli: { basePath: 'mm' } })).toThrow(/basePath/)
    for (const bad of ['/../', '/./', '/a/../', '/...//'])
      expect(() => resolveConfig({ cli: { basePath: bad } })).toThrow(/basePath/)
    expect(() => resolveConfig({ env: { MM_LOG_LEVEL: 'loud' } })).toThrow(ConfigError)
  })
})

describe('readConfigFile', () => {
  const write = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-cfg-'))
    dirs.push(dir)
    const path = join(dir, 'config.json')
    writeFileSync(path, content)
    return path
  }

  it('reads a partial config', () => {
    expect(readConfigFile(write('{ "webPort": 5000, "auth": true }'))).toEqual({ webPort: 5000, auth: true })
  })

  it('rejects unknown keys, bad types and invalid JSON', () => {
    expect(() => readConfigFile(write('{ "port": 5000 }'))).toThrow(ConfigError)
    expect(() => readConfigFile(write('{ "webPort": "5000" }'))).toThrow(ConfigError)
    expect(() => readConfigFile(write('{ nope'))).toThrow(/not valid JSON/)
  })
})

describe('bind safety (S1)', () => {
  it('knows loopback hosts', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', '::1', 'localhost']) expect(isLoopbackHost(h), h).toBe(true)
    for (const h of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '127.0.0.1.nip.io']) {
      expect(isLoopbackHost(h), h).toBe(false)
    }
  })

  it('refuses a non-loopback bind without auth', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.5']) {
      expect(() => assertSafeBind(resolveConfig({ cli: { host } })), host).toThrow(/Refusing to listen/)
    }
  })

  it('allows loopback, team mode and the explicit override', () => {
    expect(() => assertSafeBind(resolveConfig({ cli: { host: '127.0.0.1' } }))).not.toThrow()
    expect(() => assertSafeBind(resolveConfig({ cli: { host: '0.0.0.0', auth: true } }))).not.toThrow()
    expect(() =>
      assertSafeBind(resolveConfig({ cli: { host: '0.0.0.0', unsafeNoAuth: true } })),
    ).not.toThrow()
  })
})

// Security review 2026-10-13 (low): nothing said when sign-ins crossed a network unencrypted, or when
// session cookies could not be marked Secure behind an HTTPS proxy.
describe('startup warnings', () => {
  it('warns when team mode is reached over plain HTTP on a network', () => {
    const warning = startupWarnings(resolveConfig({ cli: { host: '0.0.0.0', auth: true } })).find((w) =>
      w.includes('plain HTTP'),
    )
    expect(warning).toMatch(/plain HTTP/)
    expect(warning).toMatch(/--trusted-proxies/)
  })

  it('warns when a public name is allowed but no proxy is trusted', () => {
    const warnings = startupWarnings(resolveConfig({ cli: { auth: true, allowedHosts: ['mm.example.com'] } }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('--allowed-hosts names mm.example.com,')
    expect(warnings[0]).toMatch(/Secure/)
  })

  // Review of the total transfer quota (minor 4).
  it('warns when the total transfer storage is below one user’s', () => {
    const [warning] = startupWarnings(
      resolveConfig({ env: { MM_TRANSFER_QUOTA: '4096', MM_TRANSFER_TOTAL_QUOTA: '1024' } }),
    )
    expect(warning).toMatch(/MM_TRANSFER_TOTAL_QUOTA \(1024 MiB\) is below MM_TRANSFER_QUOTA \(4096 MiB\)/)
  })

  it('says nothing for a loopback bind, local mode, or a trusted proxy', () => {
    expect(startupWarnings(resolveConfig({ cli: { auth: true } }))).toEqual([])
    // Security audit 2026-10-16: a network bind without a host list is told which names it takes.
    expect(startupWarnings(resolveConfig({ cli: { host: '0.0.0.0', unsafeNoAuth: true } }))).toEqual([
      expect.stringMatching(/without --allowed-hosts: only addresses and localhost/),
    ])
    expect(
      startupWarnings(
        resolveConfig({
          cli: {
            host: '0.0.0.0',
            auth: true,
            allowedHosts: ['mm.example.com'],
            trustedProxies: ['10.0.0.2'],
          },
        }),
      ),
    ).toEqual([])
  })
})

describe('config file errors', () => {
  it('never echo the file contents, which may hold a secret (Review Minor 7)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { readConfigFile } = await import('../src/config')
    const dir = mkdtempSync(join(tmpdir(), 'mm-cfg-'))
    const file = join(dir, 'config.json')
    writeFileSync(file, '{ "secretKey": c2VjcmV0c2VjcmV0c2VjcmV0 }')
    try {
      expect(() => readConfigFile(file)).toThrow(/is not valid JSON/)
      expect(() => readConfigFile(file)).not.toThrow(/c2VjcmV0/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('backup destination settings (phase 3d-3b spec §4.6)', () => {
  it('reads folder roots, private networks, part size and transfers from the environment', () => {
    const roots = [join(tmpdir(), 'a'), join(tmpdir(), 'b')]
    const c = resolveConfig({
      env: {
        MM_BACKUP_FOLDER_ROOTS: roots.join(delimiter),
        MM_BACKUP_PRIVATE_NETWORKS: '10.0.0.0/8, fd12:3456::/48',
        MM_BACKUP_DEST_PART_MB: '128',
        MM_BACKUP_DEST_TRANSFERS: '3',
      },
    })
    expect(c.backup).toMatchObject({
      folderRoots: roots,
      privateNetworks: ['10.0.0.0/8', 'fd12:3456::/48'],
      destPartMb: 128,
      destTransfers: 3,
    })
    expect(resolveConfig({}).backup).toMatchObject({
      folderRoots: [],
      privateNetworks: [],
      destPartMb: 64,
      destTransfers: 2,
    })
  })

  it('refuses metadata and link-local networks, malformed CIDRs and out-of-range sizes', () => {
    for (const bad of [
      '169.254.0.0/16',
      '169.254.169.254/32',
      'fe80::/10',
      'fd00:ec2::254/128',
      '10.0.0.0/33',
      'x',
    ])
      expect(() => resolveConfig({ env: { MM_BACKUP_PRIVATE_NETWORKS: bad } }), bad).toThrow(
        /MM_BACKUP_PRIVATE_NETWORKS|privateNetworks/,
      )
    expect(() => resolveConfig({ env: { MM_BACKUP_DEST_PART_MB: '8' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_BACKUP_DEST_TRANSFERS: '9' } })).toThrow()
    expect(() => resolveConfig({ env: { MM_BACKUP_FOLDER_ROOTS: 'relative/dir' } })).toThrow(/absolute/)
  })

  // W4 re-review (minor): a restore drill's size cap, for a server that does not say its free space.
  it('reads the drill size cap, unset by default', () => {
    expect(resolveConfig({ env: { MM_BACKUP_DRILL_MAX_MB: '2048' } }).backup.drillMaxMb).toBe(2048)
    expect(resolveConfig({}).backup.drillMaxMb).toBeUndefined()
    expect(() => resolveConfig({ env: { MM_BACKUP_DRILL_MAX_MB: '0' } })).toThrow()
  })
})
