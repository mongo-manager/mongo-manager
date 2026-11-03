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
import { renderSystemdUnit, serviceConfigJson, type ServiceOptions } from './render'
import { checkUserName } from './validate'
import {
  LINE_BREAK,
  ONCE_STILL,
  leadsNowhere,
  linkMayChange,
  looseParentOn,
  looseParentText,
  outermost,
  plainPath,
  refusalOf,
  SERVICE_CHANGE_FIX,
  serviceChangeText,
  serviceMayChangeOn,
  walkPath,
  under,
  type ServiceAccount,
} from './sandbox'
import type { Sys } from './sys'

const UNIT = 'mongo-manager'

/**
 * The value an EnvironmentFile gives a variable, as systemd's parser reads it (fifth review
 * 2026-10-17, minor 4): its last assignment; a quote opens only at the start of a value or right
 * after a closing one; a backslash escapes in double quotes only before " \ ` $; a backslash and
 * newline continue the line outside single quotes; a quoted value may span lines; trailing spaces
 * are dropped after the last quote only, so a quoted value keeps its own (whole-branch review, minor 3).
 */
export function envValue(text: string, name: string): string | undefined {
  let found: string | undefined
  let state: 'key' | 'pre' | 'value' | 'single' | 'double' | 'comment' = 'key'
  let key = ''
  let value = ''
  let quoted = 0
  const done = () => {
    if (key.trim() === name) found = value.slice(0, quoted) + value.slice(quoted).replace(/\s+$/, '')
    key = ''
    value = ''
    quoted = 0
    state = 'key'
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]
    if (state === 'key') {
      if (c === '\n') key = ''
      else if (key.trim() === '' && (c === '#' || c === ';')) state = 'comment'
      else if (c === '=') state = 'pre'
      else key += c
    } else if (state === 'comment') {
      if (c === '\n') state = 'key'
    } else if (state === 'single') {
      if (c === "'") [state, quoted] = ['pre', value.length]
      else value += c
    } else if (state === 'double') {
      if (c === '"') [state, quoted] = ['pre', value.length]
      else if (c === '\\' && next === '\n') i++
      else if (c === '\\' && next !== undefined && '"\\`$'.includes(next)) value += text[++i]
      else value += c
    } else if (c === '\n') done()
    else if (c === '\\' && next === '\n') i++
    else if (c === '\\' && next !== undefined) {
      value += text[++i]
      state = 'value'
    } else if (state === 'pre' && (c === ' ' || c === '\t')) continue
    else if (state === 'pre' && c === "'") state = 'single'
    else if (state === 'pre' && c === '"') state = 'double'
    else {
      value += c
      state = 'value'
    }
  }
  if (state !== 'key' && state !== 'comment') done()
  return found
}

/**
 * Third review 2026-10-17 (important): the backup folder roots the service's sandbox must let it
 * write into. As the server reads them (fourth review, minor 3): the env file's, when it sets them,
 * in place of the config file's.
 */
export function serviceFolderRoots(configJson: string, envText: string | null): string[] {
  const fromEnv = envText === null ? undefined : envValue(envText, 'MM_BACKUP_FOLDER_ROOTS')
  let roots: unknown[]
  // Empty, as the server reads it (fifth review, minor 3), is not set: the config file's stand.
  if (fromEnv !== undefined && fromEnv !== '') roots = fromEnv.split(':')
  else {
    try {
      const file = (JSON.parse(configJson) as { backup?: { folderRoots?: unknown } }).backup?.folderRoots
      roots = Array.isArray(file) ? file : []
    } catch {
      roots = []
    }
  }
  const absolute = roots
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim())
    .filter((r) => r.startsWith('/'))
  return [...new Set(absolute)]
}

/** A number id gives: one line, an integer. */
const idNumber = (r: { status: number; stdout: string }) => {
  const n = Number(r.stdout.trim())
  return r.status === 0 && r.stdout.trim() !== '' && Number.isInteger(n) ? n : undefined
}

/**
 * Sixth review (minor 7): who the unit runs the service as, a drop-in's settings included: User=, and
 * the groups it gives the service besides that user's own, Group= and SupplementaryGroups=, names or
 * numbers.
 */
export interface UnitIds {
  user?: string
  group?: string
  extra: string[]
  /** DynamicUser=yes: systemd runs it as a user of its own, unless one of that name exists. */
  dynamic?: boolean
  /** systemctl show failed: nothing is known (ninth review, important 2). */
  failed?: boolean
}

