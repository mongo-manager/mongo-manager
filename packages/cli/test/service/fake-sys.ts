import type { Sys } from '../../src/service/sys'
import { elf64, macho64 } from './binaries'

export interface FakeSys extends Sys {
  commands: string[]
  files: Map<string, { content: string; mode: number }>
  dirs: Map<string, number>
  responses: Array<{ match: RegExp; status: number; stdout?: string }>
  /**
   * POSIX ownership for trust checks: missing entries are root-owned 0755, even a path that does not
   * exist, unlike a real system (re-review 2026-10-18, minor 11): set null for one a test needs gone.
   */
  stats: Map<string, { uid: number; gid?: number; mode: number } | null>
  realpaths: Map<string, string>
  /**
   * Symbolic links, with their own owners in linkStats: what one leads to is its realpaths entry, and
   * one with none leads nowhere. A path with a realpaths entry of its own is a link too.
   */
  links: Set<string>
  linkStats: Map<string, { uid: number; gid?: number; mode: number }>
  /** Every task XML written (decoded), even after its file is removed. */
  writtenXml: string[]
  /** Executable contents by path (sources and copies); others read as an official Node build. */
  binaries: Map<string, Buffer>
  /** Why the server would refuse a log file, by path (none: it takes it). */
  logProblems: Map<string, string>
  /** Called at each sleep (recorded as `sleep <ms>`): a test changes what the system says next. */
  onSleep?: () => void
  /** Called with each command line run, before it is answered. */
  onRun?: (line: string) => void
  /** Long names of short (8.3) ones, as only the system's own resolving gives them. */
  longNames: Map<string, string>
}

/** Text as the fake stores it: UTF-16 with a byte-order mark (the task XML) is decoded. */
function text(content: string | Buffer): string {
  if (typeof content === 'string') return content
  return content[0] === 0xff && content[1] === 0xfe
    ? content.subarray(2).toString('utf16le')
    : content.toString()
}

/**
 * Answers for commands no response matches: an account's ids, as id gives them for a system user
 * (uid and group 999), and no setpriv, so the folder checks read modes.
 */
const DEFAULTS: FakeSys['responses'] = [
  { match: /^id -u \S+$/, status: 0, stdout: '999\n' },
  { match: /^id -g \S+$/, status: 0, stdout: '999\n' },
  { match: /^id -G \S+$/, status: 0, stdout: '999\n' },
  { match: /^setpriv /, status: 127 },
  // The scheduled task's state: none registered, and nothing runs from the program folder.
  { match: /mm:task-state/, status: 0, stdout: 'processes 0' },
]

/**
 * An in-memory system: records commands (joined with spaces, for matching) and file writes.
 * Unless a response says otherwise, every command succeeds with empty output, every path is
 * root-owned 0755, and Windows ACL scripts report nothing wrong.
 */
