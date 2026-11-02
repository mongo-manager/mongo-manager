import { posix } from 'node:path'
import type { Layout } from './layout'

/**
 * No root is inside one of these (fifth review 2026-10-17: /run, /proc, /sys, /snap, ...; whole-branch
 * review, minor 14: /efi, where systemd mounts the EFI system partition, /lost+found and /nix).
 */
const SYSTEM =
  '/bin /boot /efi /etc /lib /lib32 /lib64 /libx32 /lost+found /nix /proc /run /sbin /snap /sys /usr'.split(
    ' ',
  )
/** Nor holds one of these: the system's, and the folders others keep their state, logs and devices in. */
const KEPT = [...SYSTEM, '/dev', '/opt', '/var', '/var/lib'].sort()
/** What the unit hides from the service (ProtectHome=yes). */
const HIDDEN = ['/home', '/root', '/run/user']
/** What the unit replaces with the service's own (PrivateTmp=yes, PrivateDevices=yes). */
const PRIVATE: Array<[string, string]> = [
  ['/tmp', 'PrivateTmp=yes'],
  ['/var/tmp', 'PrivateTmp=yes'],
  ['/dev', 'PrivateDevices=yes'],
]
/** Under /var, other services' state, logs and spools: only folders inside /var/backups are open. */
const VAR_OPEN = '/var/backups'
/**
 * Final review 2026-10-17 (important): folders other programs share, open only below. Root's own
 * backups write fixed names into /var/backups: a service that owned it could put a link in their
 * place, and root would write through it.
 */
const SHARED = ['/media', '/mnt', '/srv', VAR_OPEN]

