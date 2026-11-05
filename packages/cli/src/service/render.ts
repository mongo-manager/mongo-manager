// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { Layout } from './layout'

export interface UnitInput {
  /** The program and its leading arguments: the standalone binary, or Node and the bundle. */
  command: string[]
  config: string
  dataDir: string
  user: string
  /** The account's primary group (launchd needs it named); defaults to the user name. */
  group?: string
  envFile: string | null
  logFile: string | null
  /** More directories the systemd sandbox lets the server write into: the backup folder roots. */
  writablePaths?: string[]
  /** The account is the service's own: its launcher ends the account's other processes (updater). */
  isolate?: boolean
}

export function renderSystemdUnit(u: UnitInput): string {
  return `[Unit]
Description=Mongo Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${u.user}
${u.envFile ? `EnvironmentFile=${u.envFile}\n` : ''}ExecStart=${u.command.map((c) => `"${c}"`).join(' ')} start --config "${u.config}" --no-open${u.isolate ? ' --isolate-account' : ''}
WorkingDirectory=${u.dataDir}
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=${u.dataDir}
${(u.writablePaths ?? []).map((p) => `ReadWritePaths=-${p}\n`).join('')}CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
SystemCallArchitectures=native
MemoryMax=1G

[Install]
WantedBy=multi-user.target
`
}

/** Escapes element text (all values here are element content, never attributes). */
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function renderLaunchdPlist(u: UnitInput): string {
  const args = [
    ...u.command,
    'start',
    '--config',
    u.config,
    '--no-open',
    ...(u.isolate ? ['--isolate-account'] : []),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mongo-manager.server</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>UserName</key>
  <string>${xml(u.user)}</string>
  <key>GroupName</key>
  <string>${xml(u.group ?? u.user)}</string>
  <key>WorkingDirectory</key>
  <string>${xml(u.dataDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(u.logFile ?? '/dev/null')}</string>
  <key>StandardErrorPath</key>
  <string>${xml(u.logFile ?? '/dev/null')}</string>
</dict>
</plist>
`
}

export function renderTaskXml(u: UnitInput): string {
  const quote = (s: string) => `"${s}"`
  const args = [
    ...u.command.slice(1).map(quote),
    'start',
    '--config',
    quote(u.config),
    '--no-open',
    ...(u.logFile ? ['--log-file', quote(u.logFile)] : []),
    ...(u.isolate ? ['--isolate-account'] : []),
  ]
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Mongo Manager web UI</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <!-- Relaunch every minute if the server has exited (IgnoreNew leaves a running one alone):
           RestartOnFailure alone only covers a task that fails to start. -->
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </BootTrigger>
    <!-- CI 2026-10-20: a repetition starts when its trigger fires; the boot trigger's only at the
         next boot. Registering the task (the install) starts the same one now. -->
    <RegistrationTrigger>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </RegistrationTrigger>
  </Triggers>
  <Principals>
    <Principal id="Service">
      <UserId>${xml(u.user)}</UserId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Service">
    <Exec>
      <Command>${xml(quote(u.command[0]!))}</Command>
      <Arguments>${xml(args.join(' '))}</Arguments>
      <WorkingDirectory>${xml(u.dataDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

export interface ServiceOptions {
  webPort?: number
  host?: string
  auth?: boolean
  basePath?: string
  allowedHosts?: string[]
  trustedProxies?: string[]
  readOnly?: boolean
  logLevel?: string
  /** --shell / --no-shell: switches the advanced shell, keeping the file's other shell settings. */
  shell?: boolean
}

const CONFIG_KEYS = [
  'webPort',
  'host',
  'auth',
  'basePath',
  'allowedHosts',
  'trustedProxies',
  'readOnly',
  'logLevel',
] as const satisfies ReadonlyArray<keyof ServiceOptions>

/**
 * The service's config file. A new one: team mode on loopback. An existing one is kept and only
 * the options given on the command line change, so reinstalling never undoes an admin's edits.
 */
export function serviceConfigJson(existing: string | null, opts: ServiceOptions, layout: Layout): string {
  const base = existing
    ? (JSON.parse(existing) as Record<string, unknown>)
    : { webPort: 4321, host: '127.0.0.1', auth: true, open: false, dataDir: layout.dataDir, logLevel: 'info' }
  const next: Record<string, unknown> = { ...base }
  // Only server settings go into the file: it is parsed strictly, so e.g. the account name must not.
  for (const k of CONFIG_KEYS) if (opts[k] !== undefined) next[k] = opts[k]
  if (opts.shell !== undefined) {
    const shell = next.shell
    next.shell = {
      ...(typeof shell === 'object' && shell !== null && !Array.isArray(shell) ? shell : {}),
      enabled: opts.shell,
    }
  }
  // The Windows task has no console to log to: its log goes to a file.
  if (layout.platform === 'win32' && layout.logFile && next.logFile === undefined)
    next.logFile = layout.logFile
  return `${JSON.stringify(next, null, 2)}\n`
}