/**
 * As systemd runs the service, with the unit and every drop-in loaded (eighth review, important): its
 * own reading, which no parser of ours can miss a line continuation, a reset or a quote of.
 */
export function unitIds(sys: Sys): UnitIds {
  const r = sys.run('systemctl', [
    'show',
    UNIT,
    '-p',
    'User',
    '-p',
    'Group',
    '-p',
    'SupplementaryGroups',
    '-p',
    'DynamicUser',
  ])
  if (r.status !== 0) return { extra: [], failed: true }
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(r.stdout)?.[1]?.trim() ?? ''
  return {
    ...(value('User') ? { user: value('User') } : {}),
    ...(value('Group') ? { group: value('Group') } : {}),
    extra: value('SupplementaryGroups').split(/\s+/).filter(Boolean),
    ...(value('DynamicUser') === 'yes' ? { dynamic: true } : {}),
  }
}

/**
 * Ninth review (important 1): the account systemd runs the service as: User=, or with DynamicUser=yes
 * and none, one named as the unit, which systemd takes when it exists; undefined is root.
 */
export const unitUser = (ids: UnitIds) => ids.user ?? (ids.dynamic ? UNIT : undefined)

/** A uid id gives for a name or a number (+uid, read as a number: sixth review, minor 6). */
const uidOf = (sys: Sys, user: string) =>
  idNumber(sys.run('id', ['-u', /^\d+$/.test(user) ? `+${user}` : user]))

/**
 * A group's gid: a number is one, a name is looked up with getent, which prints NAME:x:GID:members and
 * exits 2 for a group no one has (eighth review, minor 3); another failure is a lookup that failed.
 */
function groupId(sys: Sys, group: string): { status: number; gid?: number } {
  if (/^\d+$/.test(group)) return { status: 0, gid: Number(group) }
  const r = sys.run('getent', ['group', group])
  const field = r.stdout.trim().split(':')[2] ?? ''
  return r.status === 0 && /^\d+$/.test(field) ? { status: 0, gid: Number(field) } : { status: r.status || 1 }
}

/**
 * The service's user as the folder checks need it, or null when id does not give its uid and no
 * fallback is given. The name is a plain account name (validate.ts, so it needs no '--' before it) or
 * a uid, which is given as +uid so that id reads it as a number (sixth review, minor 6). Its groups are
 * id's and the unit's: systemd leaves out the user's own primary group when Group= names another, which
 * is counted anyway, on the safe side (seventh review, minor 7). A group the unit names that the system
 * does not know keeps the service from starting (seventh review, minor 2). Run as root, the kernel
 * says whether the user may write into a folder, its groups and ACLs included: setpriv, which opens no
 * PAM session and logs nothing (fourth review, minor 4), once a folder; else the mode alone is read.
 */
export function serviceAccount(
  sys: Sys,
  user: string,
  asRoot: boolean,
  unit: UnitIds,
): ServiceAccount | null {
  const name = /^\d+$/.test(user) ? `+${user}` : user
  const uid = idNumber(sys.run('id', ['-u', name]))
  if (uid === undefined) return null
  const listed = sys.run('id', ['-G', name])
  const own =
    listed.status === 0
      ? listed.stdout
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((g) => Number.isInteger(g))
      : []
  const lookups = new Map<string, { status: number; gid?: number }>()
  const gidOf = (group: string) => {
    if (!lookups.has(group)) lookups.set(group, groupId(sys, group))
    return lookups.get(group)!
  }
  const named = [...(unit.group ? [unit.group] : []), ...unit.extra].map((g) => [g, gidOf(g)] as const)
  const badGroup = named.find(([, r]) => r.status === 2)?.[0]
  const lostGroup = named.find(([, r]) => r.status !== 0 && r.status !== 2)?.[0]
  const groups = [...new Set([...own, ...named.flatMap(([, r]) => (r.gid === undefined ? [] : [r.gid]))])]
  const known = {
    uid,
    groups,
    ...(badGroup ? { badGroup } : {}),
    ...(lostGroup ? { lostGroup } : {}),
  }
  if (!asRoot || badGroup || lostGroup) return known
  const gid = unit.group ? gidOf(unit.group).gid : idNumber(sys.run('id', ['-g', name]))
  const as = (args: string[]) =>
    sys.run('setpriv', [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      groups.length ? `--groups=${groups.join(',')}` : '--clear-groups',
      '--',
      ...args,
    ])
  // Fifth review (minor 1): a setpriv that cannot run as the user at all is said once, not taken
  // for the kernel's no of each folder.
  if (gid === undefined || as(['true']).status !== 0) return { ...known, unasked: true }
  const asked = new Map<string, boolean>()
  const canWrite = (dir: string) => {
    if (!asked.has(dir)) asked.set(dir, as(['test', '-w', dir]).status === 0)
    return asked.get(dir)!
  }
  return { ...known, canWrite }
}