/** A path as written, without '.', '//' or a trailing '/': doctor compares roots by it too. */
export const clean = (path: string) => posix.normalize(path).replace(/(.)\/+$/, '$1')
/** Whether path is dir or inside it. */
export const under = (path: string, dir: string) =>
  path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`)

/**
 * Fourth review 2026-10-17 (important): why a backup folder root cannot join the service's sandbox,
 * or null. A root at or above a system directory would undo ProtectSystem=strict (`/` lets the
 * service write wherever file modes allow); one systemd hides or replaces stays out of reach whatever
 * ReadWritePaths says.
 */
function sandboxRefusal(root: string, layout: Layout): string | null {
  // Fifth review 2026-10-17: the kernel takes '..' after a link, not as the text reads.
  if (root.split('/').includes('..')) return "it has a '..' in it, which a link before it can turn anywhere"
  const path = clean(root)
  const configDir = posix.dirname(layout.configFile)
  const holds = [...KEPT, layout.programDir, configDir, layout.dataDir].filter((d) => under(d, path))
  if (holds.length)
    return `it holds ${holds.join(', ')}: letting the service write there would undo its sandbox`
  if (under(path, layout.dataDir))
    return 'it is inside the data directory, where folder destinations are refused'
  const hidden = HIDDEN.find((d) => under(path, d))
  if (hidden) return `systemd hides ${hidden} from the service (ProtectHome=yes)`
  const own = PRIVATE.find(([d]) => under(path, d))
  if (own) return `the service has its own empty ${own[0]} (${own[1]})`
  const system = [layout.programDir, configDir, ...SYSTEM].find((d) => under(path, d))
  if (system) return `it is inside ${system}, which the service must not write into`
  if (SHARED.includes(path))
    return `it is ${path} itself, which other programs share: choose a folder inside it`
  if (under(path, '/var') && !under(path, VAR_OPEN))
    return `it is inside /var, which the service must not write into (${VAR_OPEN} is open)`
  return null
}

/** What the path walk reads: a path's own owner and mode, a link not followed, and a link's text. */
export interface LinkFs {
  lstat(path: string): Stat | null
  readlink(path: string): string
}

const isLinkMode = (st: Stat) => (st.mode & 0o170000) === 0o120000

/** A link on a root's way, where it is (its folder's real path and its name), and its own owner. */
export interface Hop {
  at: string
  owner: Stat
}

/**
 * Where a root really is, and the links on the way there, as the kernel walks it: folder by folder,
 * each link followed where it stands (a relative one from its own folder), a link in a link's target
 * included, '..' taken after the folder it follows, at most 40 links (whole-branch re-review, important
 * 1). A root not made yet is its nearest existing folder's real path and the rest as written; a link
 * whose target is not all there leads nowhere (dangling). One walk gives the real path and every link
 * on it, so that no link can come or go between the two (important 2), and each link's own owner, not
 * its target's (important 3).
 */
export interface Walk {
  real: string
  hops: Hop[]
  dangling?: string
  /**
   * Why the dangling link leads nowhere (whole-branch re-re-re-review, minor 1): its target is not
   * there, it goes round in a loop, it goes through a file, or it changed while it was walked.
   */
  why?: 'missing' | 'loop' | 'file' | 'changed'
  /** More than 40 links on the way, the first of them named: the kernel gives up there. */
  tooMany?: string
}

export function walkPath(root: string, fs: LinkFs): Walk {
  let todo = clean(root).split('/').filter(Boolean)
  let done = '/'
  const hops: Hop[] = []
  // Each link followed, and how much of the way was left after it: a part missing while more than that
  // is left is a part of its target.
  const following: Array<{ at: string; rest: number }> = []
  // A link met again with the same way left after it goes round in a loop (minor 6).
  const met = new Set<string>()
  const nowhere = (path: string, at?: string, why: Walk['why'] = 'missing'): Walk => ({
    real: posix.join(path, ...todo),
    hops,
    ...(at ? { dangling: at, why } : {}),
  })
  const inside = () => [...following].reverse().find((l) => todo.length >= l.rest)?.at
  while (todo.length) {
    const name = todo.shift()!
    if (name === '.') continue
    if (name === '..') {
      done = posix.dirname(done)
      continue
    }
    const path = posix.join(done, name)
    const st = fs.lstat(path)
    if (st === null) return nowhere(path, inside())
    if (!isLinkMode(st)) {
      const type = st.mode & 0o170000
      if (todo.length && type !== 0 && type !== 0o040000) return nowhere(path, inside(), 'file')
      done = path
      continue
    }
    let target: string
    try {
      target = fs.readlink(path)
    } catch {
      // A link at lstat and none at readlink was swapped while it was walked.
      return nowhere(path, path, 'changed')
    }
    hops.push({ at: path, owner: st })
    const key = `${path}\0${todo.join('/')}`
    if (met.has(key)) return nowhere(path, hops[0]!.at, 'loop')
    met.add(key)
    // Past 40 links, too many to follow.
    if (hops.length > 40) return { ...nowhere(path), tooMany: hops[0]!.at }
    following.push({ at: path, rest: todo.length })
    todo = [...target.split('/').filter(Boolean), ...todo]
    if (target.startsWith('/')) done = '/'
  }
  return { real: done, hops }
}

/** What a dangling link is (re-review 2026-10-18, minor 4: a loop included). */
export const leadsNowhere = (link: string, why: Exclude<Walk['why'], 'changed'>) =>
  `${link} is a link that leads nowhere (${why === 'loop' ? 'round in a loop' : why === 'file' ? 'through a file' : 'to a folder not made yet'})`

/** What to do of a walk that changed under it (final review, minor 4): the same in install and doctor. */
export const ONCE_STILL = "run 'mongo-manager service install' again with sudo once nothing changes it"

/**
 * Why a root cannot join the sandbox, or null: judged where it really is first, then as written, by
 * the walk of it given. Install and doctor both ask this.
 */
export function refusalOf(root: string, walk: Walk, layout: Layout): string | null {
  // A '..' is judged as written: its real path would hide it.
  if (root.split('/').includes('..')) return sandboxRefusal(root, layout)
  // Last review 2026-10-18 (important): a link that leads nowhere is refused: systemd follows it, at each
  // start, wherever it then leads, a link to /etc made by whoever may make the folder it names included.
  if (walk.why === 'changed') return `${walk.dangling} changed while it was walked: it was a link, then none`
  if (walk.dangling) return leadsNowhere(walk.dangling, walk.why)
  if (walk.tooMany)
    return `${walk.tooMany} leads on through more than 40 links, which the kernel does not follow`
  // Whole-branch re-re-review (minor 10): where a link leads is said, as on ostree, where /srv is one.
  const there = sandboxRefusal(walk.real, layout)
  if (there) return walk.real === clean(root) ? there : `it leads to ${walk.real}; ${there}`
  return sandboxRefusal(root, layout)
}

/** A path systemd takes as it is in ReadWritePaths= (it splits on spaces, unquotes and expands %). */
export const plainPath = (path: string) =>
  [...path].every((c) => c > ' ' && c !== '\x7f' && !`"'\\%`.includes(c))

