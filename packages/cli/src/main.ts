import { resolve } from 'node:path'
import { appendLogLine } from '@mongo-manager/server'
import { UsageError, loadConfig, parseCli } from './args'
import { HELP } from './commands/help'
import { start } from './commands/start'
import { forgetBrowsersCommand, openCommand } from './commands/open'
import { doctor } from './commands/doctor'
import { rotateKeyCommand } from './commands/rotateKey'
import { serviceCommand } from './commands/service'
import { userCommand } from './commands/user'
import { bansCommand } from './commands/bans'
import { accessCommand } from './commands/access'
import { backupCommand } from './commands/backup'
import type { Io } from './io'
import { realSys } from './service/sys'
import { VERSION } from './version'

/**
 * A service without a console (the Windows task) logs to a file: a start that fails before the
 * server's logger exists (bad config, wrong key, refused bind, port in use) must reach it too.
 */
function logStartFailure(logFile: string | undefined, message: string): void {
  if (!logFile) return
  try {
    // Opened as the server opens it (CI fixes, seventh review, important 1): a file the server
    // refused (a link, a pipe, one with other names) is never written to here either.
    appendLogLine(logFile, JSON.stringify({ level: 60, time: Date.now(), msg: `Start failed: ${message}` }))
  } catch {
    // Logging the failure must not hide it: it is on stderr anyway.
  }
}

export async function main(argv: string[], io: Io): Promise<number> {
  let startLog: string | undefined
  try {
    const { command, positionals, values } = parseCli(argv)
    if (command === 'start') {
      const file = values['log-file'] ?? io.env.MM_LOG_FILE
      startLog = file ? resolve(io.cwd, file) : undefined
    }
    if (values.version || command === 'version') {
      io.stdout.write(`mongo-manager ${VERSION} (node ${process.versions.node})\n`)
      return 0
    }
    if (values.help || command === 'help') {
      io.stdout.write(HELP)
      return 0
    }
    // Reads only the file it is given: no server configuration is needed (or loaded).
    if (command === 'backup') return await backupCommand(positionals, values, io)
    const config = loadConfig(values, io)
    switch (command) {
      case 'start':
        return await start(config, values, io)
      case 'open':
        return await openCommand(config, io)
      case 'forget-browsers':
        return await forgetBrowsersCommand(config, io)
      case 'user':
        return await userCommand(positionals, values, config, io)
      case 'bans':
        return await bansCommand(positionals, values, config, io)
      case 'access':
        return await accessCommand(positionals, config, io)
      case 'rotate-key':
        return await rotateKeyCommand(values, config, io)
      case 'doctor':
        return await doctor(config, io)
      case 'service':
        return await serviceCommand(positionals, values, io, { sys: realSys() })
      default:
        throw new UsageError(`Unknown command "${command}"`)
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`Error: ${e.message}\nRun "mongo-manager --help" for usage.\n`)
      logStartFailure(startLog, e.message)
      return 2
    }
    io.stderr.write(`Error: ${(e as Error).message}\n`)
    logStartFailure(startLog, (e as Error).message)
    return 1
  }
}
