// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { win32 } from 'node:path'
import { powershellArgs, powershellEnv, systemRoot, windowsTool } from '@mongo-manager/server/windows-tools'
import type { IsolateResult, PreviousChild } from './run'

/**
 * Updater, design §7b-1 (2026-11-03): before a downloaded version is checked and runs where the
 * account is the app's own (the Docker image's user, a service's account), the account's other
 * processes are ended — whatever was left running there could otherwise change the files between
 * their check and their start. Root never ends anything (its processes are the machine's). Windows'
 * LocalService is shared with Windows' own services and others' (final review, I4): there only the
 * previous program's tree, by its start time, and the account's programs inside this install and
 * its data directory are ended; a program the account started elsewhere is not.
 */
export interface ProcInfo {
  pid: number
  ppid: number
  uid?: number
  sid?: string
  exe?: string
  /** Windows: when it started (ms since the epoch). */
  created?: number
}

export interface ProcessSys {
  list(): Promise<ProcInfo[]>
  kill(pid: number): void
  /** Whether a process of that pid is still there. */
  alive(pid: number): boolean
  sleep(ms: number): Promise<void>
}

/** The service accounts a service install runs as: only these have their programs ended on Windows. */
const SERVICE_SIDS = new Set(['S-1-5-19', 'S-1-5-20'])

/** How long the ended processes have to be gone. */
const GONE_MS = 2_000
/** Windows' clock and a process's start time may differ by this much. */
const CLOCK_SLACK_MS = 2_000

function ancestorsOf(self: number, table: ProcInfo[]): Set<number> {
  const byPid = new Map(table.map((p) => [p.pid, p]))
  const seen = new Set<number>([self])
  for (let p = byPid.get(self); p && p.ppid > 0 && !seen.has(p.ppid); p = byPid.get(p.ppid)) seen.add(p.ppid)
  return seen
}

/**
 * What the previous program started, still running after it ended (Windows adopts no orphan): its
 * pid's children and theirs, each started after it. A process now holding that pid is another
 * program (the pid was used again): then nothing is taken for the previous program's.
 */
function previousTree(previous: PreviousChild, table: ProcInfo[]): Set<number> {
  const tree = new Set<number>()
  if (table.some((p) => p.pid === previous.pid)) return tree
  const after = (p: ProcInfo) => (p.created ?? 0) >= previous.startedAt - CLOCK_SLACK_MS
  const parents = new Set<number>([previous.pid])
  for (let grew = true; grew;) {
    grew = false
    for (const p of table)
      if (parents.has(p.ppid) && !parents.has(p.pid) && after(p)) {
        parents.add(p.pid)
        tree.add(p.pid)
        grew = true
      }
  }
  return tree
}

const insideFolder = (path: string, folder: string) =>
  path.toLowerCase().startsWith(`${folder.replace(/\\+$/, '')}\\`.toLowerCase())

/** Ends the processes the rule names and waits a moment for them to be gone. */
export async function endAccountProcesses(opts: {
  platform: NodeJS.Platform
  self: number
  /** POSIX: this process's real uid. */
  uid?: number
  /** Windows: the previous program, whose tree is ended. */
  previous?: PreviousChild
  /** Windows: this install's folder and its data directory. */
  roots?: string[]
  sys: ProcessSys
}): Promise<IsolateResult> {
  if (opts.platform !== 'win32' && (opts.uid === undefined || opts.uid === 0))
    return { ended: 0, survivors: [] }
  const table = await opts.sys.list()
  const keep = ancestorsOf(opts.self, table)
  const targets = new Set<number>()
  if (opts.platform === 'win32') {
    if (opts.previous) for (const pid of previousTree(opts.previous, table)) targets.add(pid)
    const sid = table.find((p) => p.pid === opts.self)?.sid
    // A person's own account (someone giving --isolate-account by hand) never has its programs ended.
    if (sid && SERVICE_SIDS.has(sid))
      for (const p of table)
        if (
          p.sid === sid &&
          p.exe &&
          win32.isAbsolute(p.exe) &&
          (opts.roots ?? []).some((root) => insideFolder(p.exe!, root))
        )
          targets.add(p.pid)
  } else {
    for (const p of table) if (p.uid === opts.uid) targets.add(p.pid)
  }
  for (const pid of keep) targets.delete(pid)
  let ended = 0
  for (const pid of targets) {
    try {
      opts.sys.kill(pid)
      ended++
    } catch {
      // Gone already, or not ours to end: it is named below if it is still there.
    }
  }
  for (let waited = 0; waited < GONE_MS && targets.size > 0; waited += 100) {
    if (![...targets].some((pid) => opts.sys.alive(pid))) break
    await opts.sys.sleep(100)
  }
  return { ended, survivors: [...targets].filter((pid) => opts.sys.alive(pid)) }
}

