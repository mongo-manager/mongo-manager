import { win32 } from 'node:path'
import type { Io } from '../io'
import { inspectStateRoot, prepareStateRoot } from './acl'
import {
  assertKeyNotLost,
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
import { runPowerShell } from './powershell'
import { renderTaskXml, serviceConfigJson, type ServiceOptions } from './render'
import type { Sys } from './sys'

// The task as Task Scheduler itself knows it, whatever the system's language (schtasks words its
// status in it): whether it is enabled and how many of its instances run (a disabled task's too);
// and how many processes run from the program folder (the server's shell workers end a moment after
// it; third review of the CI fix 2026-10-20, minor 8), the one asking aside (an install run from
// the installed copy: fifth review, important 1). Get-CimInstance is CimCmdlets'.
const TASK_STATE_SCRIPT = `'mm:task-state' | Out-Null
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$task = $null
try { $task = $service.GetFolder('\\').GetTask($in.name) } catch [System.IO.FileNotFoundException] { }
if ($task) { "enabled $($task.Enabled)"; "running $($task.GetInstances(0).Count)" }
$dir = $in.dir.TrimEnd('\\') + '\\'
"processes $(@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $in.self -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase) }).Count)"`

/** The task's state (null: none is registered) and what runs from the program folder. */
interface TaskState {
  task: { enabled: boolean; running: number } | null
  processes: number
}

/**
 * Why it could not be read, when it could not: never taken for a stopped server (third review of
 * the CI fix 2026-10-20, minor 1), nor a look that said nothing of the processes (fifth, minor 5).
 */
export function taskState(sys: Sys, layout: Layout): TaskState | { error: string } {
  const r = runPowerShell(
    sys,
    TASK_STATE_SCRIPT,
    { name: layout.unit, dir: layout.programDir, self: process.pid },
    ['CimCmdlets'],
  )
  if (!r.ok) return { error: r.error || 'no answer' }
  const value = (name: string) => r.lines.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1)
  const enabled = value('enabled')
  const running = value('running')
  const processes = value('processes')
  // A count that is not one is no answer (sixth review, minor 4).
  const count = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null)
  if (count(processes) === null) return { error: 'what runs from the program folder was not said' }
  if (enabled !== undefined && count(running) === null)
    return { error: 'its running instances were not said' }
  return {
    task: enabled !== undefined ? { enabled: /^true$/i.test(enabled), running: count(running)! } : null,
    processes: count(processes)!,
  }
}

const unreadable = (layout: Layout, nothing: string, error: string) =>
  new Error(
    `Windows could not read the scheduled task "${layout.unit}" and what runs from ` +
      `${layout.programDir} (${error}); nothing was ${nothing}.`,
  )

const STOP_WAIT_MS = 30_000

/**
 * Ends the task's server and waits until it and what it runs have stopped: an end only asks, and a
 * server still running would keep serving its old program or config, or hold the files a removal
 * deletes (review of the CI fix 2026-10-20, minor 1). The wait is timed by the clock, whatever each
 * look takes (third review, minor 2).
 */
function endTask(sys: Sys, layout: Layout): 'stopped' | 'running' | { error: string } {
  sys.run('schtasks', ['/End', '/TN', layout.unit])
  const deadline = sys.now() + STOP_WAIT_MS
  for (;;) {
    const state = taskState(sys, layout)
    if ('error' in state) return state
    if ((state.task?.running ?? 0) === 0 && state.processes === 0) return 'stopped'
    if (sys.now() >= deadline) return 'running'
    sys.sleep(500)
  }
}

const notStopped = (layout: Layout, nothing: string, again: string) =>
  new Error(
    `The service did not stop within ${STOP_WAIT_MS / 1000} seconds; nothing was ${nothing}. ` +
      `Stop it (schtasks /End /TN "${layout.unit}"), then run service ${again} again.`,
  )