/** Owner and mode of a path (POSIX), and its group where known. */
type Stat = { uid: number; gid?: number; mode: number }

/**
 * What the folder checks read: each folder itself, a link not followed. A real path has no link on
 * it: one there now was put in a folder's place while the root was judged, and whoever did so may
 * point it anywhere at the service's next start (whole-branch re-re-review, important 1).
 */
type SelfFs = { lstat(path: string): Stat | null }

const changed = (dir: string): Loose => ({
  dir,
  why: "is a link now, put in a folder's place while the folder root was judged",
  changed: true,
})

/** What install and doctor say of a folder that changed while it was judged (minor 2). */
const changedText = (found: Loose, what = 'the folder root') =>
  `${found.dir} changed while ${what} was judged: a link is where a folder was, put there by ` +
  `someone who may change the folder it is in; ${ONCE_STILL}`

/** A folder above a root that a user other than root may change, and why. */
export interface Loose {
  dir: string
  why: string
  /** A link found where the walk saw a folder. */
  changed?: true
}

/**
 * What install and doctor say of a folder looseParent found: why, and what to do (last review
 * 2026-10-18, minor 1).
 */
export const looseParentText = (loose: Loose, root: string, what = 'the folder root') =>
  loose.changed
    ? changedText(loose, what)
    : `${loose.dir}, above ${what} ${root}, can be changed by a user other than root ` +
      `(${loose.why}): a link put in a folder's place there would move the service's writes at its next ` +
      'start. Keep each folder above a root owned by root and closed to its group and others; in a ' +
      'folder others may write into, sticky or not, have root own the folder in it, and make the root ' +
      'inside that one.'

/**
 * Final review 2026-10-17 (minor 5): the first folder above a root's real path that a user other
 * than root may change, or null: one such a user owns, or one a group or others may write into,
 * unless sticky (as /tmp is) over a root-owned entry. systemd follows a link at each start: one put
 * there in a folder's place would move the service's writes. A sticky folder shelters neither what is
 * not there yet, which anyone who may write into it may make, a link included (final re-review
 * 2026-10-18, important), nor an entry a user other than root owns, and so may rename (last review,
 * minor 3).
 */
export function looseParent(real: string, sys: SelfFs, own?: Stat): Loose | null {
  let entry = real
  let below = own ?? sys.lstat(real)
  if (below !== null && !own && isLinkMode(below)) return changed(real)
  for (let dir = posix.dirname(real); ; dir = posix.dirname(dir)) {
    const st = sys.lstat(dir)
    if (st !== null && isLinkMode(st)) return changed(dir)
    if (st !== null && st.uid !== 0) return { dir, why: `owned by uid ${st.uid}` }
    if (st !== null && (st.mode & 0o022) !== 0) {
      const writers =
        (st.mode & 0o002) !== 0 ? 'others' : `its group${st.gid === undefined ? '' : ` (gid ${st.gid})`}`
      if ((st.mode & 0o1000) === 0) return { dir, why: `${writers} may write into it` }
      if (below === null)
        return { dir, why: `sticky, but ${entry} in it is not made yet, and ${writers} may make it` }
      if (below.uid !== 0)
        return { dir, why: `sticky, but ${entry} in it is owned by uid ${below.uid}, who may rename it` }
    }
    entry = dir
    below = st
    // '/' at the top; a path without one (not a POSIX path) ends where dirname stops moving.
    if (dir === '/' || posix.dirname(dir) === dir) return null
  }
}

/**
 * The service's user as install and doctor know it: its uid and every group it is in (systemd gives
 * a User= service its supplementary groups), and, run as root, the kernel's own word on whether it
 * may write into a folder, ACLs included: true only when it says so.
 */
export interface ServiceAccount {
  uid: number
  groups: number[]
  canWrite?: (dir: string) => boolean
  /** Run as root, but setpriv could not run as the user: its ACLs are not seen. */
  unasked?: boolean
  /** A group the unit names that the system does not know (seventh review, minor 2). */
  badGroup?: string
  /** A group the unit names whose lookup failed (eighth review, minor 3). */
  lostGroup?: string
}

