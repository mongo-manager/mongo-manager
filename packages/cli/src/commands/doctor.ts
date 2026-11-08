// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DB_FILE,
  KEY_FILE,
  LAUNCH_FILE,
  assertSafeBind,
  createSecretBox,
  defaultWebRoot,
  findTools,
  versionOk,
  isLoopbackHost,
  runningInstance,
  checkKey,
  type Config,
} from '@mongo-manager/server'
import type { Io } from '../io'
import { packagedWebRoot } from '../paths'
import { isStandalone } from '../sea'
import { BROAD_SIDS, aclSids, dirOwner } from '../service/acl'
import { layoutFor } from '../service/layout'
import {
  badGroupText,
  envValue,
  handAddLine,
  lostGroupText,
  serviceAccount,
  serviceFolderRoots,
  unaskedText,
  unitIds,
  unitUser,
} from '../service/linux'
import {
  LINE_BREAK,
  clean,
  SERVICE_CHANGE_FIX,
  leadsNowhere,
  linkMayChange,
  looseParentOn,
  outermost,
  looseParentText,
  plainPath,
  refusalOf,
  ONCE_STILL,
  linkLoose,
  serviceChangeText,
  serviceMayChangeOn,
  walkPath,
  type LinkFs,
  type Loose,
  type Walk,
} from '../service/sandbox'
import { realSys, type Sys } from '../service/sys'

const SYSTEM_SID = 'S-1-5-18'
const ADMINISTRATORS_SID = 'S-1-5-32-544'
/**
 * What takes the broad grants away in an icacls command: /grant:r replaces only the grants of whom
 * it names (review of the ACL reads, second review, important).
 */
const REMOVE_BROAD = `/remove:g ${[...BROAD_SIDS].map((sid) => `*${sid}`).join(' ')}`

type Status = 'ok' | 'warn' | 'fail'

/** What a POSIX system says of a path's owner and mode. */
type Owned = { uid: number; gid: number; mode: number }

/**
 * What the systemd service's unit lets it write into, or null when that cannot be read. Asked of
 * systemd over D-Bus first, which gives each path whole (third review 2026-10-18, minor 6); systemctl
 * show parts its list at spaces, so there a piece that starts no path goes on the one before
 * (re-review 2026-10-18, minor 1). A path systemd may find missing comes with its '-'.
 */
function readSandbox(sys: Sys): string[] | null {
  const bus = sys.run('busctl', [
    '--json=short',
    'get-property',
    'org.freedesktop.systemd1',
    '/org/freedesktop/systemd1/unit/mongo_2dmanager_2eservice',
    'org.freedesktop.systemd1.Service',
    'ReadWritePaths',
  ])
  if (bus.status === 0) {
    try {
      const data = (JSON.parse(bus.stdout) as { data?: unknown }).data
      if (Array.isArray(data) && data.every((p) => typeof p === 'string'))
        return data.map((p) => p.replace(/^-?\+?/, '')).filter((p) => isAbsolute(p))
    } catch {
      // Read below as systemctl shows it.
    }
  }
  const shown = sys.run('systemctl', ['show', 'mongo-manager', '-p', 'ReadWritePaths', '--value'])
  if (shown.status !== 0) return null
  const entries: string[] = []
  for (const piece of shown.stdout.split(/\s+/).filter(Boolean)) {
    const path = piece.replace(/^-?\+?/, '')
    if (isAbsolute(path) || entries.length === 0) entries.push(path)
    else entries[entries.length - 1] += ` ${piece}`
  }
  return entries.filter((p) => isAbsolute(p))
}

/** Whether a directory lets uid (with primary group gid) write into it, by its owner, group and mode. */
function writableBy(dir: Owned, uid: number, gid: number): boolean {
  const bits = dir.uid === uid ? 0o300 : dir.gid === gid ? 0o030 : 0o003
  return (dir.mode & bits) === bits
}

