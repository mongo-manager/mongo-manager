// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  CLEANUP_MS,
  PORT_ATTEMPTS,
  portTaken,
  settleMs,
  slowStart,
  startRetrying,
} from './support/port-retry'
import { LAUNCH_MS, PRIMARY_MS, SET_START_MS, SERVER_START_MS, SLOW_STARTS } from './support/slowness'

/** Servers that fail to start with what `fails` gives, in turn, then start; and what was done. */
function servers(fails: unknown[], opts: { stopFails?: boolean; members?: () => EventEmitter[] } = {}) {
  const made: Array<{ started: boolean; stopped: unknown[] }> = []
  const said: string[] = []
  const make = () => {
    const state = { started: false, stopped: [] as unknown[] }
    made.push(state)
    said.push(`make ${made.length}`)
    const failure = fails.shift()
    return {
      state,
      servers: opts.members?.() as never,
      start: async () => {
        if (failure !== undefined) throw failure
        state.started = true
      },
      stop: async (o?: unknown) => {
        await new Promise((r) => setTimeout(r, 5))
        said.push(`stopped ${made.length}`)
        state.stopped.push(o)
        if (opts.stopFails) throw new Error('could not stop')
      },
    }
  }
  return { made, said, make }
}

const taken = (port: number) => new Error(`Port "${port}" already in use`)

/**
 * CI 2026-10-21: mongodb-memory-server picks a free port and lets it go, and mongod opens it a
 * moment later; another test file's server took it in between, and the file failed at its start.
 */
