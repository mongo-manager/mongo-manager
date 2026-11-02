import { spawn } from 'node:child_process'
import { browserCommand } from './open'

export interface Io {
  stdout: { write(chunk: string): unknown; isTTY?: boolean }
  stderr: { write(chunk: string): unknown; isTTY?: boolean }
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }
  env: Record<string, string | undefined>
  cwd: string
  platform: NodeJS.Platform
  /**
   * Opens a URL or a file in the browser; false when that visibly failed (no opener, or one that
   * gave up at once: a headless computer) — review of the audit fixes, minor 7.
   */
  openBrowser(target: string): Promise<boolean>
  /** Resolves when the process is asked to stop (SIGINT/SIGTERM). */
  waitForShutdown(): Promise<void>
}

export function processIo(): Io {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    openBrowser(target) {
      return new Promise<boolean>((resolve) => {
        try {
          const { cmd, args } = browserCommand(target, process.platform)
          const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true })
          // An opener that cannot open anything says so at once; one still running has handed over.
          const settled = setTimeout(() => resolve(true), 2_000)
          settled.unref()
          child.on('error', () => {
            clearTimeout(settled)
            resolve(false)
          })
          child.on('exit', (code) => {
            clearTimeout(settled)
            resolve(code === 0)
          })
          child.unref()
        } catch {
          resolve(false)
        }
      })
    },
    waitForShutdown: () =>
      new Promise((resolve) => {
        process.once('SIGINT', () => resolve())
        process.once('SIGTERM', () => resolve())
      }),
  }
}
