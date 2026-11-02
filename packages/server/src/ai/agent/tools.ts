import { z } from 'zod'
import {
  AI_AGENT_LIMITS,
  AI_AGENT_SECTIONS,
  AI_AGENT_WRITE_TOOLS,
  ALERT_METRICS,
  RULE_EVENTS,
  type RuleEvent,
  BACKUP_FORMATS,
  COPY_MODES,
  EXPORT_FORMATS,
  SEARCH_INDEX_TYPES,
  VALIDATION_ACTIONS,
  VALIDATION_LEVELS,
  SQL_DIALECTS,
  JOB_STATES,
  RESTORE_MODES,
  RETENTION_PRESETS,
  type AiAgentTool,
} from '@mongo-manager/shared'
import type { JsonSchema, ToolSpec } from './wire'

/** A4: the schedule's retention presets, by name. */
const RETENTION_NAMES = Object.keys(RETENTION_PRESETS) as [
  keyof typeof RETENTION_PRESETS,
  ...Array<keyof typeof RETENTION_PRESETS>,
]
const RETENTION_WORDS = Object.entries(RETENTION_PRESETS)
  .map(([name, r]) => `${name} (${r.last} last, ${r.daily} daily, ${r.weekly} weekly, ${r.monthly} monthly)`)
  .join('; ')

/**
 * W6.3: the agent's tools as the model sees them. MongoDB values (filters, documents, pipelines,
 * keys) travel as JSON text — Extended JSON or the shell's constructors — and are read with the app's
 * safe evaluator, so every provider's schema dialect takes them (Gemini's object schemas need named
 * properties). Names are plain strings; the server resolves each one and checks it.
 */

const str = (description: string): JsonSchema => ({ type: 'string', description })
const CONNECTION = str('The connection’s name, exactly as listed in the data')
const DATABASE = str('The database name')
const COLLECTION = str('The collection name')
const JSON_TEXT = 'as JSON text (Extended JSON or shell syntax such as ObjectId("…") and ISODate("…"))'

const object = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: 'object',
  properties,
  required,
})
const ns = (extra: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema =>
  object({ connection: CONNECTION, database: DATABASE, collection: COLLECTION, ...extra }, [
    'connection',
    'database',
    'collection',
    ...required,
  ])

/** C7: where an alert rule or a report is said — webhooks by their names, as listed. */
const CHANNELS: Record<string, JsonSchema> = {
  inApp: { type: 'boolean', description: 'Optional: in the bell (default on)' },
  email: { type: 'boolean', description: 'Optional: by e-mail to the configured recipients (default off)' },
  webhooks: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional: webhooks by name, as listed',
  },
}

/** B1: a schedule, by its name as list_schedules gives it. */
const SCHEDULE = str('The schedule’s name, as listed')
/** Review of B1 (M6): two schedules of one name, told apart by their connection. */
const SCHEDULE_CONNECTION = str('Optional: its connection, where two schedules share the name')

