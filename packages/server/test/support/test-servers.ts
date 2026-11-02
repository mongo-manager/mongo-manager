import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import { PORT_ATTEMPTS, startRetrying } from './port-retry'
import { LAUNCH_MS } from './slowness'

/**
 * Every MongoDB server a test starts, alone or in a replica set:
 * - CI 2026-10-18: runs wiredTiger, as a real one does, unless the test names another engine.
 *   mongodb-memory-server starts versions before 7.0 on ephemeralForTest, on which 6.0 fell over at
 *   the first write to a replica set and said nothing of its disk space (test-servers.test.ts);
 * - CI 2026-10-21: starts again on another port when another process took its own (port-retry.ts),
 *   unless the test holds it to one port (review of the port retry, nit 7); no test holds a replica
 *   set's members to theirs;
 * - CI 2026-10-22 (Windows): is given LAUNCH_MS to start (slowness.ts), a set's every member too,
 *   unless the test names its own time; one that did not start in it, or a set that chose no
 *   primary, starts again, SLOW_STARTS starts at most (port-retry.ts).
 */
MongoMemoryServer.create = (opts = {}) =>
  startRetrying(
    () =>
      new MongoMemoryServer({
        ...opts,
        instance: {
          storageEngine: 'wiredTiger',
          ...opts.instance,
          // A time the test leaves unset is LAUNCH_MS too (review of the Windows hardening, N1).
          launchTimeout: opts.instance?.launchTimeout ?? LAUNCH_MS,
        },
      }),
    opts.instance?.portGeneration === false ? 1 : PORT_ATTEMPTS,
  )
MongoMemoryReplSet.create = (opts = {}) => {
  // A member the test names nothing for is started with no time of its own: each one is named.
  const named = opts.instanceOpts ?? []
  const members = Math.max(opts.replSet?.count ?? 1, named.length)
  const instanceOpts = Array.from({ length: members }, (_, i) => ({
    ...named[i],
    launchTimeout: named[i]?.launchTimeout ?? LAUNCH_MS,
  }))
  return startRetrying(
    () =>
      new MongoMemoryReplSet({
        ...opts,
        instanceOpts,
        replSet: { storageEngine: 'wiredTiger', ...opts.replSet },
      }),
  )
}