/** The state folder must be the administrators' own before anything private goes into it (Review Critical 1). */
function assertStateRootIsOurs(sys: Sys, layout: Layout): void {
  const logDir = win32.dirname(layout.logFile!)
  const problems = inspectStateRoot(sys, layout.stateRoot, [layout.dataDir, logDir, layout.configFile])
  if (problems.length > 0) {
    throw new Error(
      `${layout.stateRoot} cannot be trusted:\n  ${problems.join('\n  ')}\n` +
        'Another user may have created it to read the data or take over the service. Nothing was changed. ' +
        'Inspect it; if it is not yours, move it aside (it is never deleted automatically) and run the installer again.',
    )
  }
}

export async function installWindows(
  sys: Sys,
  io: Io,
  layout: Layout,
  opts: ServiceOptions,
  program: ProgramSource,
  probe: (url: string) => Promise<boolean>,
): Promise<void> {
  // Decide everything that can refuse before changing anything.
  assertStateRootIsOurs(sys, layout)
  assertKeyNotLost(sys, layout, false)
  const config = serviceConfigJson(
    sys.exists(layout.configFile) ? sys.read(layout.configFile) : null,
    opts,
    layout,
  )
  checkServiceConfig(config, layout)
  checkProgramLocation(sys, layout)
  // Run from the installed copy: its files are kept, since Windows cannot replace a running program.
  const inPlace = installedInPlace(layout, program)
  checkInPlace(sys, layout, program, inPlace)

  // A running server keeps its program files locked: on reinstall, stop it first, disabled so the
  // task's one-minute repetition cannot start it again mid-copy (re-registering enables it).
  const registered = sys.run('schtasks', ['/Query', '/TN', layout.unit]).status === 0
  // A task its administrator disabled stays disabled when the install stops short (review of the
  // CI fix 2026-10-20, minor 2); one that is registered and cannot be read stops it here.
  const before = registered ? taskState(sys, layout) : null
  if (before && 'error' in before) throw unreadable(layout, 'changed', before.error)
  const wasEnabled = before?.task?.enabled !== false
  const restart = () => {
    if (!registered || !wasEnabled) return
    // Fourth review of the CI fixes (minor 3): only a program in place is started again; one the
    // copy could not put back is said as not started.
    const exe = (name: string) => sys.exists(win32.join(layout.programDir, 'bin', name))
    if (!exe('node.exe') && !exe('mongo-manager.exe')) {
      io.stderr.write('The earlier service was not started again: no program is in place.\n')
      return
    }
    sys.run('schtasks', ['/Change', '/TN', layout.unit, '/ENABLE'])
    sys.run('schtasks', ['/Run', '/TN', layout.unit])
    io.stderr.write('The earlier service was started again.\n')
  }
  if (registered) {
    sys.run('schtasks', ['/Change', '/TN', layout.unit, '/DISABLE'])
    const ended = endTask(sys, layout)
    if (ended !== 'stopped') {
      if (wasEnabled) {
        sys.run('schtasks', ['/Change', '/TN', layout.unit, '/ENABLE'])
        sys.run('schtasks', ['/Run', '/TN', layout.unit])
      }
      throw ended === 'running'
        ? notStopped(layout, 'changed', 'install')
        : unreadable(layout, 'changed', ended.error)
    }
  }
  try {
    if (!inPlace) sys.copyProgram(program, layout.programDir)
  } catch (e) {
    // The earlier program is still in place (the copy puts it back on failure): restart it.
    restart()
    throw e
  }
  try {
    checkProgram(sys, layout, program)
  } catch (e) {
    // A program that fails the trust check is never started again.
    if (registered) io.stderr.write(STOPPED)
    throw e
  }
  try {
    await registerTask(sys, io, layout, program, config, probe)
  } catch (e) {
    // Registering made it an enabled task again: one its administrator had disabled is disabled
    // again (third review of the CI fix 2026-10-20, minor 3).
    if (registered && !wasEnabled) {
      // And the server its registration started is ended (fifth review, minor 4).
      sys.run('schtasks', ['/Change', '/TN', layout.unit, '/DISABLE'])
      if (endTask(sys, layout) !== 'stopped')
        io.stderr.write(
          `The task is disabled again, but the server it started may still run; stop it with schtasks /End /TN "${layout.unit}".\n`,
        )
    } else restart()
    throw e
  }
  if (registered && !wasEnabled)
    io.stderr.write('The service task had been disabled; this install enabled it again.\n')
}

