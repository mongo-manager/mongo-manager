/**
 * Third review of the personal-data rework (N2): the changes to one connection's rules are saved one
 * at a time, from whichever card makes them — two cards (a tab closed while saving, another opened)
 * each made theirs on the other's rules, and were refused in turn until one gave up. A lane per
 * query client (one in the app): no app's saves wait for another's (fourth review, n1).
 */
const lanes = new WeakMap<object, Map<string, Promise<void>>>()

/** Runs `work` once every change before it on this connection is done (saved or not). */
export function inLane<T>(client: object, connectionId: string, work: () => Promise<T>): Promise<T> {
  let byConnection = lanes.get(client)
  if (!byConnection) lanes.set(client, (byConnection = new Map()))
  const queue = byConnection
  const before = queue.get(connectionId) ?? Promise.resolve()
  const run = before.then(work)
  const after = run.then(
    () => undefined,
    () => undefined,
  )
  queue.set(connectionId, after)
  void after.then(() => {
    if (queue.get(connectionId) === after) queue.delete(connectionId)
  })
  return run
}

/** The reads a refresh met already: each is acted on once, however many refreshes meet it. */
const met = new WeakSet<object>()

/** Whether `read` is met for the first time (and marks it met). */
export function firstMeeting(read: object): boolean {
  if (met.has(read)) return false
  met.add(read)
  return true
}
