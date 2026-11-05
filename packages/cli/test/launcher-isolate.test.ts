// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { describe, expect, it } from 'vitest'
import {
  endAccountProcesses,
  parseProcStatus,
  parseWindowsList,
  type ProcInfo,
  type ProcessSys,
} from '../src/launcher/isolate'

/** A process table that forgets a process once it is killed; `stubborn` ones never go. */
function fakeSys(table: ProcInfo[], stubborn: number[] = []): ProcessSys & { killed: number[] } {
  let live = [...table]
  const killed: number[] = []
  return {
    killed,
    list: async () => live,
    kill: (pid) => {
      killed.push(pid)
      if (!stubborn.includes(pid)) live = live.filter((p) => p.pid !== pid)
    },
    alive: (pid) => live.some((p) => p.pid === pid),
    sleep: async () => {},
  }
}
const sorted = (n: number[]) => [...n].sort((a, b) => a - b)

describe('ending the account’s other processes (updater, design §7b-1)', () => {
  it('Linux/Docker: every process of the account but this one and its ancestors', async () => {
    const sys = fakeSys([
      { pid: 1, ppid: 0, uid: 10001 }, // tini
      { pid: 7, ppid: 1, uid: 10001 }, // the launcher
      { pid: 9, ppid: 7, uid: 10001 }, // the old program
      { pid: 30, ppid: 1, uid: 10001 }, // a shell left behind
      { pid: 40, ppid: 1, uid: 0 }, // root's
    ])
    const r = await endAccountProcesses({ platform: 'linux', self: 7, uid: 10001, sys })
    expect(r).toEqual({ ended: 2, survivors: [] })
    expect(sorted(sys.killed)).toEqual([9, 30])
  })

  it('macOS: the same rule', async () => {
    const sys = fakeSys([
      { pid: 1, ppid: 0, uid: 0 },
      { pid: 50, ppid: 1, uid: 260 },
      { pid: 51, ppid: 50, uid: 260 },
      { pid: 52, ppid: 1, uid: 501 },
    ])
    expect((await endAccountProcesses({ platform: 'darwin', self: 50, uid: 260, sys })).ended).toBe(1)
    expect(sys.killed).toEqual([51])
  })

  // Final review (I3): root's processes are the machine's.
  it('never as root, whatever the account rule says', async () => {
    const sys = fakeSys([
      { pid: 1, ppid: 0, uid: 0 },
      { pid: 7, ppid: 1, uid: 0 },
      { pid: 80, ppid: 1, uid: 0 },
    ])
    expect(await endAccountProcesses({ platform: 'linux', self: 7, uid: 0, sys })).toEqual({
      ended: 0,
      survivors: [],
    })
    expect(sys.killed).toEqual([])
  })

  it('says which processes would not end', async () => {
    const sys = fakeSys(
      [
        { pid: 7, ppid: 1, uid: 10001 },
        { pid: 30, ppid: 1, uid: 10001 },
      ],
      [30],
    )
    expect(await endAccountProcesses({ platform: 'linux', self: 7, uid: 10001, sys })).toEqual({
      ended: 1,
      survivors: [30],
    })
  })

  // Final review (I4): LocalService is shared — only this install's programs and the previous
  // program's own tree (by its start time, never through a pid used again) are ended.
  it('Windows: the previous program’s tree and the service account’s programs of this install, nothing else', async () => {
    const ls = 'S-1-5-19'
    const root = 'C:\\ProgramData\\mongo-manager'
    const sys = fakeSys([
      { pid: 4, ppid: 0, created: 0 },
      { pid: 800, ppid: 4, sid: ls, exe: 'C:\\Windows\\System32\\svchost.exe', created: 100 },
      { pid: 900, ppid: 800, sid: ls, exe: `${root}\\app\\node.exe`, created: 1000 }, // the launcher
      // The previous program (910, started at 4000) is gone; what it started is not.
      { pid: 911, ppid: 910, exe: 'C:\\Windows\\System32\\conhost.exe', created: 5000 },
      { pid: 912, ppid: 910, sid: ls, exe: `${root}\\app\\node.exe`, created: 5000 },
      {
        pid: 913,
        ppid: 912,
        exe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        created: 6000,
      },
      // A process whose long-gone parent had that pid before the previous program started.
      { pid: 914, ppid: 910, sid: ls, exe: 'C:\\Windows\\System32\\svchost.exe', created: 100 },
      { pid: 950, ppid: 800, sid: ls, exe: `${root}\\data\\left-behind.exe`, created: 7000 },
      { pid: 951, ppid: 800, sid: ls, exe: 'C:\\Program Files\\SQL Server\\sqlbrowser.exe', created: 200 },
      { pid: 960, ppid: 800, sid: 'S-1-5-20', exe: `${root}\\other.exe`, created: 7000 },
    ])
    const r = await endAccountProcesses({
      platform: 'win32',
      self: 900,
      previous: { pid: 910, startedAt: 4000 },
      roots: [root],
      sys,
    })
    expect(sorted(sys.killed)).toEqual([911, 912, 913, 950])
    expect(r.ended).toBe(4)
  })

  it('Windows: a pid used again by another process is not taken for the previous program', async () => {
    const sys = fakeSys([
      { pid: 900, ppid: 1, sid: 'S-1-5-19', exe: 'C:\\mm\\node.exe', created: 1000 },
      { pid: 910, ppid: 1, sid: 'S-1-5-18', exe: 'C:\\Windows\\System32\\other.exe', created: 9000 },
      { pid: 920, ppid: 910, sid: 'S-1-5-18', exe: 'C:\\Windows\\System32\\child.exe', created: 9500 },
    ])
    await endAccountProcesses({
      platform: 'win32',
      self: 900,
      previous: { pid: 910, startedAt: 4000 },
      roots: ['C:\\mm'],
      sys,
    })
    expect(sys.killed).toEqual([])
  })

  it('Windows: a person’s own account is never ended whole, only the previous tree', async () => {
    const me = 'S-1-5-21-1-2-3-1001'
    const sys = fakeSys([
      { pid: 900, ppid: 1, sid: me, exe: 'C:\\nvm\\node.exe', created: 1000 },
      { pid: 911, ppid: 910, sid: me, exe: 'C:\\nvm\\node.exe', created: 5000 },
      { pid: 950, ppid: 1, sid: me, exe: 'C:\\nvm\\editor.exe', created: 200 },
    ])
    await endAccountProcesses({
      platform: 'win32',
      self: 900,
      previous: { pid: 910, startedAt: 4000 },
      roots: ['C:\\nvm'],
      sys,
    })
    expect(sys.killed).toEqual([911])
  })

  it('reads /proc status files and the Windows list', () => {
    expect(parseProcStatus('Name:\tnode\nPPid:\t7\nUid:\t10001\t10001\t10001\t10001\n', 9)).toEqual({
      pid: 9,
      ppid: 7,
      uid: 10001,
    })
    expect(parseProcStatus('Name:\tx\n', 9)).toBeNull()
    expect(
      parseWindowsList([
        '4|0|0||',
        '900|800|1700000000000|S-1-5-19|C:\\ProgramData\\mongo-manager\\node.exe',
        'junk',
      ]),
    ).toEqual([
      { pid: 4, ppid: 0, created: 0 },
      {
        pid: 900,
        ppid: 800,
        created: 1_700_000_000_000,
        sid: 'S-1-5-19',
        exe: 'C:\\ProgramData\\mongo-manager\\node.exe',
      },
    ])
  })
})