async function registerTask(
  sys: Sys,
  io: Io,
  layout: Layout,
  program: ProgramSource,
  config: string,
  probe: (url: string) => Promise<boolean>,
): Promise<void> {
  // One elevated script creates the state folder with its final security (or takes over an
  // existing one only if it is the administrators' own and holds nothing foreign), then creates
  // the data and log folders the service may write to: no window for anyone else to get in.
  prepareStateRoot(sys, layout.stateRoot, [layout.dataDir, win32.dirname(layout.logFile!)])
  sys.write(layout.configFile, config, 0o600)

  // The task XML goes to the administrator's own temporary folder, which nobody else can reach
  // between writing it and registering it.
  const temp = sys.privateTempDir()
  const xmlPath = win32.join(temp, 'mongo-manager-task.xml')
  const xml = renderTaskXml({
    command: programCommand(layout, program),
    config: layout.configFile,
    dataDir: layout.dataDir,
    user: 'S-1-5-19',
    envFile: null,
    logFile: layout.logFile,
    // Updater: LocalService is shared with Windows' own services; the launcher's rule there is narrower.
    isolate: true,
  })
  // Task Scheduler reads UTF-16 XML.
  sys.write(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]), 0o600)
  try {
    must(sys, 'schtasks', ['/Create', '/TN', layout.unit, '/XML', xmlPath, '/F'])
  } finally {
    sys.remove(temp)
  }
  // Registering started it (its registration trigger): it is run, never ended here, since an end could
  // stop it while it writes its first key files (review of the CI fix 2026-10-20, minor 1). A running
  // one is left alone (IgnoreNew).
  must(sys, 'schtasks', ['/Run', '/TN', layout.unit])
  await waitHealthy(serviceUrl(config), probe, io)
  io.stdout.write(
    `Config: ${layout.configFile}\nData: ${layout.dataDir}\nLog: ${layout.logFile}\n` +
      `First run: the one-time setup token is in a file (an elevated prompt reads it): ${win32.join(layout.dataDir, 'setup-token')}\n`,
  )
}