/**
 * Re-review 2026-10-18 (important 2), third review of it (important 1 and 2): the first folder above
 * a root's real path, up to /, that the service's user may change, and how, or null. A process
 * running as that user could put a link to /etc in a folder's place there, and systemd would follow
 * it at the service's next start, which the service may bring about by exiting.
 */
export function serviceMayChange(
  real: string,
  sys: SelfFs,
  account: ServiceAccount,
  own?: Stat,
): Loose | null {
  const user = "the service's user"
  let entry = real
  let below = own ?? sys.lstat(real)
  if (below !== null && !own && isLinkMode(below)) return changed(real)
  for (let dir = posix.dirname(real); ; dir = posix.dirname(dir)) {
    const st = sys.lstat(dir)
    if (st !== null && isLinkMode(st)) return changed(dir)
    if (st !== null && st.uid === account.uid) return { dir, why: `is owned by ${user}` }
    // Fourth review (important 1): the kernel's yes adds an ACL or a group the mode does not show;
    // its no, which a tool's own failure looks like too, takes nothing away from the mode's yes.
    const writes =
      st !== null &&
      ((st.mode & 0o002) !== 0 ||
        (st.gid !== undefined && account.groups.includes(st.gid) && (st.mode & 0o020) !== 0) ||
        account.canWrite?.(dir) === true)
    if (st !== null && writes) {
      if ((st.mode & 0o1000) === 0) return { dir, why: `may be written into by ${user}` }
      if (below === null)
        return { dir, why: `is sticky, but ${entry} in it is not made yet, and ${user} may write into it` }
      if (below.uid === account.uid)
        return { dir, why: `is sticky, but ${entry} in it is ${user}'s, who may rename it` }
    }
    entry = dir
    below = st
    if (dir === '/' || posix.dirname(dir) === dir) return null
  }
}

/** What install and doctor say of a folder serviceMayChange found (third review, minor 1). */
export const serviceChangeText = (found: Loose, what = 'the folder root') =>
  found.changed
    ? changedText(found, what)
    : `${found.dir}, above it, ${found.why}: a process running as that user could put a link to any folder ` +
      "in a folder's place there, and systemd would make that writable to the service at its next start"

/** What to do of it (third review, minor 2). */
export const SERVICE_CHANGE_FIX =
  'put the root inside a folder owned by root that no other user may write into'

/**
 * Whole-branch review (important 1): whoever may change the folder a link on a root's way is in may
 * point it elsewhere, and the next install would follow it there; the service, writing into another
 * root, could so have any folder added to its sandbox. Each link is judged in its folder, as its own.
 */
export function linkMayChange(walk: Walk, fs: SelfFs, account: ServiceAccount) {
  for (const hop of walk.hops) {
    const found = serviceMayChange(hop.at, fs, account, hop.owner)
    if (found) return found
  }
  return null
}

/** serviceMayChange of the links on a root's way, then of its real path. */
export const serviceMayChangeOn = (walk: Walk, fs: SelfFs, account: ServiceAccount, real = walk.real) =>
  linkMayChange(walk, fs, account) ?? serviceMayChange(real, fs, account)

/** looseParent of the links on a root's way alone (final review, important 1). */
export function linkLoose(walk: Walk, fs: SelfFs) {
  for (const hop of walk.hops) {
    const found = looseParent(hop.at, fs, hop.owner)
    if (found) return found
  }
  return null
}

/** looseParent of the links on a root's way, then of its real path. */
export const looseParentOn = (walk: Walk, fs: SelfFs, real = walk.real) =>
  linkLoose(walk, fs) ?? looseParent(real, fs)

/**
 * The outermost of the roots one is inside, by real path; of two that lead to the same folder, the
 * one with a plain name, which is the one shown (fifth review, minor 4). Install and doctor both take
 * it (whole-branch review, minor 7).
 */
export const outermost = (candidates: string[], realOf: (root: string) => string) =>
  [...candidates].sort(
    (a, b) => realOf(a).length - realOf(b).length || Number(!plainPath(a)) - Number(!plainPath(b)),
  )[0]

/** What a real path with a line break in it is (ninth review, minor 6). */
export const LINE_BREAK = 'its real path has a line break in it, which no unit can name'