describe('starting a test MongoDB server', () => {
  it('starts another, on another port, when its port was taken, once the first is stopped', async () => {
    const { made, said, make } = servers([taken(40093)])
    const server = await startRetrying(make)
    expect(made).toHaveLength(2)
    expect(server.state).toBe(made[1])
    expect(made[1]!.started).toBe(true)
    // Its own folders, never a dbPath a test named (review of the port retry, minor 3).
    expect(made[0]!.stopped).toEqual([{ doCleanup: true }])
    expect(made[1]!.stopped).toEqual([])
    // Review of the port retry (minor 5): the next is made once the first is stopped.
    expect(said).toEqual(['make 1', 'stopped 1', 'make 2'])
  })

  it('gives up after a few tries, with the last failure', async () => {
    const { made, make } = servers(Array.from({ length: PORT_ATTEMPTS }, (_, i) => taken(40000 + i)))
    await expect(startRetrying(make)).rejects.toThrow(`Port "${40000 + PORT_ATTEMPTS - 1}" already in use`)
    expect(made).toHaveLength(PORT_ATTEMPTS)
    for (const m of made) expect(m.stopped).toEqual([{ doCleanup: true }])
  })

  it('tries once on any other failure', async () => {
    const { made, make } = servers([new Error('Instance Failed to start with "DBPathInUse"')])
    await expect(startRetrying(make)).rejects.toThrow('DBPathInUse')
    expect(made).toHaveLength(1)
    expect(made[0]!.stopped).toEqual([{ doCleanup: true }])
  })

  // CI 2026-10-22 (Windows): a server that did not start in its time, on a runner busy starting
  // others, is started again too, once the first is stopped — started SLOW_STARTS times at most,
  // which the start budgets give their time (review of the Windows hardening, M1; second round,
  // Minor 1; fourth, nit 1).
  it('starts another when the first did not start in time, up to SLOW_STARTS starts', async () => {
    const slow = () => new Error(`Instance failed to start within ${LAUNCH_MS}ms`)
    const first = servers([slow()])
    await startRetrying(first.make)
    expect(first.made.map((m) => m.started)).toEqual([false, true])
    expect(first.said).toEqual(['make 1', 'stopped 1', 'make 2'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const twice = servers([slow(), slow(), slow()])
    await expect(startRetrying(twice.make)).rejects.toThrow(`within ${LAUNCH_MS}ms`)
    expect(twice.made).toHaveLength(SLOW_STARTS)
    // Its count is the slow starts' (review of the Windows hardening, second round, nit 2).
    expect(warn.mock.calls.flat()).toEqual([
      `test MongoDB server: it did not start in time; starting again (2/${SLOW_STARTS})`,
    ])
    warn.mockRestore()
    // A port taken as well is still tried as many times as ports are.
    const mixed = servers([slow(), taken(40100)])
    await startRetrying(mixed.make)
    expect(mixed.made.map((m) => m.started)).toEqual([false, false, true])
  })

  it('knows a server or a set that did not start in time by what mongodb-memory-server says of it', () => {
    expect(slowStart(new Error('Instance failed to start within 10000ms'))).toBe(true)
    expect(slowStart('Instance failed to start within 60000ms')).toBe(true)
    // A set whose members started but chose no primary in time (review of the Windows hardening, M5).
    expect(
      slowStart(
        new Error(
          'Timed out after 30000ms while waiting for a Primary (where: "_initReplSet beforeRunning")',
        ),
      ),
    ).toBe(true)
    expect(slowStart(new Error('Instance Failed to start with "DBPathInUse"'))).toBe(false)
    expect(slowStart(undefined)).toBe(false)
  })

  // Review of the Windows hardening (I1, M1): a set's members still starting are waited for past
  // their own time, so none is left running; and the start budgets give two slow starts their time.
  it('waits for a set past its members’ time to start, and gives two slow starts their time', () => {
    expect(settleMs({})).toBeGreaterThan(LAUNCH_MS)
    // A member given a longer time is waited for past it (second round, nit 4).
    expect(settleMs({ opts: { instance: { launchTimeout: 90_000 } } })).toBeGreaterThan(90_000)
    // Two slow starts: a lone server's, and a set's with its wait for a primary (second round, Minor 1).
    expect(SERVER_START_MS).toBeGreaterThan(SLOW_STARTS * LAUNCH_MS)
    expect(SET_START_MS).toBeGreaterThan(SLOW_STARTS * (LAUNCH_MS + PRIMARY_MS))
    // A cleanup the library did not finish is waited for briefly, on each attempt, within a set's
    // budget still (third round, nit 5; fourth, Minor 4).
    expect(SLOW_STARTS * (LAUNCH_MS + PRIMARY_MS + CLEANUP_MS)).toBeLessThan(SET_START_MS)
  })

  // Review of the Windows hardening (second round, Minor 3): a set that chose no primary in time is
  // stopped and cleaned by the library itself; it is waited for, so the two never remove the same
  // folders at once.
  it('lets a set the library is cleaning up after no primary finish first', async () => {
    const member = Object.assign(new EventEmitter(), { state: 'stopped' })
    const { said, make } = servers(
      [
        new Error(
          'Timed out after 30000ms while waiting for a Primary (where: "_initReplSet beforeRunning")',
        ),
      ],
      { members: () => [member] },
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // Stopped once more on its way, then cleaned (third round, nit 6).
    setTimeout(() => member.emit('stateChange', 'stopped'), 10)
    setTimeout(() => {
      said.push('member cleaned')
      member.state = 'new'
      member.emit('stateChange', 'new')
    }, 30)
    await startRetrying(make)
    expect(said.slice(0, 3)).toEqual(['make 1', 'member cleaned', 'stopped 1'])
    expect(warn.mock.calls.flat()).toEqual([
      `test MongoDB server: it chose no primary in time; starting again (2/${SLOW_STARTS})`,
    ])
    warn.mockRestore()
  })

  // Review of the port retry (nit 7): a test that holds its server to one port gets it or fails.
  it('tries as many times as it is told', async () => {
    const { made, make } = servers([taken(27018), taken(27018)])
    await expect(startRetrying(make, 1)).rejects.toThrow('Port "27018" already in use')
    expect(made).toHaveLength(1)
  })

  // Review of the port retry (minor 5): a stop that fails does not hide why the start did.
  it('says why the start failed, though the stop failed too', async () => {
    const { make } = servers([new Error('Instance Failed to start with "DBPathInUse"')], { stopFails: true })
    await expect(startRetrying(make)).rejects.toThrow('DBPathInUse')
  })

  // Review of the port retry (important 1): a set whose member failed is stopped only once its
  // other members are done starting, so none is left running.
  it('stops a replica set once its other members are done starting', async () => {
    const member = Object.assign(new EventEmitter(), { state: 'starting' })
    const ready = Object.assign(new EventEmitter(), { state: 'running' })
    const { said, make } = servers([taken(1)], { members: () => [member, ready] })
    setTimeout(() => {
      said.push('member started')
      member.state = 'running'
      member.emit('stateChange', 'running')
    }, 30)
    await startRetrying(make)
    expect(said.slice(0, 3)).toEqual(['make 1', 'member started', 'stopped 1'])
  })

  it('knows a taken port by what mongodb-memory-server says of it, on Linux and on Windows', () => {
    expect(portTaken(taken(1))).toBe(true)
    // On Windows mongod says it in the system's own words; its network error's exit code tells.
    expect(portTaken(new Error('Instance closed unexpectedly with code "48" and signal "null"'))).toBe(true)
    expect(portTaken(new Error('Instance closed unexpectedly with code "1" and signal "null"'))).toBe(false)
    expect(portTaken(new Error('Instance Failed to start with "DBPathInUse"'))).toBe(false)
    expect(portTaken(new Error('Data directory already in use by another process'))).toBe(false)
    expect(portTaken('Port "1" already in use')).toBe(true)
    expect(portTaken(undefined)).toBe(false)
  })
})