export function uninstallWindows(
  sys: Sys,
  io: Io,
  layout: Layout,
  self = process.execPath,
  cwd = process.cwd(),
): void {
  // Fifth review of the CI fix 2026-10-20 (important 1): the folder it would remove runs it, or is
  // the prompt's folder, however the path to it is written: in another case, by a short (8.3) name,
  // or by another way to it (sixth and seventh reviews, minor 1).
  const forms = (path: string) => [path, sys.realpathNative(path)].map((p) => p.toLowerCase())
  // And what a failed install left beside it, removed too (eighth review, minor 1).
  const folders = [`${layout.programDir}.old`, `${layout.programDir}.new`, layout.programDir]
  const dirs = folders.flatMap(forms).map((d) => `${d}\\`)
  const inside = (path: string) => forms(path).some((p) => dirs.some((d) => `${p}\\`.startsWith(d)))
  if (inside(self))
    throw new Error(
      'Run service uninstall from the mongo-manager package' +
        // Seventh review (minor 5): only the standalone binary can be copied out to run.
        (win32.basename(self).toLowerCase() === 'mongo-manager.exe'
          ? ' (or copy bin\\mongo-manager.exe elsewhere and run it from there)'
          : '') +
        `, not from the installed copy: Windows cannot remove ${layout.programDir} while it runs from there.`,
    )
  if (inside(cwd))
    throw new Error(
      `Run service uninstall from another folder than ${cwd}: Windows cannot remove ${layout.programDir} ` +
        `from a prompt whose folder is in it (${cwd}).`,
    )
  // The task it keeps when it stops short is as it was: enabled and running again, unless its
  // administrator had disabled it (review of the CI fix 2026-10-20, minor 2).
  const registered = sys.run('schtasks', ['/Query', '/TN', layout.unit]).status === 0
  const before = taskState(sys, layout)
  if (registered && 'error' in before) throw unreadable(layout, 'removed', before.error)
  // A state it could not read enables nothing (sixth review, minor 2).
  const wasEnabled = !('error' in before) && before.task?.enabled !== false
  const asItWas = () => {
    if (!wasEnabled) return
    sys.run('schtasks', ['/Change', '/TN', layout.unit, '/ENABLE'])
    sys.run('schtasks', ['/Run', '/TN', layout.unit])
  }
  // Disabled first, so its one-minute repetition cannot start it again between the end and the
  // removal (review of the CI fix 2026-10-20, minor 2).
  sys.run('schtasks', ['/Change', '/TN', layout.unit, '/DISABLE'])
  const ended = endTask(sys, layout)
  if (ended !== 'stopped') {
    asItWas()
    throw ended === 'running'
      ? notStopped(layout, 'removed', 'uninstall')
      : unreadable(layout, 'removed', ended.error)
  }
  const removed = sys.run('schtasks', ['/Delete', '/TN', layout.unit, '/F'])
  const stillThere = removed.status !== 0 && sys.run('schtasks', ['/Query', '/TN', layout.unit]).status === 0
  if (stillThere) {
    asItWas()
    throw new Error(
      `Windows could not remove the scheduled task "${layout.unit}" (${(removed.stderr || removed.stdout).trim() || `exit ${removed.status}`}); ` +
        `nothing was removed. Run: schtasks /Delete /TN "${layout.unit}" /F`,
    )
  }
  // Third review of the CI fixes (minor 4): and what a failed install left beside it, which a later
  // install would otherwise take for the earlier program; the program last, so a removal that fails
  // leaves it in place, never an .old alone (fourth review, minor 4).
  for (const p of folders) {
    try {
      sys.remove(p)
    } catch (e) {
      // Something else holds it (another prompt in it, an editor): what was done, and what to do
      // (eighth review, minor 2).
      throw new Error(
        `The scheduled task was removed, but ${p} could not be: ${(e as Error).message}. ` +
          'Close what uses it and run service uninstall again.',
        { cause: e },
      )
    }
  }
  // The folder that held it, empty now, only tidied (eighth review, minor 3; ninth, important 1).
  const parent = win32.dirname(layout.programDir)
  const left = sys.removeEmptyDir(parent)
  io.stdout.write(
    `Mongo Manager was removed. Your data, config and key were kept:\n  ${layout.stateRoot}\n` +
      'Delete it yourself only if you no longer need it.\n' +
      (left ? `${parent} was left (${left}); remove it yourself if it is empty.\n` : ''),
  )
}

export const statusWindows = (sys: Sys, layout: Layout) =>
  sys.runInherit('schtasks', ['/Query', '/TN', layout.unit, '/V', '/FO', 'LIST'])

const TAIL_BYTES = 64 * 1024

export function logsWindows(sys: Sys, io: Io, layout: Layout, follow: boolean): number {
  // A link that leads nowhere is no "log yet" (ninth review, minor 2): it is why the server stops.
  const refused = sys.logFileProblem(layout.logFile!)
  if (refused && !sys.exists(layout.logFile!)) {
    io.stderr.write(`The server does not start: ${refused}\n`)
    return 1
  }
  if (!sys.exists(layout.logFile!)) {
    io.stderr.write(`No log yet at ${layout.logFile}\n`)
    return 1
  }
  // CI fixes, eighth review (minor 2): the task has no console; a log file the server refuses (and so
  // does not start) is said here, first.
  const problem = sys.logFileProblem(layout.logFile!)
  if (problem) io.stderr.write(`The server does not start: ${problem}\n`)
  const lines = sys.readTail(layout.logFile!, TAIL_BYTES).split(/\r?\n/)
  io.stdout.write(`${lines.slice(-201).join('\n')}\n`)
  if (follow) io.stderr.write('(-f is not supported on Windows; run the command again to see new lines)\n')
  return problem ? 1 : 0
}
