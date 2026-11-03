import { posix } from 'node:path'
import type { Io } from '../io'
import {
  accountGroup,
  assertKeyNotLost,
  chownTree,
  checkProgram,
  checkProgramLocation,
  checkInPlace,
  installedInPlace,
  STOPPED,
  programCommand,
  checkServiceConfig,
  must,
  serviceUrl,
  waitHealthy,
  type ProgramSource,
} from './common'
import type { Layout } from './layout'
import { renderLaunchdPlist, serviceConfigJson, type ServiceOptions } from './render'
import type { Sys } from './sys'

const LABEL = 'com.mongo-manager.server'

const ids = (text: string) =>
  new Set(
    text
      .split('\n')
      .map((l) => Number(l.trim().split(/\s+/).at(-1)))
      .filter(Number.isInteger),
  )

function ensureAccount(sys: Sys, user: string): void {
  if (sys.run('dscl', ['.', '-read', `/Users/${user}`]).status === 0) return
  const used = new Set([
    ...ids(sys.run('dscl', ['.', '-list', '/Users', 'UniqueID']).stdout),
    ...ids(sys.run('dscl', ['.', '-list', '/Groups', 'PrimaryGroupID']).stdout),
  ])
  let id = 400
  while (used.has(id) && id < 500) id++
  if (id >= 500)
    throw new Error('No free account id between 400 and 499; create the account yourself and pass --user')
  must(sys, 'dseditgroup', ['-o', 'create', '-i', String(id), '-r', 'Mongo Manager', user])
  const set = (key: string, value: string) =>
    must(sys, 'dscl', ['.', '-create', `/Users/${user}`, key, value])
  must(sys, 'dscl', ['.', '-create', `/Users/${user}`])
  set('UniqueID', String(id))
  set('PrimaryGroupID', String(id))
  set('UserShell', '/usr/bin/false')
  set('RealName', 'Mongo Manager')
  set('NFSHomeDirectory', '/var/empty')
  set('Password', '*')
  set('IsHidden', '1')
}

export async function installDarwin(
  sys: Sys,
  io: Io,
  layout: Layout,
  opts: ServiceOptions & { user: string },
  program: ProgramSource,
  probe: (url: string) => Promise<boolean>,
): Promise<void> {
  const { user } = opts
  // Decide everything that can refuse before changing anything (Review Focus 1).
  assertKeyNotLost(sys, layout, false)
  const config = serviceConfigJson(
    sys.exists(layout.configFile) ? sys.read(layout.configFile) : null,
    opts,
    layout,
  )
  checkServiceConfig(config, layout)
  checkProgramLocation(sys, layout)
  const inPlace = installedInPlace(layout, program)
  checkInPlace(sys, layout, program, inPlace)

  ensureAccount(sys, user)
  const group = accountGroup(sys, user)
  sys.mkdir(layout.stateRoot, 0o755)
  if (!inPlace) sys.copyProgram(program, layout.programDir)
  try {
    checkProgram(sys, layout, program)
  } catch (e) {
    // The unit would otherwise restart into files that failed the check.
    sys.run('launchctl', ['bootout', `system/${LABEL}`])
    io.stderr.write(STOPPED)
    throw e
  }
  sys.mkdir(layout.dataDir, 0o700)
  chownTree(sys, layout.dataDir, user, group)
  const logDir = posix.dirname(layout.logFile!)
  sys.mkdir(logDir, 0o750)
  chownTree(sys, logDir, user, group)
  sys.write(layout.configFile, config, 0o640)
  must(sys, 'chown', [`root:${group}`, layout.configFile])
  sys.write(
    layout.unit,
    renderLaunchdPlist({
      command: programCommand(layout, program),
      config: layout.configFile,
      dataDir: layout.dataDir,
      user,
      group,
      envFile: null,
      logFile: layout.logFile,
      // Updater: only the account made for the service is the app's alone.
      isolate: user === layout.defaultUser,
    }),
    0o644,
  )
  sys.run('launchctl', ['bootout', `system/${LABEL}`])
  must(sys, 'launchctl', ['bootstrap', 'system', layout.unit])
  await waitHealthy(serviceUrl(config), probe, io)
  io.stdout.write(
    `Config: ${layout.configFile}\nData: ${layout.dataDir}\n` +
      `First run: the one-time setup token is in a file: sudo cat "${posix.join(layout.dataDir, 'setup-token')}"\n`,
  )
}

export function uninstallDarwin(sys: Sys, io: Io, layout: Layout): void {
  const out = sys.run('launchctl', ['bootout', `system/${LABEL}`])
  if (out.status !== 0 && sys.run('launchctl', ['print', `system/${LABEL}`]).status === 0) {
    throw new Error(
      `launchd could not stop ${LABEL} (${(out.stderr || out.stdout).trim() || `exit ${out.status}`}); nothing was removed. ` +
        `Run: sudo launchctl bootout system/${LABEL}`,
    )
  }
  sys.remove(layout.unit)
  // Third review of the CI fixes (minor 4): and what a failed install left beside it, which a later
  // install would otherwise take for the earlier program; the program last, so a removal that fails
  // leaves it in place, never an .old alone (fourth review, minor 4).
  for (const p of [`${layout.programDir}.old`, `${layout.programDir}.new`, layout.programDir]) sys.remove(p)
  io.stdout.write(
    `Mongo Manager was removed. Your data, config and key were kept:\n  ${layout.stateRoot}\n` +
      'Delete it yourself only if you no longer need it.\n',
  )
}

export const statusDarwin = (sys: Sys) => sys.runInherit('launchctl', ['print', `system/${LABEL}`])
export const logsDarwin = (sys: Sys, layout: Layout, follow: boolean) =>
  sys.runInherit('tail', ['-n', '200', ...(follow ? ['-f'] : []), layout.logFile!])
