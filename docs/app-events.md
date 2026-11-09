# App events

Workstream W4 (W4.7) emits events that the alerts of W3 (§2 W3.3: the bell, e-mail, webhooks) act on. This page is
the contract between the two.

## Emitting

Each server context has its own hub, `ctx.events` (packages/server/src/events/app-events.ts): its
listeners are that server's, and an event's time is the context's clock (`ctx.now`).

```ts
ctx.events.emit('backup.drill.failed', {
  severity: 'critical', // 'info' | 'warning' | 'critical'
  summary: 'The restore drill of the schedule "Nightly shop" failed',
  connectionId: schedule.connectionId,
  namespace: 'shop', // "db" or "db.coll", or omitted
  ownerId: schedule.owner, // the user whose schedule, sync or watch it is
  details: { schedule: schedule.id, backup: backupId, mismatched: 2 },
})
```

- The call never blocks and never throws: listeners run on a later tick, each on its own, and a
  listener that throws or rejects is ignored.
- An event is bounded and flat: the summary is cut at 300 characters; at most 20 details, each a
  string (cut at 200 characters), a finite number, a boolean or null; anything else is dropped.
- **Never put a document value in an event** — not in the summary, not in the details. Events reach
  e-mail and webhooks, outside the masking of personal fields. Ids, names of databases, collections,
  schedules and syncs, counts and reason codes only.
- A kind that is not in `APP_EVENT_KINDS` (packages/shared/src/api/appEvents.ts) is dropped.

## Subscribing

```ts
const off = ctx.events.on((event) => {
  // event: AppEvent — kind, at, severity, connectionId, namespace, ownerId, summary, details
})
// off() unsubscribes.
```

A subscriber decides who may see an event: an event about a connection is for its owner and for the
users who may read that connection, as the jobs and schedules it comes from are.

## The alerts

http/app.ts subscribes W3's alerts (`AlertService.onAppEvent`). The alert events an administrator
can make a rule for, from the app events:

| App event             | Alert event (rule)   | Notes                                                        |
| --------------------- | -------------------- | ------------------------------------------------------------ |
| `backup.drill.failed` | `backup.drillFailed` | The drill's failed job is not a second alert (`job.failed`). |
| `backup.drill.passed` | —                    | History only: the schedule's run says it.                    |
| `liveSync.conflicts`  | `liveSync.conflicts` |                                                              |
| `watch.matched`       | `watch.matched`      |                                                              |

The alert's detail is the event's details with its `severity`, `summary` and `namespace`. A live sync
that stops by itself is not an app event: the alerts read it from the sync's own record
(`AlertService.onLiveSync`, `liveSync.stopped`), so it is told once.

## Kinds

| Kind                  | Severity            | When                                                                                                                         | Details                                                           |
| --------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `backup.drill.passed` | info                | A scheduled restore drill restored a backup into a scratch database and verified it                                          | `schedule`, `run`, `backup`, `namespaces`, `mismatched`, `reason` |
| `backup.drill.failed` | critical or warning | A drill could not restore, found counts or contents that differ (critical), or could not drop its scratch database (warning) | `schedule`, `run`, `backup`, `namespaces`, `mismatched`, `reason` |
| `liveSync.conflicts`  | warning             | A two-way live sync settled conflicting changes (last writer wins), once per batch                                           | `sync`, `conflicts`, `side`                                       |
| `watch.matched`       | info                | A Watch feed asked to alert passed events through its filter (at most every 10 s)                                            | `watch`, `operation`, `count`                                     |