/** What install and doctor say of a group the unit names that the system does not know. */
export const badGroupText = (group: string) =>
  `the unit gives the service the group ${group}, which the system does not know: systemd refuses to ` +
  'start the service (216/GROUP); check Group= and SupplementaryGroups= with: systemctl cat mongo-manager'

/** What install and doctor say of a group whose lookup failed (eighth review, minor 3). */
export const lostGroupText = (group: string) =>
  `the group ${group} the unit gives the service could not be looked up (getent failed), so whether ` +
  'its members may change a folder above a folder root is not known'

/**
 * Eighth review (minor 5): the line that adds a folder to the unit by hand, for its real path, as
 * systemd reads it: quoted, with its backslashes and quotes escaped and % doubled.
 */
export const handAddLine = (real: string) =>
  `ReadWritePaths=-"${real.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`

/**
 * Ninth review (minor 6): how to add a folder by hand, or, for one whose real path has a line break,
 * which no unit can name, that it must be renamed.
 */
const handAdd = (real: string, how: string) =>
  /[\r\n]/.test(real)
    ? `rename it: ${LINE_BREAK}`
    : `add its real path, as ${handAddLine(real)} in [Service], ${how}`

/** What install and doctor say when setpriv could not be asked (fifth review, minor 1). */
export const unaskedText = (user: string) =>
  `setpriv could not run as the service's user ${user}, so the folders above the folder roots were ` +
  "judged by their modes and that user's groups alone: an ACL that lets the user write into one is " +
  'not seen'