/** A /proc/<pid>/status file: its parent and real uid. */
export function parseProcStatus(text: string, pid: number): ProcInfo | null {
  const ppid = /^PPid:\s+(\d+)/m.exec(text)
  const uid = /^Uid:\s+(\d+)/m.exec(text)
  return ppid && uid ? { pid, ppid: Number(ppid[1]), uid: Number(uid[1]) } : null
}

/** The Windows script's lines: "pid|ppid|created|sid|exe". */
export function parseWindowsList(lines: string[]): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const line of lines) {
    const m = /^(\d+)\|(\d+)\|(\d+)\|([^|]*)\|(.*)$/.exec(line.trim())
    if (!m) continue
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      created: Number(m[3]),
      ...(m[4] ? { sid: m[4] } : {}),
      ...(m[5] ? { exe: m[5] } : {}),
    })
  }
  return out
}

/** A listing that hangs (WMI) must not keep a service from starting: it ends in a minute. */
const LIST_TIMEOUT_MS = 60_000

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      cmd,
      args,
      { env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: LIST_TIMEOUT_MS },
      (e, stdout) => (e ? reject(e) : resolve(stdout)),
    ),
  )

/**
 * Every process with its parent and start time, and on Windows its owner and program — the owner
 * asked only for programs outside the Windows folder (asking each is slow).
 */
const WINDOWS_LIST = `Get-CimInstance -ClassName Win32_Process | ForEach-Object {
  $sid = ''
  $exe = [string]$_.ExecutablePath
  $created = 0
  if ($_.CreationDate) { $created = [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }
  if ($exe -and -not $exe.StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase)) {
    try { $sid = [string](Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop).Sid } catch { $sid = '' }
  }
  '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $created, $sid, $exe
}`

export function realProcessSys(platform: NodeJS.Platform = process.platform): ProcessSys {
  const kill = (pid: number) => process.kill(pid, 'SIGKILL')
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      // EPERM: there, but another account's.
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  if (platform === 'linux')
    return {
      kill,
      alive,
      sleep,
      list: async () => {
        const out: ProcInfo[] = []
        for (const name of readdirSync('/proc')) {
          if (!/^\d+$/.test(name)) continue
          try {
            const p = parseProcStatus(readFileSync(`/proc/${name}/status`, 'utf8'), Number(name))
            if (p) out.push(p)
          } catch {
            // Gone while listed.
          }
        }
        return out
      },
    }
  if (platform === 'win32')
    return {
      kill,
      alive,
      sleep,
      list: async () => {
        const root = systemRoot()
        // The folder is the kernel's answer (or a checked SystemRoot), quoted as PowerShell quotes.
        const script = `$root = '${root.replace(/'/g, "''")}'\n${WINDOWS_LIST}`
        const stdout = await run(
          windowsTool('powershell'),
          powershellArgs(script, ['CimCmdlets']),
          powershellEnv(),
        )
        return parseWindowsList(stdout.split(/\r?\n/))
      },
    }
  return {
    kill,
    alive,
    sleep,
    list: async () =>
      (await run('/bin/ps', ['-axo', 'pid=,ppid=,uid=']))
        .split('\n')
        .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]) })),
  }
}

/** For the launcher: the rule of this platform, with this process's own identity. */
export function isolateAccount(previous: PreviousChild | undefined, roots: string[]): Promise<IsolateResult> {
  return endAccountProcesses({
    platform: process.platform,
    self: process.pid,
    ...(process.getuid ? { uid: process.getuid() } : {}),
    ...(previous ? { previous } : {}),
    roots,
    sys: realProcessSys(),
  })
}