export const TOOL_SPECS: Readonly<Record<AiAgentTool, Omit<ToolSpec, 'name'>>> = {
  list_connections: {
    description:
      'List the connections you may use (names, the person’s access, read-only, whether you may propose changes).',
    parameters: object({}, []),
  },
  check_connection: {
    description:
      'Check that a connection answers, and open it in the app as the person would: connected, or the kind of failure (network, timeout, dns, auth, tls, oidc — the person must sign in —, ssh, ssh-host-key, config).',
    parameters: object({ connection: CONNECTION }, ['connection']),
  },
  list_databases: {
    description: 'List the databases of a connection.',
    parameters: object({ connection: CONNECTION }, ['connection']),
  },
  list_collections: {
    description: 'List the collections and views of a database.',
    parameters: object({ connection: CONNECTION, database: DATABASE }, ['connection', 'database']),
  },
  collection_stats: {
    description: 'A collection’s document count, sizes and index count.',
    parameters: ns(),
  },
  find_documents: {
    description: `Find documents (at most ${AI_AGENT_LIMITS.documents}). Their values reach you only when the person allowed documents for this message; otherwise you get how many were found.`,
    parameters: ns({
      filter: str(`The filter ${JSON_TEXT}; {} for all`),
      projection: str(`Optional projection ${JSON_TEXT}`),
      sort: str(`Optional sort ${JSON_TEXT}`),
      limit: {
        type: 'integer',
        description: `1 to ${AI_AGENT_LIMITS.documents}`,
        minimum: 1,
        maximum: AI_AGENT_LIMITS.documents,
      },
    }),
  },
  distinct_values: {
    description:
      'A field’s distinct values, most frequent first, with how often each occurs (an array’s elements each count). The values come only when the person allowed documents for this message, and never a personal field’s; otherwise how many there are.',
    parameters: ns({
      field: str('The field’s path (dots for nested fields)'),
      filter: str(`Optional: only the documents a filter matches ${JSON_TEXT}`),
    }),
  },
  count_documents: {
    description: 'Count the documents a filter matches.',
    parameters: ns({ filter: str(`The filter ${JSON_TEXT}; {} for all`) }),
  },
  analyze_schema: {
    description:
      'The fields of a collection from a sample: paths, types and how often each occurs (no values).',
    parameters: ns(),
  },
  list_indexes: {
    description: 'The indexes of a collection: names, keys and options.',
    parameters: ns(),
  },
  explain_query: {
    description: 'The query plan of a find filter or of a pipeline (nothing is run).',
    parameters: ns({
      filter: str(`A find filter ${JSON_TEXT}`),
      sort: str(`Optional sort ${JSON_TEXT}`),
      pipeline: str(`Or an aggregation pipeline (an array of stages) ${JSON_TEXT}`),
    }),
  },
  run_aggregation: {
    description: `Run a read-only aggregation pipeline (no $out or $merge, no server JavaScript); at most ${AI_AGENT_LIMITS.documents} results. Their values reach you only when the person allowed documents for this message.`,
    parameters: ns(
      {
        pipeline: str(`The array of stages ${JSON_TEXT}`),
        limit: {
          type: 'integer',
          description: `1 to ${AI_AGENT_LIMITS.documents}`,
          minimum: 1,
          maximum: AI_AGENT_LIMITS.documents,
        },
      },
      ['pipeline'],
    ),
  },
  list_backup_destinations: {
    description: 'The backup destinations the person may send backups to (names and kinds).',
    parameters: object({}, []),
  },
  create_database: {
    description: 'Propose creating a database with its first collection. The person confirms it first.',
    parameters: object(
      { connection: CONNECTION, database: DATABASE, collection: str('Its first collection') },
      ['connection', 'database', 'collection'],
    ),
  },
  create_collection: {
    description:
      'Propose creating a collection (the database is created with it when new). The person confirms it first.',
    parameters: ns({
      kind: {
        type: 'string',
        enum: ['collection', 'capped', 'timeseries', 'view'],
        description: 'Default: collection',
      },
      size: { type: 'integer', description: 'Capped: the size in bytes (at least 4096)' },
      max: { type: 'integer', description: 'Capped: at most this many documents' },
      timeField: str('Time series: the field holding the time'),
      metaField: str('Time series: the field holding the metadata'),
      granularity: {
        type: 'string',
        enum: ['seconds', 'minutes', 'hours'],
        description: 'Time series granularity',
      },
      expireAfterSeconds: {
        type: 'integer',
        description: 'Time series: remove documents after this many seconds',
      },
      clustered: { type: 'boolean', description: 'A clustered collection (by _id)' },
      viewOn: str('View: the collection it reads'),
      pipeline: str(`View: its pipeline ${JSON_TEXT}`),
    }),
  },
  insert_documents: {
    description: `Propose inserting documents (1 to ${AI_AGENT_LIMITS.insertDocuments}). The person sees them and confirms first.`,
    parameters: ns({ documents: str(`An array of documents ${JSON_TEXT}`) }, ['documents']),
  },
  update_documents: {
    description:
      'Propose updating every document a filter matches with update operators such as $set. The person sees how many match and confirms first.',
    parameters: ns(
      {
        filter: str(`The filter ${JSON_TEXT}`),
        update: str(`Update operators such as {"$set": {…}} ${JSON_TEXT}`),
      },
      ['filter', 'update'],
    ),
  },
  delete_documents: {
    description:
      'Propose deleting every document a filter matches. The person sees how many match and confirms first.',
    parameters: ns({ filter: str(`The filter ${JSON_TEXT}`) }, ['filter']),
  },
  create_index: {
    description: 'Propose creating an index. The person confirms it first.',
    parameters: ns(
      {
        keys: str(`The index keys ${JSON_TEXT}, such as {"email": 1}`),
        name: str('Optional index name'),
        unique: { type: 'boolean', description: 'Unique index' },
        sparse: { type: 'boolean', description: 'Sparse index' },
        hidden: { type: 'boolean', description: 'Hidden index' },
        expireAfterSeconds: { type: 'integer', description: 'TTL: remove documents after this many seconds' },
        partialFilterExpression: str(`Optional partial filter ${JSON_TEXT}`),
      },
      ['keys'],
    ),
  },
  drop_index: {
    description: 'Propose dropping an index by name. The person confirms it first.',
    parameters: ns({ name: str('The index name') }, ['name']),
  },
  drop_collection: {
    description: 'Propose dropping a collection. The person types its name to confirm.',
    parameters: ns(),
  },
  drop_database: {
    description: 'Propose dropping a database. The person types its name to confirm.',
    parameters: object({ connection: CONNECTION, database: DATABASE }, ['connection', 'database']),
  },
  run_backup: {
    description:
      'Propose a backup of a collection, a database or the whole connection, kept on the server. An encrypted backup (mmbak, the default) asks the person for its password; its card also lets them make it without one, as a compressed archive (gzip), where that may be made — the outcome says the format made. The person confirms it first; once made, they download it from the step (Download), or from Backups.',
    parameters: object(
      {
        connection: CONNECTION,
        database: str('Optional: back up this database (or the collection in it)'),
        collection: str('Optional: back up this collection only'),
        format: { type: 'string', enum: [...BACKUP_FORMATS], description: 'Default: mmbak (encrypted)' },
        destinations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: backup destinations (by name) to send it to once kept',
        },
        deleteLocal: {
          type: 'boolean',
          description: 'With destinations: remove the copy kept on the server once every one has it',
        },
      },
      ['connection'],
    ),
  },
  list_jobs: {
    description:
      'The person’s jobs (backups, copies, imports, index builds…), newest first: kind, where, state and progress. Optionally of one connection or one state.',
    parameters: object(
      {
        connection: str('Optional connection'),
        state: {
          type: 'string',
          enum: [...JOB_STATES],
          description: 'Optional state',
        },
      },
      [],
    ),
  },
  get_job: {
    description: 'One job by its id (as run_backup or list_jobs gave it): its state and progress.',
    parameters: object({ job: str('The job id') }, ['job']),
  },
  list_backups: {
    description:
      'The backups kept on the server that the person may use, newest first: name, scope, format, size and when each is removed.',
    parameters: object({ connection: str('Optional connection') }, []),
  },
  create_backup_schedule: {
    description:
      'Propose a backup schedule that sends backups to destinations. The person confirms it first.',
    parameters: object(
      {
        connection: CONNECTION,
        name: str('The schedule’s name'),
        database: str('Optional: back up this database (or the collection in it)'),
        collection: str('Optional: back up this collection only'),
        cadence: str(
          'The cadence as JSON text: {"kind":"daily","times":["02:00"]}, {"kind":"hourly","every":6,"minute":0}, {"kind":"weekly","days":[1],"time":"03:00"}, {"kind":"monthly","day":1,"time":"03:00"} or {"kind":"cron","expression":"0 2 * * *"}',
        ),
        timeZone: str('Optional IANA time zone such as Europe/Istanbul; by default the person’s own'),
        destinations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Destination names, as listed',
        },
        keepOnServer: { type: 'boolean', description: 'Also keep each backup on the server' },
        retention: {
          type: 'string',
          enum: [...RETENTION_NAMES],
          // Review of A4 (M5): said from the presets themselves, so the words never drift.
          description: `What it keeps (by default standard): ${RETENTION_WORDS}`,
        },
        format: { type: 'string', enum: [...BACKUP_FORMATS], description: 'Default: mmbak (encrypted)' },
      },
      ['connection', 'name', 'cadence', 'destinations'],
    ),
  },
  restore_backup: {
    description:
      'Propose restoring one of the person’s backups (by its name as listed) into a connection: into its own database by default, or a database (and, for a backup of one collection, a collection) named. insert adds what is missing, upsert replaces matching documents, replace empties each target first. The person types the target’s name, and an encrypted backup’s password, on the card.',
    parameters: object(
      {
        backup: str('The backup’s name (or its id), as list_backups gives it'),
        from: str('Optional: the connection the backup was made of, where two backups share a name'),
        connection: CONNECTION,
        database: str('Optional: restore into this database (by default the backup’s own)'),
        collection: str('Optional, for a backup of one collection: restore into this collection'),
        mode: { type: 'string', enum: [...RESTORE_MODES], description: 'Default: insert' },
      },
      ['backup', 'connection'],
    ),
  },
  list_schedules: {
    description:
      'List the person’s own backup schedules: name, connection, what, cadence, time zone, state, next run, destinations, retention and how the last runs went.',
    parameters: object({ connection: str('Optional: only this connection’s') }, []),
  },
  run_schedule: {
    description:
      'Propose running one of the person’s schedules now, by its name as listed. The person confirms it first.',
    parameters: object({ schedule: SCHEDULE, connection: SCHEDULE_CONNECTION }, ['schedule']),
  },
  pause_schedule: {
    description:
      'Propose pausing one of the person’s schedules, by its name as listed. The person confirms it first.',
    parameters: object({ schedule: SCHEDULE, connection: SCHEDULE_CONNECTION }, ['schedule']),
  },
  resume_schedule: {
    description:
      'Propose resuming one of the person’s paused schedules, by its name as listed. The person confirms it first.',
    parameters: object({ schedule: SCHEDULE, connection: SCHEDULE_CONNECTION }, ['schedule']),
  },
  update_schedule: {
    description:
      'Propose changing one of the person’s schedules (only what is given changes). The card says the backups a new retention, zone or destinations remove now. The person confirms it first.',
    parameters: object(
      {
        schedule: SCHEDULE,
        connection: SCHEDULE_CONNECTION,
        name: str('Optional: its new name'),
        cadence: str('Optional: its new cadence, as JSON text (as create_backup_schedule takes it)'),
        timeZone: str('Optional: its new IANA time zone'),
        destinations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: its destinations, by their names as listed (replacing the ones it has)',
        },
        keepOnServer: { type: 'boolean', description: 'Optional: also keep each backup on the server' },
        retention: {
          type: 'string',
          enum: [...RETENTION_NAMES],
          description: `Optional: what it keeps: ${RETENTION_WORDS}`,
        },
      },
      ['schedule'],
    ),
  },
  delete_schedule: {
    description:
      'Propose deleting one of the person’s schedules (its backups stay). The person types its name to confirm.',
    parameters: object({ schedule: SCHEDULE, connection: SCHEDULE_CONNECTION }, ['schedule']),
  },
  server_status: {
    description:
      'The server’s health now: version, uptime, connections, operations per second, memory, cache and queues (numbers only).',
    parameters: object({ connection: CONNECTION }, ['connection']),
  },
  replica_set: {
    description:
      'The replica set: each member by number (never its host), its state, health, lag behind the primary, and the oplog window; or that the server is standalone or sharded.',
    parameters: object({ connection: CONNECTION }, ['connection']),
  },
  server_top: {
    description:
      'The busiest collections since the server started: time spent reading and writing, and how many operations.',
    parameters: object({ connection: CONNECTION }, ['connection']),
  },
  slow_queries: {
    description:
      'Slow operations from the profiler and the server log: collection, kind, duration, plan summary and documents examined (never the command nor a value).',
    parameters: object(
      {
        connection: CONNECTION,
        database: str('Optional: only this database’s'),
        collection: str('Optional: only this collection’s (with database)'),
      },
      ['connection'],
    ),
  },
  index_advice: {
    description:
      'Index suggestions for a database from its slow queries (fields and directions), and indexes that may be unneeded.',
    parameters: object({ connection: CONNECTION, database: DATABASE }, ['connection', 'database']),
  },
  current_operations: {
    description:
      'The operations running now, longest first: opid, kind, collection, seconds running, waiting for a lock (never the command).',
    parameters: object({ connection: CONNECTION, database: str('Optional: only this database’s') }, [
      'connection',
    ]),
  },
  kill_operation: {
    description:
      'Propose stopping one running operation, by its opid from current_operations. The person types the opid to confirm.',
    parameters: object(
      { connection: CONNECTION, opid: str('The operation’s opid, as current_operations gives it') },
      ['connection', 'opid'],
    ),
  },
  list_users: {
    description:
      'MongoDB users (never a password): name, database, roles, whether the connection signs in as it. Optional database: only its users.',
    parameters: object({ connection: CONNECTION, database: str('Optional: only this database’s users') }, [
      'connection',
    ]),
  },
  list_roles: {
    description:
      'The custom roles of a database: name, the roles they inherit, how many privileges they hold.',
    parameters: object({ connection: CONNECTION, database: DATABASE }, ['connection', 'database']),
  },
  create_user: {
    description:
      'Propose creating a MongoDB user in a database with roles ("read", "readWrite", or "role@database" for another database). The person types the password on the card — never give or ask one. No role over the whole deployment.',
    parameters: object(
      {
        connection: CONNECTION,
        database: str('The database the user signs in to (its authentication database)'),
        user: str('The user name'),
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Its roles: "role", or "role@database"',
        },
      },
      ['connection', 'database', 'user', 'roles'],
    ),
  },
  drop_user: {
    description:
      'Propose dropping a MongoDB user. The person types its name to confirm. Never the account the connection signs in as.',
    parameters: object(
      { connection: CONNECTION, database: str('Its authentication database'), user: str('The user name') },
      ['connection', 'database', 'user'],
    ),
  },
  set_validator: {
    description:
      'Propose a collection’s validation rules (a validator: a query or $jsonSchema; {} removes them), with its level and action. The card says how many documents there break them now.',
    parameters: ns(
      {
        validator: str(`The rules ${JSON_TEXT}; {} for none`),
        level: {
          type: 'string',
          enum: [...VALIDATION_LEVELS],
          description: 'Optional: strict, moderate or off (default: the rules’ current level)',
        },
        action: {
          type: 'string',
          enum: [...VALIDATION_ACTIONS],
          description: 'Optional: error, warn or errorAndLog (default: the rules’ current action)',
        },
      },
      ['validator'],
    ),
  },
  create_search_index: {
    description:
      'Propose an Atlas Search or Vector Search index on a collection (where the server has search): its name and its definition.',
    parameters: ns(
      {
        name: str('The index’s name: letters, digits, "_" and "-"'),
        type: {
          type: 'string',
          enum: [...SEARCH_INDEX_TYPES],
          description: 'Optional: search (default) or vectorSearch',
        },
        definition: str(`Its definition ${JSON_TEXT}`),
      },
      ['name', 'definition'],
    ),
  },
  rename_collection: {
    description:
      'Propose renaming a collection within its database (the person types its name to confirm; apps using the old name stop finding it).',
    parameters: ns({ to: str('The new name') }, ['to']),
  },
  copy_collection: {
    description:
      'Propose copying a collection’s documents (with its indexes and rules) to another collection — in this database, another one, or another connection — as the app’s Copy does, from the person’s own plan; followed as a job. Optional: a find’s filter or a read-only pipeline picks what goes.',
    parameters: ns(
      {
        toConnection: str('Optional: the target connection (default: the same)'),
        toDatabase: str('Optional: the target database (default: the same)'),
        toCollection: str('The target collection'),
        mode: {
          type: 'string',
          enum: [...COPY_MODES],
          description: 'Into a collection there already: insert (default), upsert, merge or replace',
        },
        filter: str(`Optional: only the documents a filter matches ${JSON_TEXT}`),
        pipeline: str('Optional, instead of a filter: a read-only pipeline (Extended JSON array)'),
      },
      ['toCollection'],
    ),
  },
  export_documents: {
    description:
      'Propose exporting a collection’s documents to a file the person downloads (csv, json, ndjson, xlsx, sql): all of them, a find (filter, projection, sort, limit) or a read-only pipeline. Their own export, with their rights; started on their click and followed as a job — no value reaches you. Once its job is done, the person downloads the file from the step (Download).',
    parameters: object(
      {
        connection: CONNECTION,
        database: DATABASE,
        collection: COLLECTION,
        format: { type: 'string', enum: [...EXPORT_FORMATS], description: 'The file’s format' },
        filter: str('Optional: a find’s filter (Extended JSON)'),
        projection: str('Optional: the fields to keep or leave out (Extended JSON)'),
        sort: str('Optional: the order (Extended JSON)'),
        limit: {
          type: 'integer',
          description: 'Optional, for a find: at most this many documents (a pipeline takes a $limit stage)',
        },
        pipeline: str('Optional, instead of a find: a read-only pipeline (Extended JSON array)'),
        gzip: { type: 'boolean', description: 'Optional: compress the file' },
        dialect: {
          type: 'string',
          enum: [...SQL_DIALECTS],
          description: 'For sql: the database it is written for (default postgres)',
        },
      },
      ['connection', 'database', 'collection', 'format'],
    ),
  },
  list_alerts: {
    description:
      'List the alerts the person may see — thresholds firing, recent events, scheduled reports’ runs — of the connections you are told of: what, where, when, numbers only.',
    parameters: object(
      {
        connection: str('Optional: one connection'),
        state: { type: 'string', enum: ['firing', 'resolved', 'event'], description: 'Optional: only these' },
      },
      [],
    ),
  },
  list_alert_rules: {
    description:
      'For an administrator: the alert rules (thresholds on a connection’s metrics, the app’s events) and the scheduled reports — their ids, what they watch or count, when, where they are said (channel names), on or off, a report’s last counts.',
    parameters: object({ connection: str('Optional: one connection') }, []),
  },
  create_alert_rule: {
    description: `Propose an alert rule on a connection (an administrator’s): a threshold on its metric (${ALERT_METRICS.join(', ')}) or one of the app’s events (${RULE_EVENTS.join(', ')}) there; said in the bell, by e-mail, to webhooks named as listed. A rule for every connection is made on the Alerts page. The person confirms it first.`,
    parameters: object(
      {
        kind: { type: 'string', enum: ['metric', 'event'], description: 'A threshold or an event' },
        connection: str('The rule’s connection'),
        metric: { type: 'string', enum: [...ALERT_METRICS], description: 'A threshold’s metric' },
        threshold: { type: 'number', description: 'A threshold’s value' },
        sustain: { type: 'integer', description: 'Minutes above it before it fires (1–60, default 2)' },
        slowOpSeconds: { type: 'integer', description: 'slowOps: an operation counts once this long' },
        event: { type: 'string', enum: [...RULE_EVENTS], description: 'An event rule’s event' },
        ...CHANNELS,
      },
      ['kind'],
    ),
  },
  update_alert_rule: {
    description:
      'Propose a change to an alert rule by its id (list_alert_rules): its threshold, minutes, on or off, where it is said. The person confirms it first.',
    parameters: object(
      {
        rule: str('The rule’s id'),
        threshold: { type: 'number', description: 'Optional: a new threshold' },
        sustain: { type: 'integer', description: 'Optional: minutes above it (1–60)' },
        enabled: { type: 'boolean', description: 'Optional: on or off' },
        ...CHANNELS,
      },
      ['rule'],
    ),
  },
  snooze_alert_rule: {
    description:
      'Propose snoozing an alert rule (by its id) for some minutes — alerts still recorded, none sent — or waking it (minutes 0). The person confirms it first.',
    parameters: object(
      {
        rule: str('The rule’s id'),
        minutes: { type: 'integer', description: '1 to 43200, or 0 to wake it' },
      },
      ['rule', 'minutes'],
    ),
  },
  delete_alert_rule: {
    description: 'Propose deleting an alert rule by its id. The person confirms it first.',
    parameters: object({ rule: str('The rule’s id') }, ['rule']),
  },
  create_report: {
    description:
      'Propose a scheduled report (an administrator’s): a few counts of one connection said on a cadence through the alert channels — numbers only, never by a personal field, never a view. The person confirms it first.',
    parameters: object(
      {
        connection: CONNECTION,
        name: str('The report’s name'),
        counts: {
          type: 'array',
          description: 'One to ten counts',
          items: object(
            {
              label: str('What this count is called'),
              database: DATABASE,
              collection: COLLECTION,
              filter: str(`Optional: only the documents a filter matches ${JSON_TEXT}`),
            },
            ['label', 'database', 'collection'],
          ),
        },
        cadence: str(
          'The cadence as JSON text: {"kind":"daily","times":["09:00"]}, {"kind":"weekly","days":[1],"time":"09:00"}, {"kind":"hourly","every":6,"minute":0}, {"kind":"monthly","day":1,"time":"09:00"} or {"kind":"cron","expression":"0 9 * * 1"}',
        ),
        timeZone: str('Optional IANA time zone such as Europe/Istanbul; by default the person’s own'),
        ...CHANNELS,
      },
      ['connection', 'name', 'counts', 'cadence'],
    ),
  },
  update_report: {
    description:
      'Propose a change to a scheduled report (by its name or id): on or off, its name, its cadence, where it is said. The person confirms it first.',
    parameters: object(
      {
        report: str('The report’s name or id'),
        enabled: { type: 'boolean', description: 'Optional: on or off' },
        name: str('Optional: a new name'),
        cadence: str('Optional: a new cadence, as JSON text as create_report takes it'),
        timeZone: str('Optional: its time zone'),
        ...CHANNELS,
      },
      ['report'],
    ),
  },
  run_report: {
    description:
      'Propose running a scheduled report now (by its name or id): its counts said through its channels, as a scheduled run. The person confirms it first.',
    parameters: object({ report: str('The report’s name or id') }, ['report']),
  },
  delete_report: {
    description: 'Propose deleting a scheduled report (by its name or id). The person confirms it first.',
    parameters: object({ report: str('The report’s name or id') }, ['report']),
  },
  plan_changes: {
    description:
      'Before two or more changes asked for together, show them to the person first as a plan. Each then comes on its own card, in this order, confirmed one by one: a change declined or refused stops the rest. Name each change’s tool and say in a few words what it does.',
    parameters: object(
      {
        title: str('A few words for the whole plan'),
        changes: {
          type: 'array',
          description: `The changes, in the order they will be proposed (2 to ${AI_AGENT_LIMITS.planChanges})`,
          items: object(
            {
              tool: { type: 'string', enum: [...AI_AGENT_WRITE_TOOLS], description: 'The change’s tool' },
              about: str('What this change does, in a few words'),
            },
            ['tool', 'about'],
          ),
        },
      },
      ['title', 'changes'],
    ),
  },
  open_in_app: {
    description:
      'Open a connection, a database or a collection (one of its sections) in the app for the person. To show documents, give a collection with a find (filter, sort, projection) or a pipeline: the app runs it with the person’s rights and shows the result — no values reach you.',
    parameters: object(
      {
        connection: CONNECTION,
        database: str('Optional database'),
        collection: str('Optional collection'),
        section: {
          type: 'string',
          enum: [...AI_AGENT_SECTIONS],
          description: 'Optional section of the collection',
        },
        filter: str('Optional find filter to run there, as Extended JSON'),
        sort: str('Optional sort for the find'),
        projection: str('Optional projection for the find'),
        pipeline: str('Optional pipeline to open in the builder instead of a find, as a JSON array'),
        limit: { type: 'integer', description: 'Optional: how many documents the find shows (1 to 1000)' },
      },
      ['connection'],
    ),
  },
}