export async function installLinux(
  sys: Sys,
  io: Io,
  layout: Layout,
  opts: ServiceOptions & { user: string },
  program: ProgramSource,
  probe: (url: string) => Promise<boolean>,
): Promise<void> {
  const { user } = opts
  // Decide everything that can refuse before changing anything (Review Focus 1), but what systemd must
  // be asked, with the unit written: who runs the service (see below).
  const envExists = sys.exists(layout.envFile!)
  const hasKeyFile = assertKeyNotLost(sys, layout, envExists)
  const config = serviceConfigJson(
    sys.exists(layout.configFile) ? sys.read(layout.configFile) : null,
    opts,
    layout,
  )
  checkServiceConfig(config, layout)
  const roots = serviceFolderRoots(config, envExists ? sys.read(layout.envFile!) : null)
  checkProgramLocation(sys, layout)
  const inPlace = installedInPlace(layout, program)
  checkInPlace(sys, layout, program, inPlace)

  if (sys.run('id', ['-u', user]).status !== 0) {
    must(sys, 'useradd', [
      '--system',
      '--home-dir',
      layout.dataDir,
      '--no-create-home',
      '--shell',
      '/usr/sbin/nologin',
      '--user-group',
      user,
    ])
  }
  const group = accountGroup(sys, user)
  if (!inPlace) sys.copyProgram(program, layout.programDir)
  try {
    checkProgram(sys, layout, program)
  } catch (e) {
    // The unit would otherwise restart into files that failed the check.
    sys.run('systemctl', ['disable', '--now', UNIT])
    io.stderr.write(STOPPED)
    throw e
  }
  const writeUnit = (writablePaths: string[]) =>
    sys.write(
      layout.unit,
      renderSystemdUnit({
        command: programCommand(layout, program),
        config: layout.configFile,
        dataDir: layout.dataDir,
        user,
        envFile: layout.envFile,
        logFile: null,
        writablePaths,
        // Updater: only the account made for the service is the app's alone.
        isolate: user === layout.defaultUser,
      }),
      0o644,
    )
  // Eighth review (important): who runs the service, and with which groups, is asked of systemd, with
  // the unit and every drop-in loaded: the unit goes in without folder roots first, and they are
  // judged then. Ninth review (minor 2): asked before the data directory, config or env file change, so
  // that a stop leaves the account, the program (checked) and the unit alone changed. A drop-in that
  // runs the service as an account other than --user, who owns its data directory and config, or with
  // a group no one has or without --user's own, stops it here.
  writeUnit([])
  must(sys, 'systemctl', ['daemon-reload'])
  const ids = unitIds(sys)
  const stop = (why: string) => {
    const off = sys.run('systemctl', ['disable', '--now', UNIT]).status === 0
    return new Error(
      `${why}, then run 'mongo-manager service install' again with sudo. ` +
        (off
          ? 'The service is stopped and disabled until then.'
          : 'The service could not be stopped and disabled (systemctl disable --now failed).'),
    )
  }
  const remove = 'remove it with: sudo systemctl edit mongo-manager'
  if (!ids.failed) {
    const runs = unitUser(ids)
    const runsUid = runs === undefined ? 0 : uidOf(sys, runs)
    // Ninth review (important 1): DynamicUser=yes takes an account of that name when one exists.
    if (ids.dynamic && runsUid === undefined)
      throw stop(
        `A drop-in sets DynamicUser=yes, and no account ${runs} exists, so systemd would run the service as ` +
          `a user of its own, not ${user}, who owns its data directory and config: ${remove}`,
      )
    // Ninth review (minor 1): compared by uid, so a User= of --user's uid is --user.
    if (runsUid !== uidOf(sys, user)) {
      const plain =
        runs !== undefined &&
        runsUid !== 0 &&
        (() => {
          try {
            return checkUserName(runs) === runs
          } catch {
            return false
          }
        })()
      throw stop(
        `A drop-in runs the service as ${runsUid === 0 ? 'root' : runs}, not ${user}, who owns its data ` +
          `directory and config: ${plain ? `run service install with --user ${runs}, or ` : ''}remove that ` +
          'User= with: sudo systemctl edit mongo-manager',
      )
    }
    // Ninth review (minor 10): Group= of another group leaves out --user's own, which owns the config.
    if (ids.group) {
      const set = groupId(sys, ids.group)
      const own = idNumber(sys.run('id', ['-g', user]))
      if (set.status === 0 && own !== undefined && set.gid !== own)
        throw stop(
          `A drop-in sets Group=${ids.group}, so systemd would run the service without the group of ` +
            `${user}, which can read its config: ${remove}`,
        )
    }
  }
  // Re-review 2026-10-18 (important 2): a folder above a root that the service's user may change, up
  // to /, lets a process running as it put a link to /etc there, so such a root is left out; and so
  // is every root when that user's id cannot be read (third review, minor 9), or systemd cannot be
  // asked who it is (ninth review, important 2).
  const account = ids.failed ? null : serviceAccount(sys, user, true, ids)
  if (account?.badGroup) throw stop(badGroupText(account.badGroup).replace(/^t/, 'T'))
  // Ninth review (minor 3), whole-branch review (minor 5): a failure from here to the unit's last
  // write leaves it without folder roots, which is said.
  const guarded = <T>(work: () => T): T => {
    try {
      return work()
    } catch (e) {
      io.stderr.write(
        "Warning: the service's unit is left without folder roots: run 'mongo-manager service install' " +
          'again with sudo.\n',
      )
      throw e
    }
  }
  guarded(() => {
    sys.mkdir(posix.dirname(layout.configFile), 0o755)
    sys.mkdir(layout.dataDir, 0o700)
    chownTree(sys, layout.dataDir, user, group)
    sys.write(layout.configFile, config, 0o640)
    must(sys, 'chown', [`root:${group}`, layout.configFile])
    if (!envExists) {
      sys.write(
        layout.envFile!,
        hasKeyFile
          ? '# The key is in the data directory (secret.key).\n'
          : `MM_SECRET_KEY=${sys.randomKey()}\n`,
        0o600,
      )
    }
  })
  // Fifth review 2026-10-17 (important): judged, and written into the unit, where they really are,
  // as systemd follows a link at each start: a link to /etc is /etc. Whole-branch re-review (important
  // 2): each root walked once, just before it is judged and written, for its real path and the links on
  // its way alike, so that none can come or go between the two.
  const walks = guarded(() => new Map(roots.map((r) => [r, walkPath(r, sys)])))
  const real = new Map(roots.map((r) => [r, walks.get(r)!.real]))
  const refused = new Map(
    roots.flatMap((r) => {
      const why = refusalOf(r, walks.get(r)!, layout)
      return why ? [[r, why] as const] : []
    }),
  )
  const kept = roots.filter((r) => !refused.has(r))
  if (ids.failed && kept.length)
    io.stderr.write(
      'Warning: systemd could not be asked who runs the service (systemctl show failed), so no folder ' +
        "root is added to the service's sandbox.\n",
    )
  if (account?.lostGroup && kept.length) io.stderr.write(`Warning: ${lostGroupText(account.lostGroup)}.\n`)
  else if (account?.unasked && kept.length) io.stderr.write(`Warning: ${unaskedText(user)}.\n`)
  // One a group whose lookup failed may change is not known either: every root is left out.
  const judged = account && !account.lostGroup ? account : null
  // Whole-branch review (important 1): the folders the links on a root's way are in too.
  const loose = guarded(() => new Map(kept.map((r) => [r, looseParentOn(walks.get(r)!, sys)])))
  const theirs = guarded(
    () =>
      new Map(
        kept.flatMap((r) => {
          const found = judged ? serviceMayChangeOn(walks.get(r)!, sys, judged) : null
          return !judged || found ? [[r, found] as const] : []
        }),
      ),
  )
  // One refused, behind a link the service may point anywhere, is said to be that: making the folder
  // a link to nothing leads to would be making the service's own choice.
  const refusedTheirs = guarded(
    () =>
      new Map(
        judged
          ? [...refused.keys()].flatMap((r) => {
              const found = linkMayChange(walks.get(r)!, sys, judged)
              return found ? [[r, found] as const] : []
            })
          : [],
      ),
  )
  // Re-review 2026-10-18 (important 2): one inside another root is in the sandbox by that one, with
  // no entry of its own whose place a link could take; one to add by hand included (third review,
  // important 1).
  // The outermost, which has an entry of its own (fourth review, minor 5); of two that lead to the
  // same folder, the one with a plain name, which is the one shown (fifth review, minor 4).
  const outer = (r: string) =>
    outermost(
      kept.filter((o) => !theirs.has(o) && real.get(o) !== real.get(r) && under(real.get(r)!, real.get(o)!)),
      (o) => real.get(o)!,
    )
  const inside = new Map(
    kept.flatMap((r) => {
      const o = outer(r)
      return o ? [[r, o] as const] : []
    }),
  )
  const entries = kept.filter((r) => !inside.has(r) && !theirs.has(r))
  // Final review 2026-10-17 (minor 1): a refused root gets its reason alone, not also systemctl edit.
  // Seventh review (minor 8): the unit is given the real path, so that is the one systemd must read.
  const unplain = entries.filter((r) => !plainPath(real.get(r)!))
  const writable = entries.filter((r) => !unplain.includes(r))
  guarded(() => writeUnit([...new Set(writable.map((r) => real.get(r)!))]))
  const toAdd = new Set<string>()
  for (const root of unplain) {
    if (toAdd.has(real.get(root)!)) continue
    toAdd.add(real.get(root)!)
    // Fourth review (minor 5): the roots inside it are in the sandbox by it, once it is added.
    // Ninth review (minor 7): by real path, whichever name of the folder the roots were matched to.
    const waiting = kept.filter((r) => inside.has(r) && real.get(inside.get(r)!) === real.get(root))
    io.stderr.write(
      `Warning: the folder root ${root} was not added to the service's sandbox (a space, quote, ` +
        'backslash or % in it); folder backups there fail until you ' +
        handAdd(real.get(root)!, `with: sudo systemctl edit ${UNIT}`) +
        (waiting.length
          ? `. Folder backups in the roots inside it fail until then too: ${waiting.join(', ')}`
          : '') +
        '\n',
    )
  }
  for (const [root, why] of refused) {
    const found = refusedTheirs.get(root)
    if (found) {
      io.stderr.write(
        `Warning: the folder root ${root} was not added to the service's sandbox: ${serviceChangeText(found)}.` +
          (found.changed ? '\n' : ` To use it, ${SERVICE_CHANGE_FIX}, or choose another folder.\n`),
      )
      continue
    }
    // Re-review 2026-10-18 (minor 4): what to do of a link that leads nowhere is make where it leads,
    // when who may point it is known (whole-branch re-review, minor 5).
    // Whole-branch re-re-re-review (minor 1): the folder is to be made only for a link to one not made yet.
    const { dangling: link, why: lost } = walks.get(root)!
    io.stderr.write(
      link && lost !== 'changed' && !root.split('/').includes('..')
        ? `Warning: the folder root ${root} was not added to the service's sandbox: ${leadsNowhere(link, lost)}, ` +
            'which systemd would follow wherever it leads at a later start. ' +
            (lost !== 'missing'
              ? 'Choose another folder, or remove the link.\n'
              : judged
                ? 'Make the folder it leads to, then run service install again.\n'
                : 'Who may point it elsewhere could not be judged: run service install again.\n')
        : `Warning: the folder root ${root} was not added to the service's sandbox: ${why}. ` +
            // Final review (minor 4): a walk that changed under it, as doctor says of it.
            (lost === 'changed' && !root.split('/').includes('..')
              ? `To use it, ${ONCE_STILL}.\n`
              : 'Folder backups there fail; choose another folder.\n'),
    )
  }
  for (const [root, found] of theirs)
    if (!inside.has(root))
      io.stderr.write(
        `Warning: the folder root ${root} was not added to the service's sandbox: ` +
          (found
            ? `${serviceChangeText(found)}.` +
              (found.changed ? '\n' : ` To use it, ${SERVICE_CHANGE_FIX}, or choose another folder.\n`)
            : // Ninth review (minor 4): the reason once, in the warning above.
              ids.failed
              ? 'systemd could not be asked who runs the service (see above). Run service install again.\n'
              : account?.lostGroup
                ? `a group the unit gives the service could not be looked up (see above). Run service ` +
                  'install again.\n'
                : `the id of the service's user ${user} could not be read, so whether that user may change a ` +
                  'folder above the root is not known. Run service install again.\n'),
      )
  // Last review 2026-10-18 (minor 4): one to add by hand as well, which the admin is told to add.
  // Once a folder the unit names, by the first root that leads there.
  const warned = new Set<string>()
  for (const root of entries) {
    const found = loose.get(root)
    if (found && !warned.has(real.get(root)!)) io.stderr.write(`Warning: ${looseParentText(found, root)}\n`)
    warned.add(real.get(root)!)
  }
  const shown = kept
    .filter((r) => writable.includes(r) || writable.includes(inside.get(r)!))
    .map((r) =>
      inside.has(r) ? `${r} (in ${inside.get(r)})` : real.get(r) === r ? r : `${r} (${real.get(r)})`,
    )
  if (shown.length) io.stdout.write(`Folder roots the service may write into: ${shown.join(', ')}\n`)
  must(sys, 'systemctl', ['daemon-reload'])
  must(sys, 'systemctl', ['enable', UNIT])
  must(sys, 'systemctl', ['restart', UNIT])
  await waitHealthy(serviceUrl(config), probe, io)
  io.stdout.write(
    `Config: ${layout.configFile}\nData: ${layout.dataDir}\n` +
      // Whole-branch review (important 2): doctor checks the service only given its config.
      `Check it with: sudo mongo-manager doctor --config ${layout.configFile}\n` +
      `First run: the one-time setup token is in a file: sudo cat "${posix.join(layout.dataDir, 'setup-token')}"\n`,
  )
}

