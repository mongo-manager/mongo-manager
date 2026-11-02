import { describe, expect, it } from 'vitest'
import { layoutFor } from '../../src/service/layout'
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  renderTaskXml,
  serviceConfigJson,
} from '../../src/service/render'
import { checkPathSafe, checkPort, checkUserName } from '../../src/service/validate'

const linux = layoutFor('linux', {})
const unit = {
  command: ['/usr/bin/node', `${linux.programDir}/dist/cli.cjs`],
  config: linux.configFile,
  dataDir: linux.dataDir,
  user: 'mongo-manager',
  envFile: linux.envFile,
  logFile: null,
}

describe('systemd unit (spec §3.5 hardening)', () => {
  it('runs the copied program as the service user with the full sandbox', () => {
    const text = renderSystemdUnit(unit)
    expect(text).toContain(
      'ExecStart="/usr/bin/node" "/opt/mongo-manager/app/dist/cli.cjs" start --config "/etc/mongo-manager/config.json" --no-open',
    )
    for (const line of [
      'User=mongo-manager',
      'EnvironmentFile=/etc/mongo-manager/env',
      'ReadWritePaths=/var/lib/mongo-manager',
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'PrivateDevices=yes',
      'ReadWritePaths=/var/lib/mongo-manager',
      'CapabilityBoundingSet=',
      'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
      'LockPersonality=yes',
      'MemoryMax=1G',
      'Restart=on-failure',
      'UMask=0077',
    ]) {
      expect(text.split('\n')).toContain(line)
    }
    // V8 needs writable+executable memory for its JIT.
    expect(text).not.toContain('MemoryDenyWriteExecute')
  })
})

describe('launchd plist', () => {
  it('runs as the service account, restarts on failure and logs to a file', () => {
    const mac = layoutFor('darwin', {})
    const text = renderLaunchdPlist({
      ...unit,
      command: ['/usr/bin/node', `${mac.programDir}/dist/cli.cjs`],
      config: mac.configFile,
      dataDir: mac.dataDir,
      user: '_mongomanager',
      envFile: null,
      logFile: mac.logFile,
    })
    expect(text).toContain('<key>Label</key>\n  <string>com.mongo-manager.server</string>')
    expect(text).toContain('<string>/Library/Application Support/Mongo Manager/config.json</string>')
    expect(text).toContain('<key>UserName</key>\n  <string>_mongomanager</string>')
    expect(text).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>')
    expect(text).toContain('<key>Umask</key>\n  <integer>63</integer>')
  })
})

describe('task scheduler XML', () => {
  it('starts at boot as LocalService, restarts on failure and escapes values', () => {
    const win = layoutFor('win32', { ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' })
    const text = renderTaskXml({
      ...unit,
      command: ['C:\\Program Files\\nodejs\\node.exe', `${win.programDir}\\dist\\cli.cjs`],
      config: win.configFile,
      dataDir: 'C:\\ProgramData\\Mongo Manager & Co\\data',
      user: 'S-1-5-19',
      envFile: null,
      logFile: win.logFile,
    })
    expect(text).toContain('<BootTrigger>')
    expect(text).toContain('<UserId>S-1-5-19</UserId>')
    expect(text).toContain('<RestartOnFailure>')
    expect(text).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    // Security review 2026-10-20 (minor 5): quoted, so a C:\Program.exe is never what runs.
    expect(text).toContain('<Command>"C:\\Program Files\\nodejs\\node.exe"</Command>')
    expect(text).toContain(
      '<Arguments>"C:\\Program Files\\Mongo Manager\\app\\dist\\cli.cjs" start --config "C:\\ProgramData\\Mongo Manager\\config.json" --no-open --log-file "C:\\ProgramData\\Mongo Manager\\logs\\mongo-manager.log"</Arguments>',
    )
    expect(text).toContain(
      '<WorkingDirectory>C:\\ProgramData\\Mongo Manager &amp; Co\\data</WorkingDirectory>',
    )
  })
})

describe('input validation (Review Focus 2)', () => {
  it('refuses values that could break out of a unit, plist or command line', () => {
    expect(() => checkUserName('mongo-manager')).not.toThrow()
    expect(() => checkUserName('_mongomanager')).not.toThrow()
    for (const bad of ['root; rm -rf /', 'Admin', '', 'a'.repeat(40), '-x'])
      expect(() => checkUserName(bad)).toThrow()
    expect(() => checkPathSafe('/usr/local/bin/node', 'linux')).not.toThrow()
    expect(() => checkPathSafe('/opt/My App/node', 'linux')).not.toThrow()
    expect(() => checkPathSafe('C:\\Program Files\\nodejs\\node.exe', 'win32')).not.toThrow()
    for (const bad of ['/x/"y', '/x/%h', '/x/$HOME', '/x/a\nb', '/x/a\\b'])
      expect(() => checkPathSafe(bad, 'linux')).toThrow()
    for (const bad of ['C:\\x"y', 'C:\\a\nb', 'C:\\%TEMP%\\x'])
      expect(() => checkPathSafe(bad, 'win32')).toThrow()
    expect(checkPort('8080')).toBe(8080)
    for (const bad of ['80', '0', '70000', 'x']) expect(() => checkPort(bad)).toThrow()
  })
})

describe('service config', () => {
  it('defaults to team mode on loopback and keeps an existing file, changing only given options (Review Focus 1)', () => {
    const fresh = JSON.parse(serviceConfigJson(null, {}, linux))
    expect(fresh).toEqual({
      webPort: 4321,
      host: '127.0.0.1',
      auth: true,
      open: false,
      dataDir: '/var/lib/mongo-manager',
      logLevel: 'info',
    })
    const existing = JSON.stringify({ ...fresh, readOnly: true, allowedHosts: ['mm.example.com'] })
    const updated = JSON.parse(serviceConfigJson(existing, { webPort: 8080 }, linux))
    expect(updated).toMatchObject({
      webPort: 8080,
      readOnly: true,
      allowedHosts: ['mm.example.com'],
      auth: true,
    })
  })
})

describe('service config file contents', () => {
  it('holds only server settings, never the account name (the server parses it strictly)', () => {
    const json = JSON.parse(serviceConfigJson(null, { user: 'mongo-manager', webPort: 8080 } as never, linux))
    expect(json).not.toHaveProperty('user')
    expect(json.webPort).toBe(8080)
  })
})
