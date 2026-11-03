import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, win32 } from 'node:path'
import { systemRoot } from '../windows-tools'

/**
 * Security audit 2026-10-16 (Important 2): a shell worker's resident memory, measured by the server
 * from the operating system — never from the worker's own word. A worker busy in synchronous code
 * answers no ping, and --max-old-space-size does not count ArrayBuffers, so its own report alone let
 * one fill hundreds of megabytes unseen. No native module is needed:
 *
 * - Linux: /proc/<pid>/status (VmRSS and VmSwap: memory pushed out to swap is still the worker's), a
 *   file read of a few microseconds — measured often;
 * - Windows: tasklist (about 0.1 s of a process start), one for every worker measured at the same
 *   moment — each second while a worker does not answer, every 30 seconds otherwise. It reports the
 *   working set: private bytes would need a native call or a PowerShell start several times slower,
 *   and the working set is what a balloon being filled grows;
 * - macOS and other POSIX systems: `ps -o rss=` for the one process, as often as on Windows.
 *
 * Where none of these works (a stripped system with no ps, say), the source is null and the server
 * falls back to the worker's own answers and the hang deadline (manager.ts).
 */
export interface RssSource {
  /** The process's resident memory in bytes, or null when it cannot be told (it is gone, say). */
  read(pid: number): Promise<number | null>
  /** How often to measure a worker that has not answered its ping. */
  busyMs: number
  /** How often to measure one that answers (its answers are not taken on trust). */
  idleMs: number
}

const KIB = 1024
/** How long one Windows process listing answers every worker's read. */
const LISTING_REUSE_MS = 500

/** VmRSS and VmSwap from /proc/<pid>/status, in bytes. */
export function parseProcStatus(text: string): number | null {
  const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(text)
  if (!rss) return null
  const swap = /^VmSwap:\s+(\d+)\s+kB/m.exec(text)
  return (Number(rss[1]) + (swap ? Number(swap[1]) : 0)) * KIB
}

/** The rss column of `ps -o rss= -p <pid>` (kibibytes), in bytes. */
export function parsePs(text: string): number | null {
  const value = text.trim()
  return /^\d+$/.test(value) ? Number(value) * KIB : null
}

/**
 * Every process's memory in a `tasklist /FO CSV /NH` listing, by pid, in bytes. The column is in KB
 * with the locale's digit grouping ("412.345 K", "412,345 K", "1 234 567 Ko"): its digits are the
 * number.
 */
export function parseTasklistAll(text: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of text.split(/\r?\n/)) {
    const fields = line.match(/"([^"]*)"/g)?.map((f) => f.slice(1, -1))
    if (!fields || fields.length < 5 || !/^\d+$/.test(fields[1]!)) continue
    const digits = fields[fields.length - 1]!.replace(/\D/g, '')
    if (digits) out.set(Number(fields[1]), Number(digits) * KIB)
  }
  return out
}

/** The memory column of `tasklist /FO CSV /NH` for one process, in bytes. */
export function parseTasklist(text: string, pid: number): number | null {
  return parseTasklistAll(text).get(pid) ?? null
}

type Run = (file: string, args: string[]) => Promise<string | null>

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) =>
      resolve(error ? null : String(stdout)),
    )
  })
}

/** How this platform's worker memory is measured, or null when it cannot be. */
export function rssSource(
  platform: NodeJS.Platform = process.platform,
  deps: { run?: Run; imageName?: string; systemRoot?: string } = {},
): RssSource | null {
  const exec = deps.run ?? run
  if (platform === 'linux')
    return {
      read: async (pid) => {
        try {
          return parseProcStatus(await readFile(`/proc/${pid}/status`, 'utf8'))
        } catch {
          return null
        }
      },
      busyMs: 200,
      idleMs: 1000,
    }
  if (platform === 'win32') {
    // By its full path: never a tasklist that happens to be first on the PATH.
    const root = deps.systemRoot ?? systemRoot()
    const tasklist = win32.join(root, 'System32', 'tasklist.exe')
    // The workers run this very executable (node.exe, or the SEA binary): one listing of its
    // processes answers every worker asked about in the same moment (review 2026-10-16, minor).
    const image = deps.imageName ?? basename(process.execPath)
    let batch: Promise<Map<number, number> | null> | null = null
    // Each worker's watch has its own timer: a listing serves every read for half a second, so
    // their reads share it though they seldom come in the same instant (second review 2026-10-16).
    let last: { at: number; listing: Promise<Map<number, number> | null> } | null = null
    const listing = (): Promise<Map<number, number> | null> => {
      if (last && Date.now() - last.at < LISTING_REUSE_MS) return last.listing
      batch ??= new Promise<void>((r) => setTimeout(r, 20))
        .then(() => exec(tasklist, ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${image}`]))
        .then((out) => (out === null ? null : parseTasklistAll(out)))
        .finally(() => {
          if (batch) last = { at: Date.now(), listing: batch }
          batch = null
        })
      return batch
    }
    return {
      read: async (pid) => (await listing())?.get(pid) ?? null,
      busyMs: 1000,
      idleMs: 30_000,
    }
  }
  return {
    read: async (pid) => {
      const out = await exec('/bin/ps', ['-o', 'rss=', '-p', String(pid)])
      return out === null ? null : parsePs(out)
    },
    busyMs: 1000,
    idleMs: 30_000,
  }
}