export function uninstallLinux(sys: Sys, io: Io, layout: Layout): void {
  if (sys.exists(layout.unit)) {
    const r = sys.run('systemctl', ['disable', '--now', UNIT])
    if (r.status !== 0) {
      throw new Error(
        `systemd could not stop and disable ${UNIT} (${r.stderr.trim() || `exit ${r.status}`}); nothing was removed. ` +
          `Run: systemctl disable --now ${UNIT}`,
      )
    }
  }
  sys.remove(layout.unit)
  sys.run('systemctl', ['daemon-reload'])
  // Third review of the CI fixes (minor 4): and what a failed install left beside it, which a later
  // install would otherwise take for the earlier program; the program last, so a removal that fails
  // leaves it in place, never an .old alone (fourth review, minor 4).
  for (const p of [`${layout.programDir}.old`, `${layout.programDir}.new`, layout.programDir]) sys.remove(p)
  // The folder that held it, empty now, only tidied (eighth review of the CI fix 2026-10-20, minor
  // 3; ninth, important 1).
  const parent = posix.dirname(layout.programDir)
  const left = sys.removeEmptyDir(parent)
  io.stdout.write(
    `Mongo Manager was removed. Your data, config and key were kept:\n  ${layout.dataDir}\n  ${posix.dirname(layout.configFile)}\n` +
      'Delete them yourself only if you no longer need them.\n' +
      (left ? `${parent} was left (${left}); remove it yourself if it is empty.\n` : ''),
  )
}

export const statusLinux = (sys: Sys) => sys.runInherit('systemctl', ['status', UNIT, '--no-pager'])
export const logsLinux = (sys: Sys, follow: boolean) =>
  sys.runInherit('journalctl', ['-u', UNIT, '-n', '200', '--no-pager', ...(follow ? ['-f'] : [])])
