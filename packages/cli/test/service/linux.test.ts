import { describe, expect, it } from 'vitest'
import { UsageError, parseCli } from '../../src/args'
import { serviceCommand } from '../../src/commands/service'
import { serviceFolderRoots } from '../../src/service/linux'
import { looseParent } from '../../src/service/sandbox'
import { fakeIo } from '../support'
import { fakeSys } from './fake-sys'

const program = { node: '/usr/bin/node', cli: '/tmp/pkg/dist/cli.cjs', publicDir: '/tmp/pkg/public' }
const probe = async () => true

/** Runs `service install <argv>` with the real option parsing; usage errors become exit code 2 as in main. */
async function install(sys = fakeSys('linux'), argv: string[] = []) {
  const io = fakeIo()
  let code: number
  try {
    const { values } = parseCli(['service', 'install', ...argv])
    code = await serviceCommand(['install'], values, io, { sys, program, probe })
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    io.stderr.write(`Error: ${e.message}\n`)
    code = 2
  }
  return { code, io, sys }
}

describe('service install on Linux', () => {
  it('has the launcher end the account’s other processes for its own account, never for another (updater)', async () => {
    const own = await install()
    expect(own.sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).toContain(
      '--no-open --isolate-account',
    )
    const other = await install(fakeSys('linux'), ['--user', 'someoneelse'])
    expect(other.sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain(
      '--isolate-account',
    )
  })

  it('creates the user, copies the program, writes private config, key and hardened unit, and starts it', async () => {
    const fresh = fakeSys('linux')
    fresh.responses.push({ match: /^id -u mongo-manager$/, status: 1 })
    const { code, io, sys } = await install(fresh)
    expect(code).toBe(0)
    expect(sys.commands).toContain(
      'useradd --system --home-dir /var/lib/mongo-manager --no-create-home --shell /usr/sbin/nologin --user-group mongo-manager',
    )
    expect(sys.files.get('/opt/mongo-manager/app/dist/cli.cjs')).toBeDefined()
    expect(sys.dirs.get('/var/lib/mongo-manager')).toBe(0o700)
    expect(sys.commands).toContain('chown mongo-manager:mongo-manager /var/lib/mongo-manager')
    // Same owner already (a fresh directory): nothing inside is touched.
    expect(sys.commands.some((c) => c.startsWith('find '))).toBe(false)
    const config = sys.files.get('/etc/mongo-manager/config.json')!
    expect(config.mode).toBe(0o640)
    expect(JSON.parse(config.content)).toMatchObject({ auth: true, host: '127.0.0.1', webPort: 4321 })
    expect(sys.commands).toContain('chown root:mongo-manager /etc/mongo-manager/config.json')
    const env = sys.files.get('/etc/mongo-manager/env')!
    expect(env.mode).toBe(0o600)
    expect(env.content).toMatch(/^MM_SECRET_KEY=\S{40,}$/m)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).toContain(
      'User=mongo-manager',
    )
    expect(sys.commands.slice(-3)).toEqual([
      'systemctl daemon-reload',
      'systemctl enable mongo-manager',
      'systemctl restart mongo-manager',
    ])
    expect(io.out()).toMatch(/running at http:\/\/127\.0\.0\.1:4321\//)
    // The setup token is read from its file, never from the log (security review 2026-10-13).
    expect(io.out()).toContain('sudo cat "/var/lib/mongo-manager/setup-token"')
    expect(io.out()).not.toMatch(/journalctl -u mongo-manager \| grep/)
    expect(io.out() + io.err()).not.toContain('a2V5a2V5')
  })

  it('keeps config, key and data on reinstall and only changes given options (Review Focus 1)', async () => {
    const sys = fakeSys('linux')
    sys.files.set('/etc/mongo-manager/config.json', {
      content: JSON.stringify({ webPort: 4321, host: '127.0.0.1', auth: true, readOnly: true }),
      mode: 0o640,
    })
    sys.files.set('/etc/mongo-manager/env', { content: 'MM_SECRET_KEY=existing\n', mode: 0o600 })
    sys.responses.push({ match: /^id -u mongo-manager$/, status: 0 })
    const { code } = await install(sys, ['--web-port', '8080'])
    expect(code).toBe(0)
    expect(JSON.parse(sys.files.get('/etc/mongo-manager/config.json')!.content)).toMatchObject({
      webPort: 8080,
      readOnly: true,
    })
    expect(sys.files.get('/etc/mongo-manager/env')!.content).toBe('MM_SECRET_KEY=existing\n')
    expect(sys.commands.some((c) => c.startsWith('useradd'))).toBe(false)
  })

  // Third review 2026-10-17 (important): the sandbox let the server write into its data directory
  // alone, so every folder backup failed read-only. The roots its config and env file name join it.
  it('lets the service write into the folder roots its config and env file name', async () => {
    const sys = fakeSys('linux')
    sys.files.set('/etc/mongo-manager/config.json', {
      content: JSON.stringify({ auth: true, backup: { folderRoots: ['/srv/backups', '/mnt/a'] } }),
      mode: 0o640,
    })
    const first = await install(sys)
    expect(first.code).toBe(0)
    const lines = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content.split('\n')
    // A root that does not exist yet ('-') does not stop the service from starting.
    expect(lines.filter((l) => l.startsWith('ReadWritePaths='))).toEqual([
      'ReadWritePaths=/var/lib/mongo-manager',
      'ReadWritePaths=-/srv/backups',
      'ReadWritePaths=-/mnt/a',
    ])
    expect(first.io.out()).toContain('Folder roots the service may write into: /srv/backups, /mnt/a\n')

    // Fourth review 2026-10-17 (minor 3): as the server reads them, the env file's replace the config's.
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS="/mnt/b:/srv/backups"\n',
      mode: 0o600,
    })
    await install(sys)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit.split('\n').filter((l) => l.startsWith('ReadWritePaths=-'))).toEqual([
      'ReadWritePaths=-/mnt/b',
      'ReadWritePaths=-/srv/backups',
    ])
  })

  // Fourth review 2026-10-17 (minor 4): read as systemd reads an EnvironmentFile.
  it.each([
    ['spaces around =', 'MM_BACKUP_FOLDER_ROOTS = /a:/b', ['/a', '/b']],
    ['double quotes', 'MM_BACKUP_FOLDER_ROOTS="/a:/b"', ['/a', '/b']],
    ['single quotes', "MM_BACKUP_FOLDER_ROOTS='/a:/b'", ['/a', '/b']],
    // Fifth review 2026-10-17 (minor 4): systemd's parser, closer.
    ['a quote inside a value, kept', 'MM_BACKUP_FOLDER_ROOTS=/a"b":/c', ['/a"b"', '/c']],
    ['a backslash kept in double quotes', 'MM_BACKUP_FOLDER_ROOTS="/a\\b:/c\\"d"', ['/a\\b', '/c"d']],
    ['a single quote inside a value, kept', "MM_BACKUP_FOLDER_ROOTS=/a'b':/c", ["/a'b'", '/c']],
    ['a quoted value over two lines', 'MM_BACKUP_FOLDER_ROOTS="/a:\n/b"\nOTHER=1', ['/a', '/b']],
    ['a single-quoted value over two lines', "MM_BACKUP_FOLDER_ROOTS='/a:\n/b'\nOTHER=1", ['/a', '/b']],
    ['a continued line', 'MM_BACKUP_FOLDER_ROOTS=/a:\\\n/b', ['/a', '/b']],
    [
      'comments after it',
      'MM_BACKUP_FOLDER_ROOTS=/a\n# MM_BACKUP_FOLDER_ROOTS=/x\n;MM_BACKUP_FOLDER_ROOTS=/y',
      ['/a'],
    ],
    ['the last line', 'MM_BACKUP_FOLDER_ROOTS=/x\nMM_BACKUP_FOLDER_ROOTS=/a', ['/a']],
    // Fifth review 2026-10-17 (minor 3): the server takes an empty one for not set.
    ['an empty value, as not set', 'MM_BACKUP_FOLDER_ROOTS=', ['/from-config']],
  ])('reads the env file with %s', (_, env, roots) => {
    expect(serviceFolderRoots(JSON.stringify({ backup: { folderRoots: ['/from-config'] } }), env)).toEqual(
      roots,
    )
  })

  // Fourth review 2026-10-17 (important): a broad root undid the sandbox (ReadWritePaths=/ lets the
  // service write wherever file modes allow), and one systemd hides stayed out of reach, unsaid.
  it.each([
    [
      '/',
      'it holds /bin, /boot, /dev, /efi, /etc, /lib, /lib32, /lib64, /libx32, /lost+found, /nix, /opt, ' +
        '/proc, /run, /sbin, /snap, /sys, /usr, /var, /var/lib, /opt/mongo-manager/app, /etc/mongo-manager, ' +
        '/var/lib/mongo-manager: letting the service write there would undo its sandbox',
    ],
    // Whole-branch review (minor 14).
    ['/efi/x', 'it is inside /efi, which the service must not write into'],
    ['/nix/store/x', 'it is inside /nix, which the service must not write into'],
    [
      '/var/lib/',
      'it holds /var/lib, /var/lib/mongo-manager: letting the service write there would undo its sandbox',
    ],
    ['/etc/backups', 'it is inside /etc, which the service must not write into'],
    [
      '/opt/mongo-manager/app/x',
      'it is inside /opt/mongo-manager/app, which the service must not write into',
    ],
    [
      '/var/lib/mongo-manager/exports',
      'it is inside the data directory, where folder destinations are refused',
    ],
    ['/home/me/backups', 'systemd hides /home from the service (ProtectHome=yes)'],
    ['/root/b', 'systemd hides /root from the service (ProtectHome=yes)'],
    ['/tmp/b', 'the service has its own empty /tmp (PrivateTmp=yes)'],
    // Fifth review 2026-10-17 (minor 2).
    ['/run/lock/b', 'it is inside /run, which the service must not write into'],
    ['/run/user/1000/b', 'systemd hides /run/user from the service (ProtectHome=yes)'],
    ['/dev/shm/b', 'the service has its own empty /dev (PrivateDevices=yes)'],
    ['/proc/b', 'it is inside /proc, which the service must not write into'],
    ['/snap/b', 'it is inside /snap, which the service must not write into'],
    ['/var/log/b', 'it is inside /var, which the service must not write into (/var/backups is open)'],
    ['/var/lib/backups', 'it is inside /var, which the service must not write into (/var/backups is open)'],
    ['/srv/../etc', "it has a '..' in it, which a link before it can turn anywhere"],
    // Final review 2026-10-17 (important): root's own backups write fixed names into /var/backups.
    ['/var/backups', 'it is /var/backups itself, which other programs share: choose a folder inside it'],
    ['/srv', 'it is /srv itself, which other programs share: choose a folder inside it'],
    ['/mnt/', 'it is /mnt itself, which other programs share: choose a folder inside it'],
    ['/media', 'it is /media itself, which other programs share: choose a folder inside it'],
  ])('leaves out %s, and says why', async (root, reason) => {
    const sys = fakeSys('linux')
    sys.files.set('/etc/mongo-manager/env', {
      content: `MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=${root}:/srv/ok\n`,
      mode: 0o600,
    })
    const { code, io } = await install(sys)
    expect(code).toBe(0)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit.split('\n').filter((l) => l.startsWith('ReadWritePaths=-'))).toEqual([
      'ReadWritePaths=-/srv/ok',
    ])
    expect(io.err()).toContain(
      `Warning: the folder root ${root} was not added to the service's sandbox: ${reason}. ` +
        'Folder backups there fail; choose another folder.\n',
    )
  })

  // Fifth review 2026-10-17 (important): systemd follows a link at each start, so a link to /etc is
  // /etc; the unit names the real path, which a link swapped later does not move.
  it('judges a linked root by where it leads, and names that in the unit', async () => {
    const sys = fakeSys('linux')
    sys.dirs.set('/srv/to-etc', 0o755)
    sys.dirs.set('/srv/to-nas', 0o755)
    sys.realpaths.set('/srv/to-etc', '/etc')
    sys.realpaths.set('/srv/to-nas', '/mnt/nas')
    sys.links.add('/srv/to-etc').add('/srv/to-nas')
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/to-etc:/srv/to-nas/exports\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit.split('\n').filter((l) => l.startsWith('ReadWritePaths=-'))).toEqual([
      'ReadWritePaths=-/mnt/nas/exports',
    ])
    expect(io.err()).toContain(
      "Warning: the folder root /srv/to-etc was not added to the service's sandbox: it leads to /etc; it holds /etc, " +
        '/etc/mongo-manager: letting the service write there would undo its sandbox.',
    )
    expect(io.out()).toContain(
      'Folder roots the service may write into: /srv/to-nas/exports (/mnt/nas/exports)\n',
    )
  })

  // Final review 2026-10-17 (minor 1): one warning, the reason, for a root refused whatever its name.
  it('gives a refused root with a space in its real path one warning, its reason', async () => {
    const sys = fakeSys('linux')
    sys.dirs.set('/srv/x', 0o755)
    sys.realpaths.set('/srv/x', '/home/my files')
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/x\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(io.err()).toContain('systemd hides /home from the service (ProtectHome=yes)')
    expect(io.err()).not.toContain('systemctl edit')
  })

  // Final review 2026-10-17 (minor 5): systemd follows a link at each start, so a folder above a root
  // that a user other than root may change could move the service's writes.
  // Last review 2026-10-18 (minor 1): it says why, and what to do in each case.
  const LOOSE = (parent: string, root: string, why: string) =>
    `Warning: ${parent}, above the folder root ${root}, can be changed by a user other than root ` +
    `(${why}): a link put in a folder's place there would move the service's writes at its next ` +
    'start. Keep each folder above a root owned by root and closed to its group and others; in a ' +
    'folder others may write into, sticky or not, have root own the folder in it, and make the root ' +
    'inside that one.\n'
  async function installRoot(root: string, set: (sys: ReturnType<typeof fakeSys>) => void) {
    const sys = fakeSys('linux')
    // Last review 2026-10-18 (minor 7): under /srv, as on a real system, nothing for what is not there.
    sys.dirs.set('/srv', 0o755)
    const stat = sys.stat
    sys.stat = (p) => (p.startsWith('/srv/') && !sys.stats.has(p) && !sys.exists(p) ? null : stat(p))
    set(sys)
    sys.files.set('/etc/mongo-manager/env', {
      content: `MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=${root}\n`,
      mode: 0o600,
    })
    return (await install(sys)).io.err()
  }

  it.each([
    ['owned by another user', { uid: 1000, mode: 0o40755 }, 'owned by uid 1000'],
    ['writable by its group', { uid: 0, gid: 50, mode: 0o40775 }, 'its group (gid 50) may write into it'],
    ['sticky but owned by another user', { uid: 1000, mode: 0o41777 }, 'owned by uid 1000'],
  ])('warns when a folder above a root is %s', async (_, parent, why) => {
    const err = await installRoot('/srv/shared/backups', (sys) => {
      sys.stats.set('/srv/shared', parent)
      sys.dirs.set('/srv/shared/backups', 0o700)
    })
    expect(err).toContain(LOOSE('/srv/shared', '/srv/shared/backups', why))
  })

  // Last review 2026-10-18 (minor 4): one install leaves to systemctl edit is warned of as well.
  it('warns of a folder above a root to add by hand', async () => {
    const err = await installRoot('/srv/shared/my backups', (sys) => {
      sys.stats.set('/srv/shared', { uid: 1000, mode: 0o40755 })
    })
    expect(err).toContain('sudo systemctl edit mongo-manager')
    expect(err).toContain(LOOSE('/srv/shared', '/srv/shared/my backups', 'owned by uid 1000'))
  })

  // Last review 2026-10-18 (important): a link to nothing yet is no folder made yet; where it leads
  // is for whoever may make that folder, a link to /etc included, at the service's next start.
  it.each([
    ['the root', '/srv/backups', '/srv/backups'],
    ['a folder above it', '/srv/away/backups', '/srv/away'],
  ])('leaves out a root when %s is a link to nothing yet', async (_, root, link) => {
    const sys = fakeSys('linux')
    sys.links.add(link)
    sys.files.set('/etc/mongo-manager/env', {
      content: `MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=${root}:/srv/ok\n`,
      mode: 0o600,
    })
    const { io } = await install(sys)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit.split('\n').filter((l) => l.startsWith('ReadWritePaths=-'))).toEqual([
      'ReadWritePaths=-/srv/ok',
    ])
    expect(io.err()).toContain(
      `Warning: the folder root ${root} was not added to the service's sandbox: ${link} is a link that ` +
        'leads nowhere (to a folder not made yet), which systemd would follow ' +
        'wherever it leads at a later start. Make the folder it leads to, then run service install ' +
        'again.\n',
    )
  })

  // Re-review 2026-10-18 (minor 11): a link to nothing yet is that, whatever its name.
  it('says of a root to add by hand that is a link to nothing yet what it is, not how to add it', async () => {
    const sys = fakeSys('linux')
    sys.links.add('/srv/my link')
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/my link\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(io.err()).toContain('/srv/my link is a link that leads nowhere')
    expect(io.err()).not.toContain('systemctl edit')
  })

  // Re-review 2026-10-18 (important 2): the service could put a link to /etc in the place of a root
  // inside another, and systemd would follow it; the outer root lets it write there anyway.
  it('names a root inside another one in the unit by the outer one alone', async () => {
    const sys = fakeSys('linux')
    sys.files.set('/etc/mongo-manager/env', {
      content:
        'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/backups/daily:/srv/backups:/srv/backups/my weekly\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit.split('\n').filter((l) => l.startsWith('ReadWritePaths=-'))).toEqual([
      'ReadWritePaths=-/srv/backups',
    ])
    expect(io.err()).not.toContain('systemctl edit')
    expect(io.out()).toContain(
      'Folder roots the service may write into: /srv/backups/daily (in /srv/backups), /srv/backups, ' +
        '/srv/backups/my weekly (in /srv/backups)\n',
    )
  })

  // The reviewer's case: the outer root the service owns, as the docs advise, and one inside it, which
  // is no entry of its own and so warned of not at all.
  it('says nothing of a root inside another that the service owns', async () => {
    const sys = fakeSys('linux')
    sys.responses.push({ match: /^id -u mongo-manager$/, status: 0, stdout: '999\n' })
    sys.stats.set('/srv/backups', { uid: 999, mode: 0o40700 })
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/backups:/srv/backups/daily\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit.split('\n').filter((l) => l.startsWith('ReadWritePaths=-'))).toEqual([
      'ReadWritePaths=-/srv/backups',
    ])
    expect(io.err()).not.toContain('/srv/backups/daily')
  })

  // Fourth review (minor 5): a root is in the sandbox by the outermost root it is in, the one the unit
  // names.
  it('takes a root in by the outermost root it is in', async () => {
    const sys = fakeSys('linux')
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/a/b/c:/srv/a/b:/srv/a\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(
      sys.files
        .get('/etc/systemd/system/mongo-manager.service')!
        .content.split('\n')
        .filter((l) => l.startsWith('ReadWritePaths=-')),
    ).toEqual(['ReadWritePaths=-/srv/a'])
    expect(io.out()).toContain(
      'Folder roots the service may write into: /srv/a/b/c (in /srv/a), /srv/a/b (in /srv/a), /srv/a\n',
    )
  })

  // Whole-branch review (important 1): the service, writing into an outer root, puts a link in an
  // inner one's place; the next install must not follow it into the service's sandbox.
  it.each([
    ['to a folder it chose', '/srv/target', true],
    ['to nothing yet', '/srv/later', false],
  ])('leaves out a root behind a link the service may change, %s', async (_, target, made) => {
    const sys = fakeSys('linux')
    sys.stats.set('/srv/backups', { uid: 999, mode: 0o40700 })
    sys.dirs.set('/srv/backups', 0o700)
    sys.links.add('/srv/backups/daily')
    if (made) {
      sys.dirs.set(target, 0o755)
      sys.dirs.set('/srv/backups/daily', 0o755)
    }
    sys.realpaths.set('/srv/backups/daily', target)
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/backups:/srv/backups/daily\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit.split('\n').filter((l) => l.startsWith('ReadWritePaths=-'))).toEqual([
      'ReadWritePaths=-/srv/backups',
    ])
    expect(io.err()).toContain(
      "Warning: the folder root /srv/backups/daily was not added to the service's sandbox: /srv/backups, " +
        "above it, is owned by the service's user",
    )
    expect(io.err()).not.toContain('Make the folder it leads to')
  })

  // Whole-branch re-review (important 1): a link in a link's target, written or relative, is on the
  // way too; and (important 3) a link the service's user owns, in a sticky folder its group writes
  // into, is the service's own to rename.
  const chain = (sys: ReturnType<typeof fakeSys>) => {
    sys.stats.set('/srv/backups', { uid: 999, mode: 0o40700 })
    sys.dirs.set('/srv/backups', 0o700)
    sys.dirs.set('/opt/app', 0o755)
    sys.realpaths.set('/srv/daily', '/srv/backups/daily')
    sys.realpaths.set('/srv/backups/daily', '/opt/app')
    return '/srv/backups:/srv/daily'
  }
  const relative = (sys: ReturnType<typeof fakeSys>) => {
    sys.stats.set('/srv/backups', { uid: 999, mode: 0o40700 })
    sys.dirs.set('/srv/backups', 0o700)
    sys.dirs.set('/opt/app', 0o755)
    sys.realpaths.set('/srv/rel', 'backups/rdaily')
    sys.realpaths.set('/srv/backups/rdaily', '../../opt/app')
    return '/srv/backups:/srv/rel'
  }
  const sticky = (sys: ReturnType<typeof fakeSys>) => {
    sys.stats.set('/srv/drop', { uid: 0, gid: 999, mode: 0o41770 })
    sys.dirs.set('/srv/drop', 0o1770)
    sys.dirs.set('/opt/app', 0o755)
    sys.realpaths.set('/srv/drop/x', '/opt/app')
    // There, and its target root's: the link's own owner is what counts.
    sys.dirs.set('/srv/drop/x', 0o755)
    sys.linkStats.set('/srv/drop/x', { uid: 999, gid: 999, mode: 0o120777 })
    return '/srv/drop/x'
  }
  it.each([
    ['a link in a link', chain, '/srv/daily', '/srv/backups'],
    ['a relative link in a relative link', relative, '/srv/rel', '/srv/backups'],
    ["the service's own link in a sticky folder", sticky, '/srv/drop/x', '/srv/drop'],
  ])('leaves out a root behind %s the service may point', async (_, set, root, dir) => {
    const sys = fakeSys('linux')
    const roots = set(sys)
    sys.files.set('/etc/mongo-manager/env', {
      content: `MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=${roots}\n`,
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain('/opt/app')
    expect(io.err()).toContain(
      `Warning: the folder root ${root} was not added to the service's sandbox: ${dir}`,
    )
  })

  // Whole-branch re-re-review (important 1): a folder the walk found, a link when it is judged, was put
  // there while install ran: the root is left out, whatever the link's target's owner.
  it('leaves out a root a folder of which turns into a link while it is judged', async () => {
    const sys = fakeSys('linux')
    sys.stats.set('/srv/grp', { uid: 0, gid: 999, mode: 0o41770 })
    sys.dirs.set('/srv/grp/svcdir/backups', 0o700)
    const lstat = sys.lstat
    let walked = false
    sys.lstat = (p) => {
      if (p === '/srv/grp/svcdir/backups') walked = true
      // After the walk, the service swaps its folder for a link to a root-owned one.
      if (p === '/srv/grp/svcdir' && walked) return { uid: 999, mode: 0o120777 }
      return lstat(p)
    }
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/grp/svcdir/backups\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain(
      'ReadWritePaths=-/srv/grp',
    )
    expect(io.err()).toContain(
      "Warning: the folder root /srv/grp/svcdir/backups was not added to the service's sandbox: " +
        '/srv/grp/svcdir changed while the folder root was judged: a link is where a folder was, put there ' +
        "by someone who may change the folder it is in; run 'mongo-manager service install' again with sudo " +
        'once nothing changes it.\n',
    )
  })

  // Final re-re-re-review (minor 6): nor made by making where a link on its way leads.
  it("tells to choose another folder for a root with '..' though a link on its way leads nowhere", async () => {
    const sys = fakeSys('linux')
    sys.links.add('/srv/l')
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/x/../l/ok\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(io.err()).toMatch(
      /the folder root \/srv\/x\/\.\.\/l\/ok was not added[^\n]*Folder backups there fail; choose another folder\.\n/,
    )
    expect(io.err()).not.toContain('Make the folder it leads to')
  })

  // Final re-review (minor 5): a '..' is no root to use, whatever changed on its way.
  it("tells to choose another folder for a root with '..' though a link on its way changed", async () => {
    const sys = fakeSys('linux')
    sys.realpaths.set('/srv/swap', '/srv/ok')
    sys.dirs.set('/srv/ok', 0o755)
    sys.readlink = () => {
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
    }
    sys.files.set('/etc/mongo-manager/env', {
      // Final re-re-review (minor 3): the link on the path the walk takes, '..' cleaned.
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/x/../swap/ok\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(io.err()).toMatch(
      /the folder root \/srv\/x\/\.\.\/swap\/ok was not added[^\n]*Folder backups there fail; choose another folder\.\n/,
    )
    expect(io.err()).not.toContain('To use it')
  })

  // Whole-branch re-re-re-review (minor 1): a link at lstat and none at readlink was swapped.
  it('refuses a root a link on the way to which changed while it was walked', async () => {
    const sys = fakeSys('linux')
    sys.realpaths.set('/srv/swap', '/srv/ok')
    sys.dirs.set('/srv/ok', 0o755)
    sys.readlink = () => {
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
    }
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/swap\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain('/srv/ok')
    expect(io.err()).toContain(
      "Warning: the folder root /srv/swap was not added to the service's sandbox: /srv/swap changed while " +
        "it was walked: it was a link, then none. To use it, run 'mongo-manager service install' again " +
        'with sudo once nothing changes it.\n',
    )
  })

  // Whole-branch re-re-review (minors 1 and 2): no folder on the way, or more than 40 links.
  it('refuses a root behind a file, or behind more than 40 links', async () => {
    const sys = fakeSys('linux')
    sys.files.set('/srv/f/file', { content: '', mode: 0o644 })
    sys.dirs.set('/srv/ok', 0o755)
    // Taken through the file, it would lead to /srv/ok, which is there.
    sys.realpaths.set('/srv/via-file', '/srv/f/file/../../ok')
    for (let i = 0; i < 41; i++)
      sys.realpaths.set(`/srv/chain/l${i}`, i === 40 ? '/srv/ok' : `/srv/chain/l${i + 1}`)
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/via-file:/srv/chain/l0\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain('/srv/ok')
    expect(io.err()).toContain('/srv/via-file is a link that leads nowhere (through a file)')
    // Whole-branch re-re-re-review (minor 1): not a folder to make, through a file.
    expect(io.err()).toContain(
      'which systemd would follow wherever it leads at a later start. Choose another folder, or remove the link.',
    )
    expect(io.err()).not.toContain('Make the folder it leads to')
    expect(io.err()).toContain(
      '/srv/chain/l0 leads on through more than 40 links, which the kernel does not follow',
    )
  })

  // Whole-branch re-review (important 2): the real path and the links on the way are read in one walk,
  // late: a link the service takes back while install runs cannot leave its target in the unit.
  it('reads a root when it judges it, not before the program is copied', async () => {
    const sys = fakeSys('linux')
    sys.stats.set('/srv/backups', { uid: 999, mode: 0o40700 })
    sys.dirs.set('/srv/backups', 0o700)
    sys.dirs.set('/opt/app', 0o755)
    sys.realpaths.set('/srv/backups/daily', '/opt/app')
    const copy = sys.copyProgram
    sys.copyProgram = (from, to) => {
      // The service puts a folder back in the link's place.
      sys.realpaths.delete('/srv/backups/daily')
      sys.dirs.set('/srv/backups/daily', 0o700)
      copy(from, to)
    }
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/backups:/srv/backups/daily\n',
      mode: 0o600,
    })
    await install(sys)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain('/opt/app')
  })

  // Whole-branch re-review (minor 5): with no one to judge for, a link to nothing is not to be made.
  it('does not say to make where a link leads when it cannot judge who may point it', async () => {
    const sys = fakeSys('linux')
    sys.responses.push({
      match: /^systemctl show mongo-manager -p User -p Group -p SupplementaryGroups -p DynamicUser$/,
      status: 1,
    })
    sys.links.add('/srv/later')
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/later\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(io.err()).toContain('Who may point it elsewhere could not be judged: run service install again.')
    expect(io.err()).not.toContain('Make the folder it leads to')
  })

  // Whole-branch review (important 2): how to check the service, said where it is installed.
  it('says how to check the service with doctor', async () => {
    const { io } = await install()
    expect(io.out()).toContain(
      'Check it with: sudo mongo-manager doctor --config /etc/mongo-manager/config.json\n',
    )
  })

  // Whole-branch review (minor 3): a quoted value keeps its spaces, as the server reads it: "  " sets
  // no roots, rather than leaving the config file's.
  it('takes a quoted value of spaces in the env file as no folder roots', () => {
    expect(
      serviceFolderRoots('{"backup":{"folderRoots":["/srv/a"]}}', 'MM_BACKUP_FOLDER_ROOTS="  "\n'),
    ).toEqual([])
  })

  it('takes a single-quoted value of spaces in the env file as no folder roots', () => {
    expect(
      serviceFolderRoots('{"backup":{"folderRoots":["/srv/a"]}}', "MM_BACKUP_FOLDER_ROOTS='  '\n"),
    ).toEqual([])
  })

  // An outer root left out lets no root inside it in.
  it('leaves out a root inside another one left out', async () => {
    const sys = fakeSys('linux')
    sys.responses.push({ match: /^id -u mongo-manager$/, status: 0, stdout: '999\n' })
    sys.stats.set('/srv/svc', { uid: 999, mode: 0o40755 })
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/svc/out:/srv/svc/out/daily\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit).not.toContain('ReadWritePaths=-')
    for (const root of ['/srv/svc/out', '/srv/svc/out/daily'])
      expect(io.err()).toContain(`Warning: the folder root ${root} was not added to the service's sandbox`)
    expect(io.out()).not.toContain('Folder roots the service may write into')
  })

  // Re-review 2026-10-18 (important 2), and its third review (important 1 and 2): a folder above a
  // root, up to /, that the service's user may change, as its owner, by one of its groups, by an ACL
  // or as anyone may, lets a process running as it put a link to /etc there, and the service restart
  // into it.
  type Setup = (sys: ReturnType<typeof fakeSys>) => void
  const svcFolder: Setup = (sys) => {
    sys.stats.set('/srv/svc', { uid: 999, mode: 0o40755 })
  }
  const svcFurtherUp: Setup = (sys) => {
    sys.stats.set('/srv/svc', { uid: 999, mode: 0o40755 })
    sys.stats.set('/srv/svc/team', { uid: 1000, mode: 0o40755 })
  }
  const svcInSticky: Setup = (sys) => {
    sys.stats.set('/srv/drop', { uid: 0, mode: 0o41777 })
    sys.stats.set('/srv/drop/backups', { uid: 999, mode: 0o40700 })
    sys.dirs.set('/srv/drop/backups', 0o700)
  }
  const svcGroup: Setup = (sys) => {
    sys.responses.push({ match: /^id -G mongo-manager$/, status: 0, stdout: '999 34\n' })
    sys.stats.set('/srv/team', { uid: 0, gid: 34, mode: 0o42775 })
  }
  const othersWrite: Setup = (sys) => {
    sys.stats.set('/srv/shared', { uid: 0, mode: 0o40757 })
  }
  const byAcl: Setup = (sys) => {
    sys.dirs.set('/srv/acl', 0o755)
    sys.responses.push({ match: /^setpriv --reuid=999 --regid=999 --groups=999 -- true$/, status: 0 })
    sys.responses.push({
      match: /^setpriv --reuid=999 --regid=999 --groups=999 -- test -w \/srv\/acl$/,
      status: 0,
    })
    sys.responses.push({ match: /^setpriv /, status: 1 })
  }
  const notYetInSticky: Setup = (sys) => {
    sys.stats.set('/srv/drop', { uid: 0, mode: 0o41777 })
    sys.stats.set('/srv/drop/team', null)
    sys.stats.set('/srv/drop/team/backups', null)
  }
  const OWNED = "is owned by the service's user"
  const WRITES = "may be written into by the service's user"
  it.each([
    ['owns a folder above it', '/srv/svc/backups', svcFolder, '/srv/svc', OWNED],
    ["owns a folder above another user's", '/srv/svc/team/backups', svcFurtherUp, '/srv/svc', OWNED],
    [
      'owns it, in a sticky folder',
      '/srv/drop/backups',
      svcInSticky,
      '/srv/drop',
      "is sticky, but /srv/drop/backups in it is the service's user's, who may rename it",
    ],
    [
      'may write into a folder above it by another of its groups',
      '/srv/team/backups',
      svcGroup,
      '/srv/team',
      WRITES,
    ],
    [
      'may write into a folder above it, as anyone may',
      '/srv/shared/backups',
      othersWrite,
      '/srv/shared',
      WRITES,
    ],
    [
      'may write into a folder above it by an ACL, as setpriv finds',
      '/srv/acl/backups',
      byAcl,
      '/srv/acl',
      WRITES,
    ],
    // Final re-review 2026-10-18 (important): in a sticky folder anyone may make what is not there yet,
    // a link to /etc included, which systemd would follow at the next start.
    [
      'may make a folder above it not made yet in a sticky folder',
      '/srv/drop/team/backups',
      notYetInSticky,
      '/srv/drop',
      "is sticky, but /srv/drop/team in it is not made yet, and the service's user may write into it",
    ],
  ])("leaves out a root when the service's user %s", async (_, root, set, dir, why) => {
    const sys = fakeSys('linux')
    set(sys)
    sys.files.set('/etc/mongo-manager/env', {
      content: `MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=${root}:/srv/ok\n`,
      mode: 0o600,
    })
    const { io } = await install(sys)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit.split('\n').filter((l) => l.startsWith('ReadWritePaths=-'))).toEqual([
      'ReadWritePaths=-/srv/ok',
    ])
    expect(io.err()).toContain(
      `Warning: the folder root ${root} was not added to the service's sandbox: ${dir}, above it, ${why}: ` +
        "a process running as that user could put a link to any folder in a folder's place there, and " +
        'systemd would make that writable to the service at its next start. To use it, put the root ' +
        'inside a folder owned by root that no other user may write into, or choose another folder.\n',
    )
    expect(io.err()).not.toContain(`Warning: ${dir}, above the folder root`)
  })

  // Fourth review (important 1): the kernel's no, which a tool that fails looks like too, takes
  // nothing away from what the mode says.
  it("takes no kernel's no for the mode's yes", async () => {
    const sys = fakeSys('linux')
    sys.responses.push({ match: /^setpriv /, status: 1 })
    sys.stats.set('/srv/shared', { uid: 0, mode: 0o40757 })
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/shared/backups:/srv/ok\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain(
      'ReadWritePaths=-/srv/shared/backups',
    )
    expect(io.err()).toContain("/srv/shared, above it, may be written into by the service's user")
  })

  // Fourth review (minor 4): each folder is asked once, however many roots are below it.
  it('asks the kernel of each folder once', async () => {
    const sys = fakeSys('linux')
    sys.dirs.set('/srv/x', 0o755)
    sys.responses.push({ match: /^setpriv --reuid=999 --regid=999 --groups=999 -- true$/, status: 0 })
    sys.responses.push({ match: /^setpriv /, status: 1 })
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/x/a:/srv/x/b\n',
      mode: 0o600,
    })
    await install(sys)
    expect(sys.commands.filter((c) => c.endsWith(' -- test -w /srv/x'))).toEqual([
      'setpriv --reuid=999 --regid=999 --groups=999 -- test -w /srv/x',
    ])
  })

  // Fifth review (minor 1): a setpriv that cannot run as the user is said, once.
  it.each([
    ['setpriv cannot run as the user', (sys: ReturnType<typeof fakeSys>) => sys],
    [
      "the user's group cannot be read",
      (sys: ReturnType<typeof fakeSys>) => {
        sys.responses.push({ match: /^id -g mongo-manager$/, status: 1 })
        // Not asked with a group it does not know, though it would answer.
        sys.responses.push({ match: /^setpriv /, status: 0 })
        return sys
      },
    ],
  ])('says it judged by modes alone when %s', async (_, set) => {
    const sys = set(fakeSys('linux'))
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/a:/srv/b\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    const warning =
      "Warning: setpriv could not run as the service's user mongo-manager, so the folders above the " +
      "folder roots were judged by their modes and that user's groups alone: an ACL that lets the user " +
      'write into one is not seen.\n'
    expect(io.err().split(warning).length).toBe(2)
    expect(sys.commands.filter((c) => c.includes(' -- test -w '))).toEqual([])
  })

  // Fifth review (minor 4): of two roots that lead to the same folder, the one the unit names takes
  // in the roots inside it.
  it('takes a root in by the outer root the unit can name, of two that lead to the same folder', async () => {
    const sys = fakeSys('linux')
    sys.dirs.set('/srv/my link', 0o755)
    sys.realpaths.set('/srv/my link', '/srv/a')
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/my link:/srv/a:/srv/a/x\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(io.out()).toContain('/srv/a/x (in /srv/a)')
    expect(io.err()).not.toContain('fail until then too')
    // Sixth review (minor 4), seventh (minor 8): a name with a space that leads to a plain path is
    // the plain path to the unit.
    expect(io.err()).not.toContain('/srv/my link was not added')
    expect(io.out()).toContain('/srv/my link (/srv/a)')
  })

  // Eighth review (important): who runs the service, and with which groups, as systemd reads the unit
  // and every drop-in.
  const SHOW = /^systemctl show mongo-manager -p User -p Group -p SupplementaryGroups -p DynamicUser$/
  const runsAs = (sys: ReturnType<typeof fakeSys>, ids: string) =>
    sys.responses.push({ match: SHOW, status: 0, stdout: `${ids}\n` })
  const failedWith = async (sys: ReturnType<typeof fakeSys>) => {
    const { code, io } = await install(sys)
    expect(code).toBe(1)
    return io.err()
  }
  const withRoots = (sys: ReturnType<typeof fakeSys>, roots: string) =>
    sys.files.set('/etc/mongo-manager/env', {
      content: `MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=${roots}\n`,
      mode: 0o600,
    })

  // Sixth review (minor 7): the groups a drop-in gives the service count as its user's own.
  it("judges a folder by the groups the unit gives the service, a drop-in's included", async () => {
    const sys = fakeSys('linux')
    runsAs(sys, 'User=mongo-manager\nGroup=\nSupplementaryGroups=backup 77\nDynamicUser=no')
    sys.responses.push({ match: /^getent group backup$/, status: 0, stdout: 'backup:x:34:\n' })
    sys.responses.push({ match: /^setpriv .* -- true$/, status: 0 })
    sys.responses.push({ match: /^setpriv /, status: 1 })
    sys.stats.set('/srv/team', { uid: 0, gid: 34, mode: 0o42775 })
    withRoots(sys, '/srv/team/backups')
    const { io } = await install(sys)
    expect(io.err()).toContain("/srv/team, above it, may be written into by the service's user")
    expect(sys.commands).toContain('setpriv --reuid=999 --regid=999 --groups=999,34,77 -- true')
    // Judged once systemd has read the unit as written.
    expect(sys.commands.indexOf('systemctl daemon-reload')).toBeLessThan(
      sys.commands.findIndex((c) => SHOW.test(c)),
    )
  })

  // Seventh review (minor 2): systemd refuses to start the service with a group no one has, so the
  // install stops there.
  it('stops at a group the unit gives the service that the system does not know', async () => {
    const sys = fakeSys('linux')
    runsAs(sys, 'User=mongo-manager\nGroup=\nSupplementaryGroups=nosuch\nDynamicUser=no')
    sys.responses.push({ match: /^getent group nosuch$/, status: 2 })
    withRoots(sys, '/srv/b')
    expect(await failedWith(sys)).toContain(
      'The unit gives the service the group nosuch, which the system does not know: systemd refuses to ' +
        'start the service (216/GROUP); check Group= and SupplementaryGroups= with: systemctl cat ' +
        "mongo-manager, then run 'mongo-manager service install' again with sudo. The service is stopped " +
        'and disabled until then.',
    )
    expect(sys.commands).toContain('systemctl disable --now mongo-manager')
    expect(sys.commands).not.toContain('systemctl restart mongo-manager')
  })

  // Eighth review (minor 3): a lookup that failed is no answer: every root is left out, and that is said.
  it('leaves every root out when a group the unit gives the service cannot be looked up', async () => {
    const sys = fakeSys('linux')
    runsAs(sys, 'User=mongo-manager\nGroup=\nSupplementaryGroups=ldapgroup\nDynamicUser=no')
    sys.responses.push({ match: /^getent group ldapgroup$/, status: 1 })
    withRoots(sys, '/srv/b')
    const { io } = await install(sys)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain(
      'ReadWritePaths=-',
    )
    expect(io.err()).toContain(
      'Warning: the group ldapgroup the unit gives the service could not be looked up (getent failed), so ' +
        'whether its members may change a folder above a folder root is not known.\n',
    )
    // Ninth review (minor 4): the reason once.
    expect(io.err()).toContain(
      "Warning: the folder root /srv/b was not added to the service's sandbox: a group the unit gives " +
        'the service could not be looked up (see above). Run service install again.\n',
    )
    expect(io.err().split('could not be looked up (getent failed)').length).toBe(2)
  })

  // Sixth review (minor 7): Group= is the group the service runs with.
  it('runs setpriv with the group Group= names', async () => {
    const sys = fakeSys('linux')
    runsAs(sys, 'User=mongo-manager\nGroup=backup\nSupplementaryGroups=\nDynamicUser=no')
    sys.responses.push({ match: /^getent group backup$/, status: 0, stdout: 'backup:x:34:\n' })
    sys.responses.push({ match: /^id -g mongo-manager$/, status: 0, stdout: '34\n' })
    withRoots(sys, '/srv/b')
    await install(sys)
    expect(sys.commands).toContain('setpriv --reuid=999 --regid=34 --groups=999,34 -- true')
  })

  // Ninth review (important 2): a systemctl show that failed is no word on who runs it.
  it('leaves every root out, and stops nothing, when systemd cannot be asked who runs the service', async () => {
    const sys = fakeSys('linux')
    sys.responses.push({ match: SHOW, status: 1 })
    withRoots(sys, '/srv/b')
    const { code, io } = await install(sys)
    expect(code).toBe(0)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain(
      'ReadWritePaths=-',
    )
    expect(io.err()).toContain(
      'Warning: systemd could not be asked who runs the service (systemctl show failed), so no folder ' +
        "root is added to the service's sandbox.\n",
    )
    expect(io.err()).not.toContain('root (an empty User=)')
    expect(sys.commands).not.toContain('systemctl disable --now mongo-manager')
  })

  // Ninth review (important 1, minor 1): DynamicUser=yes takes an account of that name, and a User= of
  // --user's uid is --user: neither stops it.
  it.each([
    [
      'DynamicUser=yes with an account of its name',
      'User=mongo-manager\nGroup=\nSupplementaryGroups=\nDynamicUser=yes',
    ],
    ['DynamicUser=yes and no User=', 'User=\nGroup=\nSupplementaryGroups=\nDynamicUser=yes'],
    ["a User= of --user's uid", 'User=999\nGroup=\nSupplementaryGroups=\nDynamicUser=no'],
  ])('installs with %s', async (_, ids) => {
    const sys = fakeSys('linux')
    runsAs(sys, ids)
    withRoots(sys, '/srv/b')
    const { code } = await install(sys)
    expect(code).toBe(0)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).toContain(
      '\nReadWritePaths=-/srv/b\n',
    )
  })

  // Ninth review (minor 10): Group= of another group leaves out --user's own, which can read the config.
  it("stops at a Group= that leaves out the user's own group", async () => {
    const sys = fakeSys('linux')
    runsAs(sys, 'User=mongo-manager\nGroup=backup\nSupplementaryGroups=\nDynamicUser=no')
    sys.responses.push({ match: /^getent group backup$/, status: 0, stdout: 'backup:x:34:\n' })
    withRoots(sys, '/srv/b')
    expect(await failedWith(sys)).toContain(
      'A drop-in sets Group=backup, so systemd would run the service without the group of mongo-manager, ' +
        'which can read its config: remove it with: sudo systemctl edit mongo-manager',
    )
  })

  // Seventh review (minors 2 and 5), eighth (important): a drop-in that runs the service as another
  // user, as root or as a user of systemd's own stops the install: the data directory and config are
  // --user's.
  it.each([
    [
      'another user',
      'User=other\nGroup=\nSupplementaryGroups=\nDynamicUser=no',
      'A drop-in runs the service as other, not mongo-manager, who owns its data directory and config: ' +
        'run service install with --user other, or remove that User= with: sudo systemctl edit ' +
        "mongo-manager, then run 'mongo-manager service install' again with sudo. The service is stopped " +
        'and disabled until then.',
    ],
    [
      'root',
      'User=\nGroup=\nSupplementaryGroups=\nDynamicUser=no',
      'A drop-in runs the service as root, not mongo-manager, who owns its data directory and config: ' +
        'remove that User= with',
    ],
    [
      'root by name, which --user does not take',
      'User=root\nGroup=\nSupplementaryGroups=\nDynamicUser=no',
      'A drop-in runs the service as root, not mongo-manager, who owns its data directory and config: ' +
        'remove that User= with',
    ],
    [
      'root by a name --user would take',
      'User=toor\nGroup=\nSupplementaryGroups=\nDynamicUser=no',
      'A drop-in runs the service as root, not mongo-manager, who owns its data directory and config: ' +
        'remove that User= with',
    ],
    [
      'a user of its own',
      'User=dyn\nGroup=\nSupplementaryGroups=\nDynamicUser=yes',
      'A drop-in sets DynamicUser=yes, and no account dyn exists, so systemd would run the service as a ' +
        'user of its own, not mongo-manager, who owns its data directory and config: remove it with: sudo ' +
        'systemctl edit mongo-manager',
    ],
  ])('stops when a drop-in runs the service as %s', async (_, ids, why) => {
    const sys = fakeSys('linux')
    sys.responses.push({ match: /^id -u other$/, status: 0, stdout: '1500\n' })
    sys.responses.push({ match: /^id -u root$/, status: 0, stdout: '0\n' })
    sys.responses.push({ match: /^id -u toor$/, status: 0, stdout: '0\n' })
    sys.responses.push({ match: /^id -u dyn$/, status: 1 })
    runsAs(sys, ids)
    withRoots(sys, '/srv/b')
    expect(await failedWith(sys)).toContain(why)
    expect(sys.commands).toContain('systemctl disable --now mongo-manager')
    expect(sys.commands).not.toContain('systemctl restart mongo-manager')
    // Ninth review (minor 2): the data directory and config are left as they were.
    expect(sys.files.has('/etc/mongo-manager/config.json')).toBe(false)
    expect(sys.commands.some((c) => c.startsWith('chown'))).toBe(false)
  })

  it('says when the service could not be stopped', async () => {
    const sys = fakeSys('linux')
    runsAs(sys, 'User=other\nGroup=\nSupplementaryGroups=\nDynamicUser=no')
    sys.responses.push({ match: /^id -u other$/, status: 0, stdout: '1500\n' })
    sys.responses.push({ match: /^systemctl disable --now mongo-manager$/, status: 1 })
    withRoots(sys, '/srv/b')
    expect(await failedWith(sys)).toContain(
      'The service could not be stopped and disabled (systemctl disable --now failed).',
    )
  })

  // Ninth review (minor 3): a failure while judging says the unit is left without folder roots.
  it('says the unit is left without folder roots when judging them fails', async () => {
    const sys = fakeSys('linux')
    withRoots(sys, '/srv/b')
    const lstat = sys.lstat
    let walked = false
    sys.lstat = (p) => {
      // The walk reads /srv; judging it after, it fails.
      if (p === '/srv' && walked) throw new Error('EIO: /srv')
      if (p === '/srv') walked = true
      return lstat(p)
    }
    const { code, io } = await install(sys)
    expect(code).toBe(1)
    expect(io.err()).toContain(
      "Warning: the service's unit is left without folder roots: run 'mongo-manager service install' " +
        'again with sudo.\n',
    )
  })

  // Ninth review (minor 6): a real path with a line break no unit can name.
  it('says to rename a root whose real path has a line break', async () => {
    const sys = fakeSys('linux')
    sys.dirs.set('/srv/link', 0o755)
    sys.realpaths.set('/srv/link', '/srv/two\nlines')
    withRoots(sys, '/srv/link')
    const { io } = await install(sys)
    expect(io.err()).toContain(
      'fail until you rename it: its real path has a line break in it, which no unit can name',
    )
  })

  // Ninth review (minor 7): the roots inside one to add by hand, whichever name they were matched to.
  it('lists the roots inside one to add by hand by real path', async () => {
    const sys = fakeSys('linux')
    for (const link of ['/srv/my link', '/srv/link']) {
      sys.dirs.set(link, 0o755)
      sys.realpaths.set(link, '/srv/my data')
    }
    withRoots(sys, '/srv/my link:/srv/link:/srv/my data/x')
    const { io } = await install(sys)
    expect(io.err()).toContain('Folder backups in the roots inside it fail until then too: /srv/my data/x\n')
  })

  // Eighth review (important): the unit goes in without folder roots until they are judged.
  it('writes the unit without folder roots until it has judged them', async () => {
    const sys = fakeSys('linux')
    withRoots(sys, '/srv/b')
    const units: string[] = []
    const write = sys.write
    sys.write = (path, content, mode) => {
      if (path === '/etc/systemd/system/mongo-manager.service') units.push(String(content))
      write(path, content, mode)
    }
    await install(sys)
    expect(units.map((u) => u.includes('ReadWritePaths=-/srv/b'))).toEqual([false, true])
  })

  // Once a folder the unit names, however many roots lead there.
  it('warns of a folder above two roots that lead to the same folder once', async () => {
    const sys = fakeSys('linux')
    sys.stats.set('/srv/shared', { uid: 1000, mode: 0o40755 })
    sys.dirs.set('/srv/shared/x', 0o700)
    sys.dirs.set('/srv/link', 0o755)
    sys.realpaths.set('/srv/link', '/srv/shared/x')
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/shared/x:/srv/link\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(io.err().split('/srv/shared, above the folder root').length).toBe(2)
  })

  // Third review (minor 9): not knowing the service's user is no leave to let it in.
  it("leaves out every root when the service's user's id cannot be read", async () => {
    const sys = fakeSys('linux')
    sys.responses.push({ match: /^id -u mongo-manager$/, status: 1 })
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/backups\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain(
      'ReadWritePaths=-',
    )
    expect(io.err()).toContain(
      "Warning: the folder root /srv/backups was not added to the service's sandbox: the id of the " +
        "service's user mongo-manager could not be read, so whether that user may change a folder above " +
        'the root is not known. Run service install again.\n',
    )
  })

  // Third review (minor 12): the user made by this install is the one whose ids are read.
  it('reads the ids of the user it has just made', async () => {
    const sys = fakeSys('linux')
    const run = sys.run
    let made = false
    sys.run = (cmd, args, opts) => {
      if (cmd === 'useradd') made = true
      if (cmd === 'id' && args[0] === '-u' && !made) return { status: 1, stdout: '', stderr: 'no such user' }
      return run(cmd, args, opts)
    }
    sys.stats.set('/srv/svc', { uid: 999, mode: 0o40755 })
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/svc/backups\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(sys.commands.indexOf('id -G mongo-manager')).toBeGreaterThan(
      sys.commands.findIndex((c) => c.startsWith('useradd')),
    )
    expect(io.err()).toContain("/srv/svc, above it, is owned by the service's user")
  })

  // Third review (important 1): an outer root to add by hand takes in one inside it as well.
  it('names no root inside one to add by hand', async () => {
    const sys = fakeSys('linux')
    sys.dirs.set('/srv/my link', 0o755)
    sys.realpaths.set('/srv/my link', '/srv/my data')
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/my link:/srv/my data/team/backups\n',
      mode: 0o600,
    })
    const { io } = await install(sys)
    expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).not.toContain(
      'ReadWritePaths=-',
    )
    expect(io.err()).toContain(
      "Warning: the folder root /srv/my link was not added to the service's sandbox (a space",
    )
    // Fourth review (minor 5): not in the sandbox until the outer one is added.
    expect(io.err()).toContain(
      'Folder backups in the roots inside it fail until then too: /srv/my data/team/backups\n',
    )
    expect(io.out()).not.toContain('Folder roots the service may write into')
  })

  it('says nothing of a sticky root-owned folder (as /tmp is) above a root that exists', async () => {
    const err = await installRoot('/srv/drop/backups', (sys) => {
      sys.stats.set('/srv/drop', { uid: 0, mode: 0o41777 })
      sys.dirs.set('/srv/drop/backups', 0o700)
    })
    expect(err).not.toContain('can be changed by a user other than root')
  })

  // A sticky folder only a group other than the service's may write into: a warning, not a refusal.
  it.each([
    ['the root', '/srv/drop/backups'],
    ['a folder above it', '/srv/drop/team/backups'],
  ])('warns when %s is not made yet in a sticky folder a group may write into', async (_, root) => {
    const err = await installRoot(root, (sys) => {
      sys.stats.set('/srv/drop', { uid: 0, gid: 50, mode: 0o41770 })
    })
    const entry = root.split('/').slice(0, 4).join('/')
    expect(err).toContain(
      LOOSE(
        '/srv/drop',
        root,
        `sticky, but ${entry} in it is not made yet, and its group (gid 50) may make it`,
      ),
    )
  })

  // Last review 2026-10-18 (minor 3): in a sticky folder an entry's owner may still rename it, and the
  // service, owning its root, could put a link to /etc in its place.
  it('warns when the root, in a sticky folder, belongs to a user other than root', async () => {
    const err = await installRoot('/srv/drop/backups', (sys) => {
      sys.stats.set('/srv/drop', { uid: 0, mode: 0o41777 })
      sys.stats.set('/srv/drop/backups', { uid: 1000, mode: 0o40700 })
      sys.dirs.set('/srv/drop/backups', 0o700)
    })
    expect(err).toContain(
      LOOSE(
        '/srv/drop',
        '/srv/drop/backups',
        'sticky, but /srv/drop/backups in it is owned by uid 1000, who may rename it',
      ),
    )
  })

  // Last review 2026-10-18 (minor 5): a walk that never ends fails here rather than hanging the run.
  function walking(top = { uid: 0, mode: 0o40755 }) {
    const seen: string[] = []
    const stat = (path: string) => {
      seen.push(path)
      if (seen.length > 20) throw new Error(`no end to the walk: ${seen.join(' ')}`)
      return path === '/' ? top : { uid: 0, mode: 0o40755 }
    }
    return { seen, sys: { lstat: stat } }
  }

  it('walks up from the root to /, and checks / too', () => {
    const { seen, sys } = walking({ uid: 0, mode: 0o40777 })
    expect(looseParent('/srv/a', sys)).toEqual({ dir: '/', why: 'others may write into it' })
    expect(seen).toEqual(['/srv/a', '/srv', '/'])
  })

  it.each([
    ['/', ['/', '/']],
    ['', ['', '.']],
    ['a/b', ['a/b', 'a', '.']],
    ['C:/x', ['C:/x', 'C:', '.']],
    ['C:\\x', ['C:\\x', '.']],
  ])('ends its walk up from %j', (path, visits) => {
    const { seen, sys } = walking()
    expect(looseParent(path, sys)).toBeNull()
    expect(seen).toEqual(visits)
  })

  it('says nothing of a root not made yet in a closed folder, though a sticky one is above that', async () => {
    const err = await installRoot('/srv/drop/team/backups', (sys) => {
      sys.stats.set('/srv/drop', { uid: 0, mode: 0o41777 })
      sys.dirs.set('/srv/drop/team', 0o755)
    })
    expect(err).not.toContain('can be changed by')
  })

  it('says nothing of a root not made yet under folders closed to others', async () => {
    expect(await installRoot('/srv/backups/mongo', () => {})).not.toContain('can be changed by')
  })

  it.each(['/srv/backups', '/opt/backups', '/mnt/nas', '/var/backups/mongo', '/media/usb/backups'])(
    'lets the service write into %s',
    async (root) => {
      const sys = fakeSys('linux')
      sys.files.set('/etc/mongo-manager/env', {
        content: `MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=${root}\n`,
        mode: 0o600,
      })
      await install(sys)
      expect(sys.files.get('/etc/systemd/system/mongo-manager.service')!.content).toContain(
        `\nReadWritePaths=-${root}\n`,
      )
    },
  )

  it('leaves out a root systemd would read otherwise, and says how to add it', async () => {
    const sys = fakeSys('linux')
    sys.files.set('/etc/mongo-manager/env', {
      content: 'MM_SECRET_KEY=existing\nMM_BACKUP_FOLDER_ROOTS=/srv/my backups:/srv/100%:/srv/ok\n',
      mode: 0o600,
    })
    const { code, io } = await install(sys)
    expect(code).toBe(0)
    const unit = sys.files.get('/etc/systemd/system/mongo-manager.service')!.content
    expect(unit).toContain('\nReadWritePaths=-/srv/ok\n')
    expect(unit).not.toMatch(/my backups|100%/)
    for (const root of ['/srv/my backups', '/srv/100%'])
      expect(io.err()).toContain(
        `Warning: the folder root ${root} was not added to the service's sandbox (a space, quote, ` +
          'backslash or % in it); folder backups there fail until you add its real path, as ' +
          `ReadWritePaths=-"${root.replace(/%/g, '%%')}" in [Service], with: sudo systemctl edit mongo-manager\n`,
      )
  })

  // Eighth review (minor 5): the line to add names the real path, as systemd reads it, once a folder.
  it('gives the line to add by hand for the real path, escaped, once a folder', async () => {
    const sys = fakeSys('linux')
    for (const link of ['/srv/link', '/srv/link2']) {
      sys.dirs.set(link, 0o755)
      sys.realpaths.set(link, '/srv/my "50%" \\data')
    }
    withRoots(sys, '/srv/link:/srv/link2')
    const { io } = await install(sys)
    expect(io.err()).toContain('ReadWritePaths=-"/srv/my \\"50%%\\" \\\\data" in [Service]')
    expect(io.err().split('was not added to the service').length).toBe(2)
  })

  it('never re-keys an existing data directory (Review Focus 1)', async () => {
    const sys = fakeSys('linux')
    sys.files.set('/var/lib/mongo-manager/mongo-manager.db', { content: 'db', mode: 0o600 })
    const refused = await install(sys)
    expect(refused.code).toBe(1)
    expect(refused.io.err()).toMatch(/existing data.*no key/i)
    expect(sys.files.has('/etc/mongo-manager/env')).toBe(false)
    sys.files.set('/var/lib/mongo-manager/secret.key', { content: 'k', mode: 0o600 })
    const kept = await install(sys)
    expect(kept.code).toBe(0)
    expect(sys.files.get('/etc/mongo-manager/env')!.content).not.toMatch(/MM_SECRET_KEY/)
  })

  it('refuses without root, a bad port or an unauthenticated network bind; an nvm Node is copied', async () => {
    expect((await install(fakeSys('linux', { admin: false }))).io.err()).toMatch(/sudo/)
    const home = fakeSys('linux')
    const io = fakeIo()
    expect(
      await serviceCommand(['install'], {}, io, {
        sys: home,
        program: { ...program, node: '/home/ada/.nvm/versions/node/v24/bin/node' },
        probe,
      }),
    ).toBe(0)
    expect(home.files.get('/opt/mongo-manager/app/bin/node')!.content).toContain('/home/ada/.nvm')
    expect((await install(fakeSys('linux'), ['--web-port', '80'])).code).toBe(2)
    const open = await install(fakeSys('linux'), ['--no-auth', '--host', '0.0.0.0'])
    expect(open.code).toBe(1)
    expect(open.io.err()).toMatch(/Refusing to listen on 0\.0\.0\.0 without authentication/)
  })

  it('uninstalls the program and unit but keeps data, config and key', async () => {
    const { sys } = await install()
    // Third review of the CI fixes (minor 4): what a failed install left beside it goes too.
    sys.files.set('/opt/mongo-manager/app.old/bin/node', { content: 'earlier', mode: 0o755 })
    sys.files.set('/opt/mongo-manager/app.new/bin/node', { content: 'half', mode: 0o755 })
    const io = fakeIo()
    expect(await serviceCommand(['uninstall'], {}, io, { sys, program, probe })).toBe(0)
    expect(sys.commands).toContain('systemctl disable --now mongo-manager')
    expect(sys.files.has('/etc/systemd/system/mongo-manager.service')).toBe(false)
    expect(sys.files.has('/opt/mongo-manager/app/dist/cli.cjs')).toBe(false)
    expect([...sys.files.keys()].filter((k) => k.startsWith('/opt/mongo-manager/app'))).toEqual([])
    expect(sys.files.has('/etc/mongo-manager/config.json')).toBe(true)
    expect(sys.files.has('/etc/mongo-manager/env')).toBe(true)
    expect(io.out()).toMatch(/kept.*\/var\/lib\/mongo-manager/s)
    // Seventh review of the CI fix 2026-10-20 (minor 3): the folder that held it goes when empty.
    expect(sys.commands).toContain('rmdir-if-empty /opt/mongo-manager')
  })

  // Tenth review (minor 5): one that cannot go (a mount point) is said; the uninstall is done.
  it('is done when the folder that held the program cannot be removed', async () => {
    const { sys } = await install()
    sys.removeEmptyDir = () => 'EBUSY'
    const io = fakeIo()
    expect(await serviceCommand(['uninstall'], {}, io, { sys, program, probe })).toBe(0)
    expect(io.out()).toMatch(/Mongo Manager was removed/)
    expect(io.out()).toMatch(/\/opt\/mongo-manager was left \(EBUSY\); remove it yourself if it is empty/)
  })

  it('shows status and logs through systemd', async () => {
    const sys = fakeSys('linux')
    await serviceCommand(['status'], {}, fakeIo(), { sys, program, probe })
    await serviceCommand(['logs'], { follow: true }, fakeIo(), { sys, program, probe })
    expect(sys.commands).toEqual([
      'systemctl status mongo-manager --no-pager',
      'journalctl -u mongo-manager -n 200 --no-pager -f',
    ])
  })

  // Review of the CLI docs: --follow was taken by every service command and ignored by all but logs.
  it('takes --follow for logs only', async () => {
    const { code, io } = await runService(['status', '--follow'])
    expect(code).toBe(2)
    expect(io.err()).toMatch(/--follow.*logs/)
  })

  // Review of the CLI docs: --no-shell was accepted by service install and silently dropped.
  it('writes --no-shell into the config, keeping the shell settings an admin set', async () => {
    const sys = fakeSys('linux')
    const shell = { enabled: true, maxPerUser: 5 }
    sys.files.set('/etc/mongo-manager/config.json', {
      content: JSON.stringify({ auth: true, shell }),
      mode: 0o640,
    })
    expect((await install(sys, ['--no-shell'])).code).toBe(0)
    const config = JSON.parse(sys.files.get('/etc/mongo-manager/config.json')!.content)
    expect(config.shell).toEqual({ enabled: false, maxPerUser: 5 })
    expect((await install(sys, ['--shell'])).code).toBe(0)
    expect(JSON.parse(sys.files.get('/etc/mongo-manager/config.json')!.content).shell).toEqual({
      enabled: true,
      maxPerUser: 5,
    })
  })

  // Re-review of the merge (Minors 2 and 4): a shell setting that is not a section is replaced by
  // --shell / --no-shell, and without them it is refused in words, not with the parser's dump.
  it('replaces a malformed shell setting when told, and names it otherwise', async () => {
    const sys = fakeSys('linux')
    const write = () =>
      sys.files.set('/etc/mongo-manager/config.json', {
        content: JSON.stringify({ auth: true, shell: true }),
        mode: 0o640,
      })
    write()
    const refused = await install(sys)
    expect(refused.code).toBe(1)
    expect(refused.io.err()).toMatch(/config\.json is invalid: shell: /)
    expect(refused.io.err()).not.toMatch(/"code"|"path"/)
    write()
    expect((await install(sys, ['--no-shell'])).code).toBe(0)
    expect(JSON.parse(sys.files.get('/etc/mongo-manager/config.json')!.content).shell).toEqual({
      enabled: false,
    })
  })
})

async function runService(argv: string[]) {
  const io = fakeIo()
  try {
    const { positionals, values } = parseCli(['service', ...argv])
    return {
      code: await serviceCommand(positionals, values, io, { sys: fakeSys('linux'), program, probe }),
      io,
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    io.stderr.write(`Error: ${e.message}\n`)
    return { code: 2, io }
  }
}
