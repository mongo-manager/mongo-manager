import type { RawStatus, ServerSample } from '../../src/monitor/sampler'

/** Widgets wave 2: a sample that measured none of the new metrics (a test's plain sample). */
export const UNMEASURED: Pick<ServerSample, 'targeting' | 'latency' | 'cursors' | 'transactions' | 'errors'> =
  {
    targeting: { keysPerReturned: null, docsPerReturned: null },
    latency: { readsMs: null, writesMs: null, commandsMs: null },
    cursors: null,
    transactions: { committedPerSec: null, abortedPerSec: null },
    errors: { regularPerSec: null, userPerSec: null, msgPerSec: null, cursorTimeoutsPerSec: null },
  }

/** A reading of a server that reports none of the wave 2 sections. */
export const UNREPORTED: Pick<RawStatus, 'scanned' | 'latency' | 'cursors' | 'transactions' | 'asserts'> = {
  scanned: null,
  latency: null,
  cursors: null,
  transactions: null,
  asserts: null,
}