export function fakeSys(platform: NodeJS.Platform, opts: { admin?: boolean } = {}): FakeSys {
  const commands: string[] = []
  let clock = 0
  const files = new Map<string, { content: string; mode: number }>()
  const dirs = new Map<string, number>()
  const responses: FakeSys['responses'] = []
  const stats = new Map<string, { uid: number; gid?: number; mode: number } | null>()
  const realpaths = new Map<string, string>()
  const longNames = new Map<string, string>()
  const links = new Set<string>()
  const linkStats = new Map<string, { uid: number; gid?: number; mode: number }>()
  const writtenXml: string[] = []
  const binaries = new Map<string, Buffer>()
  const logProblems = new Map<string, string>()
  const respond = (line: string) => {
    const r = responses.find((x) => x.match.test(line)) ?? DEFAULTS.find((x) => x.match.test(line))
    // systemd's own reading of the unit, with no drop-in: the User= the unit written names.
    if (
      !r &&
      /^systemctl show mongo-manager -p User -p Group -p SupplementaryGroups -p DynamicUser$/.test(line)
    ) {
      const unit = files.get('/etc/systemd/system/mongo-manager.service')?.content ?? ''
      const user = /^User=(.*)$/m.exec(unit)?.[1] ?? ''
      return { status: 0, stdout: `User=${user}\nGroup=\nSupplementaryGroups=\nDynamicUser=no\n`, stderr: '' }
    }
    return { status: r?.status ?? 0, stdout: r?.stdout ?? '', stderr: '' }
  }
  const sys: FakeSys = {
    platform,
    commands,
    files,
    dirs,
    responses,
    stats,
    realpaths,
    longNames,
    links,
    linkStats,
    writtenXml,
    binaries,
    logProblems,
    logFileProblem: (p) => logProblems.get(p) ?? null,
    isAdmin: () => opts.admin ?? true,
    run: (cmd, args, opts) => {
      const encoded = args.indexOf('-EncodedCommand')
      if (cmd === 'powershell' && encoded >= 0) {
        // Record the decoded script and its JSON input, so tests can match both.
        const script = Buffer.from(args[encoded + 1]!, 'base64').toString('utf16le')
        const line = `powershell ${script} INPUT=${opts?.env?.MM_PS_INPUT ?? ''}`
        commands.push(line)
        sys.onRun?.(line)
        const r = respond(line)
        // A script that ran to its end prints the completion marker last.
        return r.status === 0 ? { ...r, stdout: `${r.stdout}\nMM-PS-DONE\n` } : r
      }
      const line = [cmd, ...args].join(' ')
      commands.push(line)
      sys.onRun?.(line)
      return respond(line)
    },
    runInherit: (cmd, args) => {
      const line = [cmd, ...args].join(' ')
      commands.push(line)
      return respond(line).status
    },
    // Whole-branch re-re-review (minor 8): there as lstat finds it, a link where it leads.
    exists: (p) => {
      for (let path = p, hops = 0; hops <= 40; hops++) {
        const own = sys.lstat(path)
        if (own === null) return false
        if ((own.mode & 0o170000) !== 0o120000) return true
        path = sys.readlink(path)
      }
      return false
    },
    read: (p) => {
      const f = files.get(p)
      if (!f) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return f.content
    },
    readBytes: (p) => {
      const image = binaries.get(p)
      if (image) return image
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return platform === 'darwin' ? macho64() : platform === 'linux' ? elf64() : Buffer.alloc(0)
    },
    readTail: (p, bytes) => {
      const f = files.get(p)
      if (!f) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return f.content.slice(-bytes)
    },
    write: (p, content, mode) => {
      if (p.endsWith('.xml')) writtenXml.push(text(content))
      files.set(p, { content: text(content), mode })
    },
    mkdir: (p, mode) => void dirs.set(p, mode),
    copyProgram: (from, to) => {
      commands.push(`copyProgram ${to}`)
      dirs.set(to, 0o755)
      const bin = (name: string) => (platform === 'win32' ? `${to}\\bin\\${name}.exe` : `${to}/bin/${name}`)
      const [source, exe] = 'binary' in from ? [from.binary, bin('mongo-manager')] : [from.node, bin('node')]
      const image = binaries.get(source)
      if (image) binaries.set(exe, image)
      else binaries.delete(exe)
      files.set(exe, { content: `copy of ${source}`, mode: 0o755 })
      if ('binary' in from) return
      // Named as the platform names them (fourth review of the CI fixes, nit 3).
      const dist = (name: string) => (platform === 'win32' ? `${to}\\dist\\${name}` : `${to}/dist/${name}`)
      files.set(dist('cli.cjs'), { content: 'bundle', mode: 0o644 })
      files.set(dist('shell-worker.cjs'), { content: 'worker', mode: 0o644 })
    },
    remove: (p) => {
      files.delete(p)
      dirs.delete(p)
      for (const k of [...files.keys()]) if (k.startsWith(`${p}/`) || k.startsWith(`${p}\\`)) files.delete(k)
    },
    randomKey: () => 'a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=',
    removeEmptyDir: (p) => {
      commands.push(`rmdir-if-empty ${p}`)
      const below = (k: string) => k.startsWith(`${p}/`) || k.startsWith(`${p}\\`)
      if (![...files.keys(), ...dirs.keys()].some(below)) dirs.delete(p)
      return null
    },
    sleep: (ms) => {
      commands.push(`sleep ${ms}`)
      clock += ms
      sys.onSleep?.()
    },
    // Time passes only as the code sleeps.
    now: () => clock,
    realpath: (p) => realpaths.get(p) ?? p,
    realpathNative: (p) => longNames.get(p) ?? realpaths.get(p) ?? p,
    lstat: (p) => {
      if (links.has(p) || (realpaths.has(p) && realpaths.get(p) !== p))
        return { ...(linkStats.get(p) ?? { uid: 0 }), mode: 0o120777 }
      // A folder holds whatever is known below it.
      const below = (path: string) => path.startsWith(p === '/' ? '/' : `${p}/`)
      const known =
        p === '/' ||
        files.has(p) ||
        dirs.has(p) ||
        // One a test gives an owner of is there.
        (stats.has(p) && stats.get(p) !== null) ||
        // What a link leads to, as realpaths names it, is there.
        [...files.keys(), ...dirs.keys(), ...links, ...realpaths.keys(), ...realpaths.values()].some(
          (path) => path === p || below(path),
        )
      if (!known) return null
      const own = stats.has(p) ? stats.get(p) : undefined
      if (own === null) return null
      return own ?? { uid: 0, mode: files.has(p) ? 0o100644 : 0o40755 }
    },
    readlink: (p) => realpaths.get(p) ?? `/nowhere${p}`,
    // A link's target's, as stat follows a link (whole-branch re-re-review, minor 8).
    stat: (p) => {
      const path = realpaths.get(p) ?? p
      return stats.has(path) ? stats.get(path)! : { uid: 0, mode: 0o755 }
    },
    privateTempDir: () => {
      const dir =
        platform === 'win32' ? 'C:\\Users\\admin\\AppData\\Local\\Temp\\mm-private' : '/root/tmp/mm-private'
      dirs.set(dir, 0o700)
      return dir
    },
  }
  return sys
}