export const toolSpecs = (): ToolSpec[] =>
  (Object.entries(TOOL_SPECS) as Array<[AiAgentTool, Omit<ToolSpec, 'name'>]>).map(([name, s]) => ({
    name,
    ...s,
  }))

/** Arguments as the server reads them (lenient about extra keys, strict about what it uses). */
const Name = z.string().trim().min(1).max(255)
const Json = z.union([z.string().max(64 * 1024), z.record(z.string(), z.unknown()), z.array(z.unknown())])
const Limit = z.number().int().min(1).max(AI_AGENT_LIMITS.documents).optional()
const Ns = { connection: Name, database: Name, collection: Name }
/** B1: a schedule by its name, as listed. */
const ScheduleName = z.string().trim().min(1).max(80)

/** A blank string read as none. */
const blankNone = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && !v.trim() ? undefined : v), schema)

/** C7: the channels as the model names them. */
const ChannelArgs = {
  inApp: z.boolean().optional(),
  email: z.boolean().optional(),
  webhooks: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
}

export const TOOL_ARGS = {
  list_connections: z.object({}),
  check_connection: z.object({ connection: Name }),
  list_databases: z.object({ connection: Name }),
  list_collections: z.object({ connection: Name, database: Name }),
  collection_stats: z.object(Ns),
  find_documents: z.object({
    ...Ns,
    filter: Json.optional(),
    projection: Json.optional(),
    sort: Json.optional(),
    limit: Limit,
  }),
  count_documents: z.object({ ...Ns, filter: Json.optional() }),
  analyze_schema: z.object(Ns),
  list_indexes: z.object(Ns),
  explain_query: z.object({
    ...Ns,
    filter: Json.optional(),
    sort: Json.optional(),
    pipeline: Json.optional(),
  }),
  run_aggregation: z.object({ ...Ns, pipeline: Json, limit: Limit }),
  distinct_values: z.object({ ...Ns, field: z.string().min(1).max(255), filter: Json.optional() }),
  list_backup_destinations: z.object({}),
  create_database: z.object(Ns),
  create_collection: z.object({
    ...Ns,
    kind: z.enum(['collection', 'capped', 'timeseries', 'view']).default('collection'),
    size: z.number().int().optional(),
    max: z.number().int().optional(),
    timeField: z.string().max(256).optional(),
    metaField: z.string().max(256).optional(),
    granularity: z.enum(['seconds', 'minutes', 'hours']).optional(),
    expireAfterSeconds: z.number().int().optional(),
    clustered: z.boolean().optional(),
    viewOn: Name.optional(),
    pipeline: Json.optional(),
  }),
  insert_documents: z.object({ ...Ns, documents: Json }),
  update_documents: z.object({ ...Ns, filter: Json, update: Json }),
  delete_documents: z.object({ ...Ns, filter: Json }),
  create_index: z.object({
    ...Ns,
    keys: Json,
    name: z.string().min(1).max(512).optional(),
    unique: z.boolean().optional(),
    sparse: z.boolean().optional(),
    hidden: z.boolean().optional(),
    expireAfterSeconds: z.number().int().min(0).optional(),
    partialFilterExpression: Json.optional(),
  }),
  drop_index: z.object({ ...Ns, name: z.string().min(1).max(512) }),
  drop_collection: z.object(Ns),
  drop_database: z.object({ connection: Name, database: Name }),
  run_backup: z.object({
    connection: Name,
    database: Name.optional(),
    collection: Name.optional(),
    format: z.enum(BACKUP_FORMATS).default('mmbak'),
    destinations: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
    deleteLocal: z.boolean().default(false),
  }),
  list_jobs: z.object({
    connection: Name.optional(),
    state: z.enum(JOB_STATES).optional(),
  }),
  get_job: z.object({ job: z.uuid() }),
  list_backups: z.object({ connection: Name.optional() }),
  create_backup_schedule: z.object({
    connection: Name,
    name: z.string().trim().min(1).max(80),
    database: Name.optional(),
    collection: Name.optional(),
    cadence: Json,
    timeZone: z.string().min(1).max(64).optional(),
    // A4: none is refused in words (no_destination), not as an argument the model got wrong.
    destinations: z.array(Name).max(8),
    keepOnServer: z.boolean().optional(),
    format: z.enum(BACKUP_FORMATS).default('mmbak'),
    retention: z.enum(RETENTION_NAMES).default('standard'),
  }),
  restore_backup: z.object({
    backup: z.string().trim().min(1).max(255),
    from: blankNone(Name.optional()),
    connection: Name,
    database: blankNone(Name.optional()),
    collection: blankNone(Name.optional()),
    mode: z.enum(RESTORE_MODES).default('insert'),
  }),
  list_schedules: z.object({ connection: Name.optional() }),
  run_schedule: z.object({ schedule: ScheduleName, connection: blankNone(Name.optional()) }),
  pause_schedule: z.object({ schedule: ScheduleName, connection: blankNone(Name.optional()) }),
  resume_schedule: z.object({ schedule: ScheduleName, connection: blankNone(Name.optional()) }),
  update_schedule: z.object({
    schedule: ScheduleName,
    connection: blankNone(Name.optional()),
    name: blankNone(ScheduleName.optional()),
    cadence: blankNone(Json.optional()),
    timeZone: blankNone(z.string().min(1).max(64).optional()),
    destinations: z.array(Name).max(8).optional(),
    keepOnServer: z.boolean().optional(),
    retention: z.enum(RETENTION_NAMES).optional(),
  }),
  delete_schedule: z.object({ schedule: ScheduleName, connection: blankNone(Name.optional()) }),
  server_status: z.object({ connection: Name }),
  replica_set: z.object({ connection: Name }),
  server_top: z.object({ connection: Name }),
  slow_queries: z.object({
    connection: Name,
    database: blankNone(Name.optional()),
    collection: blankNone(Name.optional()),
  }),
  index_advice: z.object({ connection: Name, database: Name }),
  current_operations: z.object({ connection: Name, database: blankNone(Name.optional()) }),
  // An opid as text, whichever way the model writes it (a number, or a shard's "shard:123").
  kill_operation: z.object({
    connection: Name,
    // Fourth review of B3 (M4): as the list takes it (a number, or a shard's "shard:123").
    opid: z
      .union([z.string().trim().min(1).max(64), z.number().int()])
      .transform(String)
      .pipe(z.string().regex(/^(-?\d{1,20}|[A-Za-z0-9_.-]{1,42}:-?\d{1,20})$/)),
  }),
  list_users: z.object({ connection: Name, database: blankNone(Name.optional()) }),
  list_roles: z.object({ connection: Name, database: Name }),
  // B4: a role as "role" (the user's own database) or "role@database".
  create_user: z.object({
    connection: Name,
    database: Name,
    user: z.string().min(1).max(256),
    roles: z.array(z.string().trim().min(1).max(300)).max(20),
  }),
  drop_user: z.object({ connection: Name, database: Name, user: z.string().min(1).max(256) }),
  set_validator: z.object({
    ...Ns,
    validator: Json,
    level: z.enum(VALIDATION_LEVELS).optional(),
    action: z.enum(VALIDATION_ACTIONS).optional(),
  }),
  create_search_index: z.object({
    ...Ns,
    name: z.string().min(1).max(200),
    type: z.enum(SEARCH_INDEX_TYPES).optional(),
    definition: Json,
  }),
  rename_collection: z.object({ ...Ns, to: Name }),
  copy_collection: z.object({
    ...Ns,
    toConnection: blankNone(Name.optional()),
    toDatabase: blankNone(Name.optional()),
    toCollection: Name,
    mode: z.enum(COPY_MODES).optional(),
    filter: Json.optional(),
    pipeline: Json.optional(),
  }),
  export_documents: z.object({
    ...Ns,
    format: z.enum(EXPORT_FORMATS),
    filter: Json.optional(),
    projection: Json.optional(),
    sort: Json.optional(),
    limit: z.number().int().min(1).max(1_000_000_000).optional(),
    pipeline: Json.optional(),
    gzip: z.boolean().optional(),
    dialect: z.enum(SQL_DIALECTS).optional(),
  }),
  list_alerts: z.object({
    connection: blankNone(Name.optional()),
    state: z.enum(['firing', 'resolved', 'event']).optional(),
  }),
  list_alert_rules: z.object({ connection: blankNone(Name.optional()) }),
  create_alert_rule: z.object({
    kind: z.enum(['metric', 'event']),
    connection: blankNone(Name.optional()),
    metric: z.enum(ALERT_METRICS).optional(),
    threshold: z.number().min(0).max(1e12).optional(),
    sustain: z.number().int().min(1).max(60).optional(),
    slowOpSeconds: z.number().int().min(1).max(86_400).optional(),
    event: z.enum(RULE_EVENTS as [RuleEvent, ...RuleEvent[]]).optional(),
    ...ChannelArgs,
  }),
  update_alert_rule: z.object({
    rule: z.string().trim().min(1).max(64),
    threshold: z.number().min(0).max(1e12).optional(),
    sustain: z.number().int().min(1).max(60).optional(),
    enabled: z.boolean().optional(),
    ...ChannelArgs,
  }),
  snooze_alert_rule: z.object({
    rule: z.string().trim().min(1).max(64),
    minutes: z
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60),
  }),
  delete_alert_rule: z.object({ rule: z.string().trim().min(1).max(64) }),
  create_report: z.object({
    connection: Name,
    name: z.string().trim().min(1).max(80),
    counts: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(60),
          database: Name,
          collection: Name,
          filter: Json.optional(),
        }),
      )
      .min(1)
      .max(10),
    cadence: Json,
    timeZone: z.string().min(1).max(64).optional(),
    ...ChannelArgs,
  }),
  update_report: z.object({
    report: z.string().trim().min(1).max(80),
    enabled: z.boolean().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    cadence: Json.optional(),
    timeZone: z.string().min(1).max(64).optional(),
    ...ChannelArgs,
  }),
  run_report: z.object({ report: z.string().trim().min(1).max(80) }),
  delete_report: z.object({ report: z.string().trim().min(1).max(80) }),
  plan_changes: z.object({
    title: z.string().trim().min(1).max(120),
    changes: z
      .array(z.object({ tool: z.enum(AI_AGENT_WRITE_TOOLS), about: z.string().trim().min(1).max(200) }))
      .min(2)
      .max(AI_AGENT_LIMITS.planChanges),
  }),
  open_in_app: z.object({
    connection: Name,
    // Re-review (M4): a blank one is none, as the query fields are (some models fill every field).
    database: blankNone(Name.optional()),
    collection: blankNone(Name.optional()),
    section: blankNone(z.enum(AI_AGENT_SECTIONS).optional()),
    filter: Json.optional(),
    sort: Json.optional(),
    projection: Json.optional(),
    pipeline: Json.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
} satisfies Record<AiAgentTool, z.ZodType>

export type ToolArgs<T extends AiAgentTool> = z.output<(typeof TOOL_ARGS)[T]>