/** A path as a POSIX shell reads it back unchanged, for a command doctor prints to paste. */
const sh = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`

/** Whether this user can list the directory and open what is in it. */
function readable(dir: string): boolean {
  try {
    accessSync(dir, constants.R_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Read-only checks of the installation and the data directory; exits 1 when any check fails. */
export async function doctor(
  config: Config,
  io: Io,
  deps: {
    sys?: Sys
    uid?: number
    stat?: (path: string) => Owned
    /** Why the Linux service cannot reach a root (tests: roots in the temp directory, which it cannot). */
    unreachable?: (root: string) => string | null
    /** The data directory's owner, or null for none (tests: the service's own, which they cannot make). */
    owner?: Owned | null
    /** The file system the roots are walked on (tests: one that changes between two reads). */
    fs?: LinkFs
  } = {},
): Promise<number> {
  let failed = false
  const report = (status: Status, text: string) => {
    if (status === 'fail') failed = true
    io.stdout.write(`[${status}] ${text}\n`)
  }
  const posix = io.platform !== 'win32'
  const stat = deps.stat ?? statSync
  const mode = (path: string) => stat(path).mode & 0o777
  const loose = (path: string) => posix && (mode(path) & 0o077) !== 0

  const major = Number(process.versions.node.split('.')[0])
  report(
    major >= 24 ? 'ok' : 'fail',
    `Node.js ${process.versions.node}${major >= 24 ? '' : ' (Mongo Manager needs 24 or newer)'}`,
  )

  try {
    assertSafeBind(config)
    const where = `${config.host}:${config.webPort}`
    if (config.unsafeNoAuth && !isLoopbackHost(config.host)) {
      report('warn', `Listening on ${where} without authentication (--unsafe-no-auth)`)
    } else {
      report('ok', `Web UI on ${where} (${config.auth ? 'team mode' : 'local mode'})`)
    }
  } catch (e) {
    report('fail', (e as Error).message)
  }

  const dir = config.dataDir
  const dbPath = join(dir, DB_FILE)
  const keyPath = join(dir, KEY_FILE)
  // The Windows service's own loses the broad grants alone, so its account keeps the write access
  // the install gave it (review of the ACL reads, minor 2; third review, important: its folder's
  // rules alone, /reset, read only); any other is kept to this account (in Command Prompt, where
  // %USERNAME% is this account).
  const dataService =
    !posix &&
    win32.normalize(dir).toLowerCase() === win32.normalize(layoutFor('win32', io.env).dataDir).toLowerCase()
  // Review 2026-10-17: run as another user than a service's, doctor took the key it could not see
  // in a 700 directory for no key at all, then threw listing it. It checks nothing it cannot read.
  const notDirectory = existsSync(dir) && !statSync(dir).isDirectory()
  const unreadable = posix && existsSync(dir) && !notDirectory && !readable(dir)
  const blocked = notDirectory || unreadable
  // The server's user: whoever owns the data directory (a service install makes it so).
  const owner = deps.owner !== undefined ? deps.owner : posix && existsSync(dir) ? stat(dir) : null
  // Only a directory its owner alone may enter names the server's user (third review, important 2):
  // a bind mount opened to everyone serves another uid, and a root-owned one a server that reads
  // anything.
  const sole = owner && owner.uid !== 0 && (owner.mode & 0o077) === 0 ? owner : null
  if (!existsSync(dir)) {
    report('warn', `Data directory ${dir} does not exist yet; it is created on first start`)
  } else if (notDirectory) {
    report('fail', `Data directory ${dir} is not a directory`)
  } else if (unreadable) {
    // Third review 2026-10-17 (minor 3): not `sudo -u` the owner, which drops the service's config
    // and env file (its key) and, through sudo's own PATH, often the command itself.
    report(
      'fail',
      `Data directory ${dir} cannot be read by this user (it belongs to uid ${owner!.uid}); ` +
        'run doctor again with sudo, with the same options',
    )
  } else {
    // Windows has no modes: look for grants to everyone on the computer in the directory's ACL.
    const sids = posix ? [] : aclSids(deps.sys ?? realSys(), dir)
    const broad = sids?.some((sid) => BROAD_SIDS.has(sid)) ?? false
    if (sids === null) {
      report(
        'warn',
        `The permissions of data directory ${dir} could not be read; check them with: icacls "${dir}"`,
      )
    } else if (loose(dir)) {
      report(
        'warn',
        `Data directory ${dir} is readable by other users (mode ${mode(dir).toString(8)}); run: chmod 700 ${sh(dir)}`,
      )
    } else if (broad) {
      report(
        'warn',
        `Data directory ${dir} is readable by all users of this computer; restrict it ` +
          (dataService
            ? `keeping the service's own access, with: icacls "${dir}" ${REMOVE_BROAD} /T`
            : `in Command Prompt with: icacls "${dir}" /inheritance:r ${REMOVE_BROAD} ` +
              '/grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F "%USERNAME%:(OI)(CI)F"'),
      )
    } else {
      report('ok', `Data directory ${dir}`)
    }
    // Review of the ops fixes (I1): whoever owns it can change its ACL at any time — a narrow ACL set
    // by another user proves nothing.
    if (!posix) {
      const o = dirOwner(deps.sys ?? realSys(), dir)
      if (!o)
        report('warn', `The owner of data directory ${dir} could not be read; check it with: icacls "${dir}"`)
      else if (![SYSTEM_SID, ADMINISTRATORS_SID, o.me].includes(o.owner))
        report(
          'warn',
          `Data directory ${dir} is owned by ${o.owner}, not by this account or the administrators: ` +
            'that account can change who reads it. Move the data to a directory this account made.',
        )
    }
    // Security audit 2026-10-16: and local mode's launch secret, which opens the app.
    // The database's write-ahead log and index hold its data too; a command run as root leaves them root's.
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, keyPath, join(dir, LAUNCH_FILE)]) {
      if (existsSync(file) && loose(file)) {
        report(
          'warn',
          `${file} is readable by other users (mode ${mode(file).toString(8)}); run: chmod 600 ${sh(file)}`,
        )
      }
      // Review of the ACL reads (minor 2): on Windows a file is opened to everyone by its own ACL;
      // where the directory is, by its own grants alone, so it is said once (second review, minor 1).
      const fileSids = !posix && existsSync(file) ? aclSids(deps.sys ?? realSys(), file, { own: broad }) : []
      if (fileSids === null)
        report(
          'warn',
          `The permissions of data file ${file} could not be read; check them with: icacls "${file}"`,
        )
      else if (fileSids.some((sid) => BROAD_SIDS.has(sid)))
        report(
          'warn',
          `${file} is readable by all users of this computer; restrict it ` +
            (dataService
              ? `keeping the service's own access, with: icacls "${file}" ${REMOVE_BROAD}`
              : `in Command Prompt with: icacls "${file}" /inheritance:r ${REMOVE_BROAD} ` +
                '/grant:r *S-1-5-18:F *S-1-5-32-544:F "%USERNAME%:F"'),
        )
      // Review 2026-10-17: a key restored with `sudo cp` is root's, mode 600, and the server cannot
      // read it at its start, though doctor run as root can.
      const uid = sole && existsSync(file) ? stat(file).uid : null
      if (sole && uid !== null && uid !== sole.uid) {
        report(
          'warn',
          `${file} is owned by uid ${uid}, not by the data directory's owner (uid ${sole.uid}), the ` +
            `server's user, who may not read it; run: sudo chown ${sole.uid}:${sole.gid} ${sh(file)}`,
        )
      }
    } // Security review 2026-10-13 (low): a previous key and the backup sealed with it open every secret
    // as it was before the rotation; they belong elsewhere, or nowhere, once the new key works.
    const leftovers = readdirSync(dir)
      .filter(
        (f) =>
          f.startsWith(`${KEY_FILE}.old-`) ||
          f.startsWith(`${KEY_FILE}.new.discarded-`) ||
          f.startsWith(`${DB_FILE}.bak-rotate-`),
      )
      .sort()
    if (leftovers.length > 0)
      report(
        'warn',
        `A key rotation left ${leftovers.join(', ')} in ${dir}. Together they open the secrets as they were ` +
          'before it: once the new key works, move them somewhere safe or delete them (the first start ' +
          'seven days after the rotation removes them).',
      )
  }

  // Review of the CI fixes (doctor): the start makes private only a log file it makes; one already
  // there (an older version's, made open to everyone) is left as it is, so it is said here. Second
  // review (I-B): the server refuses one that is a link or has other names, which is said first —
  // a chmod told for a link would change what it points at.
  if (config.logFile) {
    const log = config.logFile
    // Fourth review of the CI fixes (minor 1): a path that cannot be made (a file where a folder of it
    // should be) is no "made at the first start"; fifth review (minor 4): nor one under a drive that
    // is not there, or with a name Windows does not allow.
    const unmakeable = (): string | null => {
      let up = dirname(log)
      const below = [basename(log)]
      for (; !existsSync(up) && dirname(up) !== up; up = dirname(up)) below.unshift(basename(up))
      if (!existsSync(up)) return `${up} does not exist`
      if (!statSync(up).isDirectory()) return `${up} is not a folder`
      const bad = posix
        ? undefined
        : below.find(
            (n) => /[<>:"|?*]/.test(n) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n) || n.length > 255,
          )
      return bad === undefined ? null : `${bad} is no name Windows allows`
    }
    const missing = () => {
      const why = unmakeable()
      if (why) report('fail', `Log file ${log} cannot be made: ${why}; the server does not start with it`)
      else report('ok', `Log file ${log} (made at the first start)`)
    }
    try {
      const problem = (deps.sys ?? realSys()).logFileProblem(log)
      const said = `The log file ${log} `
      if (problem) {
        // Third review of the CI fixes (minor 9): in the words of its neighbours.
        const why = problem.startsWith(said) ? problem.slice(said.length) : problem
        report('fail', `Log file ${log} ${why}; the server does not start with it`)
      } else if (!existsSync(log)) {
        missing()
      } else if (loose(log)) {
        report(
          'warn',
          `Log file ${log} is readable by other users (mode ${mode(log).toString(8)}); run: chmod 600 ${sh(log)}`,
        )
      } else if (!posix) {
        const sys = deps.sys ?? realSys()
        const sids = aclSids(sys, log)
        // The service's own takes its folder's rules back; any other is kept to this account (in
        // Command Prompt, where %USERNAME% is this account) (second review of the CI fixes, minor 7).
        const service =
          win32.normalize(log).toLowerCase() ===
          win32.normalize(layoutFor('win32', io.env).logFile!).toLowerCase()
        // Fourth review (minor 8): as for the data directory, whoever owns it can change who reads
        // it; the service's own is its account's, which doctor does not know.
        const o = service ? null : dirOwner(sys, log)
        if (sids === null)
          report(
            'warn',
            `The permissions of log file ${log} could not be read; check them with: icacls "${log}"`,
          )
        else if (sids.some((sid) => BROAD_SIDS.has(sid)))
          report(
            'warn',
            `Log file ${log} is readable by all users of this computer; restrict it ` +
              (service
                ? `to the service's folder's rules with: icacls "${log}" /reset`
                : `in Command Prompt with: icacls "${log}" /inheritance:r ${REMOVE_BROAD} /grant:r *S-1-5-18:F *S-1-5-32-544:F "%USERNAME%:F"`),
          )
        // Fifth review (minor 3): as for the data directory, an owner that cannot be read is said.
        else if (!service && !o)
          report('warn', `The owner of log file ${log} could not be read; check it with: icacls "${log}"`)
        else if (o && ![SYSTEM_SID, ADMINISTRATORS_SID, o.me].includes(o.owner))
          report(
            'warn',
            `Log file ${log} is owned by ${o.owner}, not by this account or the administrators: that ` +
              'account can change who reads it. Name a log file this account makes.',
          )
        else report('ok', `Log file ${log}`)
      } else {
        report('ok', `Log file ${log}`)
      }
    } catch (e) {
      // Third review of the CI fixes (I-2): a log file this user may not look at stops nothing after
      // it (doctor checks nothing it cannot read); fourth review (minor 1, 8): nor does any other
      // reason it cannot be looked at, and a refusal Windows keeps even for administrators (a deny
      // rule) is said with how to see it.
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM')
        report(
          'warn',
          `Log file ${log} cannot be looked at by this user; run doctor again ` +
            (posix
              ? 'with sudo, with the same options'
              : `from an administrator prompt, with the same options; if it is still refused, check it with: icacls "${log}"`),
        )
      // Fifth review (minor 2): one the server rotated away meanwhile is one it makes again.
      else if (code === 'ENOENT' || code === 'ENOTDIR') missing()
      else
        report(
          'fail',
          `Log file ${log} cannot be looked at (${(e as Error).message}); the server does not start with it`,
        )
    }
  }

  // Whole-branch re-review (minor 4): the service's key is in its env file, which systemd gives it and
  // sudo does not give doctor: read there when doctor checks the service's data directory.
  const serviceEnv = layoutFor('linux', io.env).envFile!
  const serviceKey = (() => {
    if (io.platform !== 'linux' || config.secretKey) return undefined
    if (resolve(config.dataDir) !== resolve(layoutFor('linux', io.env).dataDir)) return undefined
    const sys = deps.sys ?? realSys()
    try {
      return sys.exists(serviceEnv) ? envValue(sys.read(serviceEnv), 'MM_SECRET_KEY') || undefined : undefined
    } catch {
      return undefined
    }
  })()
  const secretKey = config.secretKey ?? serviceKey
  let key: Buffer | null = null
  if (secretKey) {
    key = Buffer.from(secretKey, 'base64')
    const from = serviceKey ? `MM_SECRET_KEY in ${serviceEnv}` : 'MM_SECRET_KEY'
    if (key.length === 32) report('ok', `Secret key from ${from}`)
    else report('fail', `${from} is not a base64-encoded 32-byte key`)
  } else if (blocked) {
    // Reported above: whether it holds a key is not known.
  } else if (existsSync(keyPath)) {
    // Third review 2026-10-17 (minor 7): a key this user may not read (another's, mode 600) threw,
    // and every check after it went unsaid.
    try {
      const text = readFileSync(keyPath, 'utf8')
      key = Buffer.from(text.trim(), 'base64')
      if (key.length === 32) report('ok', `Secret key file ${keyPath}`)
      // Sixth review of the CI fix 2026-10-20 (minor 7): what an empty one is, and what comes of it.
      // A link the next start leaves as it is (seventh review, minor 3).
      else if (text === '' && !lstatSync(keyPath).isFile())
        report(
          'fail',
          `${keyPath} is a link to an empty file; a start leaves a link as it is. Restore the key, or ` +
            'replace the link with the key file',
        )
      else if (text === '')
        report(
          'fail',
          `${keyPath} is empty: a start stopped before it wrote it. The next start sets it aside: a new ` +
            'data directory gets a key, one with encrypted data is refused until its key is restored',
        )
      else report('fail', `${keyPath} does not hold a base64-encoded 32-byte key`)
    } catch (e) {
      key = null
      report(
        'fail',
        `${keyPath} cannot be read by this user (${(e as NodeJS.ErrnoException).code}); ` +
          'run doctor again with sudo, with the same options',
      )
    }
  } else {
    report(
      'warn',
      'No secret key yet; one is created on first start (back it up together with the data directory)',
    )
  }
  const pendingPath = `${keyPath}.new`
  const pendingKey = (() => {
    try {
      const k = Buffer.from(readFileSync(pendingPath, 'utf8').trim(), 'base64')
      return k.length === 32 ? k : null
    } catch {
      return null
    }
  })()
  let pendingReported = false
  if (key?.length === 32 && existsSync(dbPath)) {
    // Read-only: doctor never changes the data directory.
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        ).map((t) => t.name),
      )
      if (['settings', 'connections', 'users'].every((t) => tables.has(t))) {
        const state = checkKey(db, createSecretBox(key))
        if (state === 'match') report('ok', 'The secret key matches the stored data')
        else if (
          state === 'mismatch' &&
          pendingKey &&
          checkKey(db, createSecretBox(pendingKey)) === 'match'
        ) {
          report('warn', 'A key rotation was committed but not finished; the next start completes it')
          pendingReported = true
        } else if (state === 'mismatch') {
          report(
            'fail',
            'The secret key does not match this data directory (check MM_SECRET_KEY, secretKey in the config file or secret.key)',
          )
        }
      }
    } catch (e) {
      report('fail', (e as Error).message)
    } finally {
      db?.close()
    }
  }
  if (!pendingReported && existsSync(pendingPath)) {
    report('warn', 'An unfinished key rotation was found; the next start sets its unused key aside')
  }

  if (!blocked) {
    const running = existsSync(dir) ? runningInstance(dir) : null
    report(
      'ok',
      running
        ? `Mongo Manager is running (pid ${running.pid})`
        : 'Mongo Manager is not running on this data directory',
    )
  }

  const web =
    config.webRoot ??
    (isStandalone() ? 'embedded in the standalone binary' : (packagedWebRoot() ?? defaultWebRoot()))
  if (web) report('ok', `Web app: ${web}`)
  else report('warn', 'No web app build found (the API works, the UI does not)')

  // Phase 3d-3b §4.6: the folder roots destinations may use, and the networks they may reach.
  // Final review B18: compared by real path (a link or junction to the data directory is inside it),
  // and checked for what the server needs there: a directory it can write into.
  // The file system's own, not deps.sys's: doctor reads the roots where they are, and walks them as
  // install does (whole-branch re-review, important 1).
  const fs: LinkFs = deps.fs ?? {
    lstat: (path: string) => {
      try {
        const s = lstatSync(path)
        return { uid: s.uid, gid: s.gid, mode: s.mode }
      } catch {
        return null
      }
    },
    readlink: (path: string) => readlinkSync(path, 'utf8'),
  }
  // One walk a root (whole-branch re-re-review, minor 5), the one every judgement of it and real()
  // read, so that no two can see it before and after a swap (re-re-re-review, important 1).
  const walks = new Map<string, ReturnType<typeof walkPath>>()
  const walkOf = (path: string) => {
    const key = resolve(path)
    if (!walks.has(key)) walks.set(key, walkPath(key.split(sep).join('/'), fs))
    return walks.get(key)!
  }
  // Last review 2026-10-18 (minor 2): one not made yet, as install judges it: its nearest folder's
  // real path, and the rest as written, so a link above it is followed too. On a POSIX host by the
  // same walk as install's, which takes '..' after a link as the kernel does (whole-branch
  // re-re-review, minor 3); by the host's own on Windows, which tests give it.
  const real = (path: string) => {
    if (process.platform !== 'win32') return walkOf(path).real
    const rest: string[] = []
    let dir = resolve(path)
    while (!existsSync(dir) && dirname(dir) !== dir) {
      rest.unshift(basename(dir))
      dir = dirname(dir)
    }
    try {
      return join(realpathSync(dir), ...rest)
    } catch {
      return resolve(path)
    }
  }
  const within = (parent: string, child: string) => {
    const rel = relative(parent, child)
    return !rel.startsWith('..') && !isAbsolute(rel)
  }
  const asRoot = posix && (deps.uid ?? process.getuid?.()) === 0
  const writableDir = (path: string) => {
    try {
      if (!statSync(path).isDirectory()) return false
      accessSync(path, constants.W_OK)
      return true
    } catch {
      return false
    }
  }
  // Third review 2026-10-17 (important): the systemd service writes only where its unit says (its
  // data directory and the roots it was installed with), whatever the root's own mode allows.
  const service = layoutFor('linux', io.env)
  const sys = io.platform === 'linux' ? (deps.sys ?? realSys()) : null
  const isService =
    sys !== null && resolve(config.dataDir) === resolve(service.dataDir) && sys.exists(service.unit)
  if (sys !== null && !isService && sys.exists(service.unit))
    report(
      'warn',
      `The systemd service is installed, but doctor checks ${config.dataDir}, not its data directory: ` +
        `check the service with: sudo mongo-manager doctor --config ${service.configFile}`,
    )
  const sandbox = isService ? readSandbox(sys!) : undefined
  if (sandbox === null)
    report(
      'warn',
      "The systemd service's sandbox could not be read; check with: systemctl show mongo-manager -p " +
        'ReadWritePaths',
    )
  // Re-review 2026-10-18 (important 1): the roots the service uses, as install reads them: its env
  // file's in place of its config file's. sudo leaves MM_BACKUP_FOLDER_ROOTS out of doctor's own.
  let unreadableFile: string | null = null
  const serviceText = (path: string) => {
    if (!sys!.exists(path)) return null
    try {
      return sys!.read(path)
    } catch {
      unreadableFile ??= path
      return null
    }
  }
  const serviceRoots = (() => {
    if (!isService) return undefined
    const configText = serviceText(service.configFile)
    const envText = serviceText(service.envFile!)
    if (unreadableFile) return null
    // Third review (minor 10): without them, what the unit names is not judged against doctor's own.
    return configText === null && envText === null ? undefined : serviceFolderRoots(configText ?? '', envText)
  })()
  const roots = serviceRoots ?? config.backup.folderRoots
  // Third review (minor 5): compared as the server and install read them.
  const norm = (paths: string[]) => new Set(paths.map((r) => clean(r.trim())))
  const given = norm(config.backup.folderRoots)
  const used = norm(serviceRoots ?? [])
  if (unreadableFile)
    report(
      'warn',
      `The systemd service's ${unreadableFile === service.envFile ? 'env' : 'config'} file ${unreadableFile} ` +
        'cannot be read by this user: run doctor again with sudo to check the folder roots the service ' +
        'uses, and what else its unit lets it write into',
    )
  else if (isService && serviceRoots === undefined)
    report(
      'warn',
      `The systemd service's config file ${service.configFile} does not exist: run 'mongo-manager service ` +
        "install' again with sudo",
    )
  else if (serviceRoots && given.size && (given.size !== used.size || [...given].some((r) => !used.has(r))))
    report(
      'warn',
      `The systemd service uses the folder roots its config and env file name (${serviceRoots.join(', ') || 'none'}), ` +
        `not those doctor was given (${config.backup.folderRoots.join(', ')}); doctor checks the service's`,
    )
  // Re-review 2026-10-18 (important 2): the service's user, who must not be able to change a folder
  // above a root: the unit's User= (a drop-in's included, third review minor 8), or the data
  // directory's owner. Run as root, the kernel says what that user may write into.
  const serviceUser = (() => {
    if (!isService) return null
    // Sixth review (minor 7): the groups the unit gives it too.
    const ids = unitIds(sys!)
    // Ninth review (important 2): a systemctl show that failed tells no one.
    if (ids.failed) return { user: '', account: null, ids }
    // Ninth review (important 1): DynamicUser=yes takes an account of that name when one exists; doctor
    // judges for it, and can tell no one when none does.
    const runs = unitUser(ids)
    // Whole-branch review (important 3): no User= runs it as root, which install stops for.
    if (!runs) return { user: '', account: null, ids, root: true }
    const found = serviceAccount(sys!, runs, asRoot, ids)
    if (found?.uid === 0) return { user: runs, account: null, ids, root: true }
    return { user: runs, account: found, ids }
  })()
  if (serviceUser?.root)
    report(
      'warn',
      `The systemd service runs as root: its unit, with its drop-ins, names ${serviceUser.user ? `User=${serviceUser.user}` : 'no User='}, ` +
        `and service install stops for that; remove ${serviceUser.user ? 'that' : 'the empty'} User= with: ` +
        'sudo systemctl edit mongo-manager',
    )
  const account = serviceUser?.account ?? null
  // Fourth review (minor 2): said, as install says it, rather than checked against no one. Each limit
  // on what was checked is said, none hiding another (eighth review, minor 4).
  if (isService && !account && !serviceUser?.root && roots.length)
    report(
      'warn',
      serviceUser?.ids.failed
        ? 'systemd could not be asked who runs the service (systemctl show failed): the folders above the ' +
            'folder roots are not checked for it'
        : "The systemd service's user could not be determined (DynamicUser=yes with no account of its " +
            'name, or a User= the id command does not know): the folders above the folder roots are not ' +
            'checked for it',
    )
  if (account?.badGroup && roots.length) report('warn', badGroupText(account.badGroup))
  if (account?.lostGroup && roots.length) report('warn', lostGroupText(account.lostGroup))
  if (account?.unasked && roots.length) report('warn', unaskedText(serviceUser!.user))
  // Sixth review (minor 3): said without root too, where the system is not asked at all, unless doctor
  // has already said to run it with sudo (seventh review, minor 4).
  if (account && !asRoot && roots.length && !unreadableFile)
    report(
      'warn',
      'doctor runs without root, so the folders above the folder roots were judged by their modes and ' +
        "the service user's groups alone, not by its ACLs: run it with sudo to have the system asked",
    )
  // systemd follows links: where a write lands is the real path (fourth review, minor 5).
  const inSandbox = (root: string) => sandbox!.some((p) => within(real(p), real(root)))
  // One the unit names as an entry of its own, whose place a link could take.
  const named = (root: string) => !!sandbox && sandbox.some((p) => real(p) === real(root))
  // Each folder itself, a link not followed (whole-branch re-re-review, important 1); its owner and mode
  // as the tests may give them.
  const selfFs = {
    lstat: (p: string) => {
      const own = fs.lstat(p)
      return own === null || (own.mode & 0o170000) === 0o120000 || !deps.stat ? own : deps.stat(p)
    },
  }
  const posixReal = (path: string) => real(path).split(sep).join('/')
  const posixPath = (path: string) => path.split(sep).join('/')
  // Whole-branch review (important 1): the folders above the links on its written path too.
  const looseAbove = (root: string, path: string) => looseParentOn(walkOf(root), selfFs, posixPath(path))
  // Each root's walk once (fourth review, minor 4).
  const walked = new Map<string, ReturnType<typeof serviceMayChangeOn>>()
  const changeable = (root: string) => {
    if (!account || !isAbsolute(root)) return null
    if (!walked.has(root))
      walked.set(root, serviceMayChangeOn(walkOf(root), selfFs, account, posixReal(root)))
    return walked.get(root)!
  }
  const refused = new Map<string, string | null>()
  const refusal = (root: string) => {
    if (!refused.has(root))
      refused.set(root, (deps.unreachable ?? ((r) => refusalOf(r, walkOf(r), service)))(root))
    return refused.get(root)!
  }
  // The outermost, as install takes it, and of two that lead to the same folder one install can name
  // (fifth review, minor 4).
  // Seventh review (minor 8): the unit is given the real path, so that is the one that counts.
  const plainRank = (o: string) => (plainPath(real(o).split(sep).join('/')) ? 0 : 1)
  // Re-review 2026-10-18 (important 2): one inside another root is in the sandbox by that one, which
  // install keeps (fourth review, important 2): not refused. One behind a link to nothing has none
  // inside it that is not behind that link too, and so said of first.
  const outerOf = (root: string) =>
    outermost(
      roots.filter(
        (o) =>
          isAbsolute(o) &&
          real(o) !== real(root) &&
          within(real(o), real(root)) &&
          !refusal(o) &&
          !changeable(o),
      ),
      real,
    )
  // Once a folder, by the first root that leads there (eighth review, minor 7).
  const looseSaid = new Set<string>()
  const sayLoose = (loose: Loose, root: string) => {
    if (!looseSaid.has(real(root))) report('warn', looseParentText(loose, root))
    looseSaid.add(real(root))
  }
  // Ninth review (minor 6): a real path with a line break in it no unit can name.
  const unnamable = (path: string) => /[\r\n]/.test(posixReal(path))
  const STALE =
    "run 'mongo-manager service install' again with sudo; if the unit still names it, drop it with: sudo " +
    'systemctl edit mongo-manager'
  // Final re-re-review (minor 1): another root that leads to the same folder keeps it in the unit,
  // as install names it only for a service it could judge (final re-re-re-review, minor 4); a lost
  // group, which leaves every root out, is said of each root before (f45efa13 review, minor 1).
  const keptByOther = (root: string) =>
    !!account &&
    roots.some((o) => o !== root && isAbsolute(o) && real(o) === real(root) && !refusal(o) && !changeable(o))
  // Whole-branch re-re-re-review (minor 1): what a link that leads nowhere is, and what to do of it.
  const nowhere = (walk: Walk) =>
    walk.why === 'changed'
      ? `${walk.dangling} changed while it was walked: it was a link, then none`
      : `${leadsNowhere(walk.dangling!, walk.why)}, which systemd follows wherever it leads at each start`
  const nowhereFix = (walk: Walk) =>
    walk.why === 'missing'
      ? // Whole-branch re-re-review (minor 4): with no one to judge for, it is not to be made.
        account
        ? ": make the folder it leads to, then run 'mongo-manager service install' again with sudo"
        : ': who may point it elsewhere could not be judged, so make nothing there; run doctor again once it can be'
      : walk.why === 'changed'
        ? `: ${ONCE_STILL}`
        : ': choose another folder, or remove the link'
  for (const root of roots) {
    // Fourth review 2026-10-17 (important 2): a root the unit hides or must keep read-only, whatever
    // ReadWritePaths names, which systemd drops without a word.
    const unreachable = sandbox !== undefined && isAbsolute(root) ? refusal(root) : null
    // Last review 2026-10-18 (important): install leaves it out, and one an earlier install put in the
    // unit leads, at the service's next start, wherever whoever makes that folder points it. A '..' is
    // judged as written first, as install judges it (re-review 2026-10-18, minor 9).
    const dangling =
      sandbox !== undefined && isAbsolute(root) && !root.split(/[\\/]/).includes('..')
        ? (walkOf(root).dangling ?? null)
        : null
    const outer = sandbox !== undefined && isAbsolute(root) ? outerOf(root) : undefined
    // Third review (minor 3): judged for every root, as install judges it, unless inside another.
    // Fifth review (minor 3): one the unit names as an entry of its own is judged though it is
    // inside another.
    // Whole-branch review (important 1): one refused, a link to nothing among them, is judged too, so
    // that no advice makes the folder a link the service may point leads to.
    // A refused one by the links on its way alone, as install judges it (whole-branch re-review,
    // minor 1).
    const theirs =
      sandbox === undefined || !account || !isAbsolute(root)
        ? null
        : dangling || refusal(root)
          ? linkMayChange(walkOf(root), selfFs, account)
          : !outer || named(root)
            ? changeable(root)
            : null
    // Final re-review 2026-10-18 (minor 2): what install warned of, said again after it, of the same
    // real path (last review, minor 4): a root not made yet included, and only one the unit names
    // as an entry of its own.
    const loose = isAbsolute(root) && named(root) && !outer ? looseAbove(root, real(root)) : null
    if (!isAbsolute(root)) report('warn', `Backup folder root ${root} is not an absolute path`)
    // Ninth review (minor 5): as install judges it, it leaves every root out.
    else if (account?.lostGroup)
      report(
        'warn',
        `Backup folder root ${root}: service install leaves it out, as a group the unit gives the service ` +
          'could not be looked up (see above)' +
          // Final re-re-review (minor 7): and the unit names it now.
          (named(root) ? `. The unit names it all the same: to leave it out, ${STALE}` : ''),
      )
    else if (theirs)
      report(
        'warn',
        `Backup folder root ${root}: ${serviceChangeText(theirs)}` +
          // Sixth review (minor 5): one inside another keeps the sandbox by that one, or will once install
          // runs again, or once that is added by hand (seventh review, minor 1). One that changed while it
          // was judged says what to do itself (re-re-re-review, minor 2).
          (theirs.changed ? '' : '; ') +
          (theirs.changed
            ? ''
            : outer && inSandbox(outer)
              ? "the unit names it as an entry of its own: run 'mongo-manager service install' again with " +
                `sudo now, which leaves that entry out; it stays in the sandbox by ${outer}`
              : outer && !plainRank(outer)
                ? "run 'mongo-manager service install' again with sudo now, which leaves its own entry out and " +
                  `takes it in by the folder root ${outer}`
                : outer && unnamable(outer)
                  ? `rename the folder root ${outer}: ${LINE_BREAK}`
                  : outer
                    ? `add the folder root ${outer} with: sudo systemctl edit mongo-manager, as ` +
                      `${handAddLine(posixReal(outer))} in [Service] (service install cannot add it: a space, ` +
                      "quote, backslash or % in it), then run 'mongo-manager service install' again with sudo, " +
                      'which leaves its own entry out'
                    : named(root) && !keptByOther(root)
                      ? "the unit names it: run 'mongo-manager service install' again with sudo now, which leaves it " +
                        `out, and to use it, ${SERVICE_CHANGE_FIX}`
                      : `service install leaves such a root out: to use it, ${SERVICE_CHANGE_FIX}`),
      )
    else if (dangling)
      report(
        'warn',
        `Backup folder root ${root}: ${nowhere(walkOf(root))}` +
          // f45efa13 review (minor 2): unless another root keeps that entry.
          (named(root) && !keptByOther(root)
            ? ", and the unit names it: run 'mongo-manager service install' again with sudo now, to leave it out"
            : nowhereFix(walkOf(root))),
      )
    else if (unreachable)
      report(
        'warn',
        `Backup folder root ${root} is out of the systemd service's reach: ${unreachable}` +
          // Final re-review (minor 1): one added by hand, which the unit names all the same; one another
          // root leads to is that root's (final re-re-review, minor 1).
          (named(root) && !keptByOther(root)
            ? `. The unit names it all the same: to leave it out, ${STALE}`
            : ''),
      )
    // Third review (minor 4): an entry an earlier install gave a root inside another, said first
    // (fifth review, minor 3).
    // Sixth review (minor 1): install cannot name an outer root with a space in it, so the inner one's
    // entry is the one that keeps it in until that is added by hand.
    else if (outer && named(root) && sandbox && !inSandbox(outer) && plainRank(outer))
      report(
        'warn',
        `Backup folder root ${root} is inside the folder root ${outer}, which service install cannot add ` +
          (unnamable(outer)
            ? `(${LINE_BREAK}): rename it`
            : `(a space, quote, backslash or % in it): add ${outer} with: sudo systemctl edit mongo-manager, as `) +
          (unnamable(outer) ? '' : `${handAddLine(posixReal(outer))} in [Service]`) +
          ", then run 'mongo-manager service install' again with sudo",
      )
    else if (outer && named(root))
      report(
        'warn',
        `Backup folder root ${root} is inside the folder root ${outer}, and the unit names it as well: ` +
          // Seventh review (minor 11): one install cannot name stays in by the drop-in that adds it.
          (plainRank(outer)
            ? `run 'mongo-manager service install' again with sudo, which leaves the entry of ${root} out; ` +
              `${outer} stays in by the drop-in that adds it, which systemctl edit (not --full) keeps out ` +
              'of the unit file install writes'
            : `run 'mongo-manager service install' again with sudo, which names ${outer} alone`),
      )
    // Fourth review (minor 5): one inside a root the sandbox does not take in yet.
    else if (outer && sandbox && !inSandbox(outer))
      report(
        'warn',
        `Backup folder root ${root} is inside the folder root ${outer}, which the systemd service's ` +
          `sandbox does not take in: see what is said of ${outer}`,
      )
    else if (!existsSync(root)) {
      report('warn', `Backup folder root ${root} does not exist`)
      // Last review 2026-10-18 (minor 2): only where the unit lets the service write.
      if (loose) sayLoose(loose, root)
    } else if (within(real(config.dataDir), real(root)) || within(resolve(config.dataDir), resolve(root)))
      report(
        'warn',
        `Backup folder root ${root} is inside the data directory; folder destinations there are refused`,
      )
    else if (sandbox === null)
      report('warn', `Backup folder root ${root} is not checked against the systemd service's sandbox`)
    // Final review 2026-10-17 (minor 2): a root service install never adds is added by hand. Its name
    // is read with '/' between folders: on Linux, where the sandbox is, that is already its own.
    else if (sandbox && !inSandbox(root) && plainRank(root))
      report(
        'warn',
        `Backup folder root ${root} is outside the systemd service's sandbox, and service install cannot ` +
          'add it (a space, quote, backslash or % in it): ' +
          (unnamable(root)
            ? `rename it: ${LINE_BREAK}`
            : `add it with: sudo systemctl edit mongo-manager, as ${handAddLine(posixReal(root))} in [Service]`),
      )
    else if (sandbox && !inSandbox(root))
      report(
        'warn',
        `Backup folder root ${root} is outside the systemd service's sandbox, which lets it write into ` +
          "its data directory and the folder roots it was installed with: run 'mongo-manager service " +
          "install' again with sudo (it adds the roots it finds in the service's config and env file)",
      )
    // Whole-branch review (minor 9): after the sandbox, which a root this user cannot write into still
    // has to be in.
    else if (!writableDir(root)) report('warn', `Backup folder root ${root} is not a writable directory`)
    else if (loose) sayLoose(loose, root)
    // Review 2026-10-17: root writes anywhere, so its access says nothing of the server's user's
    // (`sudo mongo-manager doctor` for a service install): the root is checked for that user.
    else if (asRoot && !owner)
      report(
        'warn',
        `Backup folder root ${root}: doctor runs as root, which writes anywhere, and no data directory ` +
          `names the server's user yet; check with: sudo -u SERVER_USER test -w ${sh(root)}`,
      )
    // Final review 2026-10-17 (minor 3): as for the files in it, only a data directory its owner
    // alone may enter names that user.
    else if (asRoot && owner!.uid !== 0 && !sole)
      report(
        'warn',
        `Backup folder root ${root}: doctor runs as root, which writes anywhere, and the data directory, ` +
          `open to others, does not name the server's user; check with: sudo -u SERVER_USER test -w ${sh(root)}`,
      )
    // Fourth review (minor 6): the kernel's yes, the user's groups and ACLs included, stands.
    else if (
      asRoot &&
      sole &&
      !writableBy(stat(root), sole.uid, sole.gid) &&
      !(account?.uid === sole.uid && account.canWrite?.(root.split(sep).join('/')))
    )
      report(
        'warn',
        `Backup folder root ${root} may not be writable by the server's user (uid ${sole.uid}, who owns ` +
          `the data directory); check with: sudo -u '#${sole.uid}' test -w ${sh(root)} && echo writable`,
      )
    else report('ok', `Backup folder root ${root}`)
  }
  // Last review 2026-10-18 (minor 3): what else the unit lets the service write into, and the
  // folders above it, whatever the config says; judged only against the roots the service uses.
  for (const entry of serviceRoots ? (sandbox ?? []) : []) {
    const writes = real(entry)
    const same = (path: string) => isAbsolute(path) && real(path) === writes
    if (same(config.dataDir) || same(service.dataDir) || roots.some(same)) {
      // Final review (important 1): the same folder by another way, through links whoever may change
      // their folders may point anywhere at the service's next start.
      // Final re-review (minor 2): a root by this very name was judged by this very walk above.
      if (roots.some((r) => isAbsolute(r) && resolve(r) === resolve(entry))) continue
      const way = walkOf(entry)
      const theirs = account ? linkMayChange(way, selfFs, account) : null
      const loose = theirs ? null : linkLoose(way, selfFs)
      // Final re-review (minor 3): which of the two it is.
      const what = same(config.dataDir) || same(service.dataDir) ? 'the data directory' : 'a folder root'
      if (theirs)
        report(
          'warn',
          `The systemd service's unit entry ${entry} leads to ${what} through links: ` +
            serviceChangeText(theirs, 'the unit entry') +
            (theirs.changed ? '' : `; to leave the entry out, ${STALE}`),
        )
      // Final re-review (minor 4): said of the entry, with what to do of it.
      else if (loose)
        report(
          'warn',
          looseParentText(loose, entry, 'the unit entry') +
            (loose.changed ? '' : ` To leave the entry out, ${STALE}.`),
        )
      continue
    }
    // Re-review 2026-10-18 (minor 2): one an earlier install or systemctl edit put there.
    const link = walkOf(entry).dangling ?? null
    if (link) {
      report('warn', `The systemd service's unit names ${entry}: ${nowhere(walkOf(entry))}; ${STALE}`)
      continue
    }
    report(
      'warn',
      `The systemd service may write into ${entry}, which no folder root leads to now (one removed ` +
        `since, a link that leads elsewhere now, or one added with systemctl edit): ${STALE}`,
    )
    const theirs = account ? serviceMayChangeOn(walkOf(entry), selfFs, account, posixReal(entry)) : null
    const loose = theirs ? null : looseAbove(entry, writes)
    if (theirs)
      report(
        'warn',
        `The systemd service's unit entry ${entry}: ${serviceChangeText(theirs, 'the unit entry')}`,
      )
    else if (loose) report('warn', looseParentText(loose, entry, 'the unit entry'))
  }
  if (config.backup.privateNetworks.length)
    report('ok', `Destinations may reach private networks: ${config.backup.privateNetworks.join(', ')}`)

  // Review of the CI fixes (minor 9): found by the server's own rules, so what doctor says is what
  // the server does: side by side, on an absolute path, each telling its version.
  const tools = await findTools(config.backup.toolsPath ?? null, io.env, io.platform)
  if (!tools) {
    report(
      'warn',
      'mongodump/mongorestore not found: dump and restore are unavailable (optional; set MM_MONGODB_TOOLS_PATH ' +
        'to the folder that holds both, an absolute path)',
    )
  } else if (tools.version === 'unknown') {
    report(
      'warn',
      `mongodump/mongorestore in ${dirname(tools.dump)} do not run or do not say their version: they are not used`,
    )
  } else if (!versionOk(tools.version)) {
    report(
      'warn',
      `mongodump/mongorestore ${tools.version} in ${dirname(tools.dump)} are too old: 100.9 or later is needed, ` +
        'and 100.16 or later for MongoDB 8.3 and later',
    )
  } else {
    report(
      'ok',
      `mongodump and mongorestore ${tools.version} found (dump/restore available` +
        `${versionOk(tools.version, [100, 16, 0]) ? '' : '; MongoDB 8.3 and later need 100.16 or later'})`,
    )
  }

  return failed ? 1 : 0
}
