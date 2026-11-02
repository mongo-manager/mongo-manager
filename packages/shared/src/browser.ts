/**
 * Browser-safe entry: everything the web app may import at runtime. It leaves out the
 * connection-string parser (mongodb-connection-string-url → whatwg-url), which is server-only.
 */
export * from './errors'
export * from './permissions'
export * from './ejson'
export * from './schemas'
export {
  MAX_DEPTH,
  MAX_INPUT_LENGTH,
  parsePipeline,
  parseQueryObject,
  parseShellExpression,
} from './query/parse'
export { QueryParseError } from './query/errors'
export { formatShell, type FormatOptions } from './query/format'
export {
  MAX_QUERY_PARAMS,
  PARAM_KEY,
  fillParams,
  isParam,
  paramOf,
  paramsOf,
  parseParamValue,
  type ParamFillError,
  type ParamMarker,
} from './query/params'
export type { ParseOptions } from './query/parse'
export * from './connection-constants'
export * from './mongo-version'
export * from './schema/analyse'
export * from './schema/export'
export * from './api/data'
export * from './api/jobs'
export * from './api/transfer'
export * from './api/backup'
export * from './api/destinations'
export * from './api/schedules'
export * from './api/watch'
export * from './api/liveSync'
// Audit action labels (2026-10-28): every action the audit log holds.
export * from './api/audit'
// W4: app events (alerts subscribe to them).
export * from './api/appEvents'
// Phase 4a-1: the AI assistant.
export * from './api/ai'
export * from './api/aiChat'
export * from './api/aiAgent'
export * from './api/aiHistory'
export * from './api/dashboard'
// completion W6.4: a database's data model.
export * from './api/dataModel'
// completion W6.2: the Overview's next steps.
export * from './api/nextActions'
// Phase 4b: GridFS files.
export * from './api/gridfs'
// W8: client-side encryption (data keys, encrypted collections).
export * from './api/encryption'
export * from './api/plugins'
export * from './api/pluginVersions'
export * from './markdown/fences'
export * from './schedule/zone'
export * from './schedule/cron'
export * from './schedule/cadence'
export * from './schedule/describe'
export * from './schedule/retention'
export * from './api/aggregate'
export * from './api/explain'
export * from './api/validation'
export * from './api/library'
export * from './api/shell'
export * from './api/snippets'
export * from './aggregation/pipeline'
export * from './aggregation/catalogue'
export {
  EXPORT_LANGUAGES,
  exportFind,
  exportPipeline,
  stringLiteral,
  type ExportLanguage,
  type FindExport,
} from './aggregation/export'
export { documentDiff, pathSafe, type DocumentDiff, type FieldChange } from './diff'
// Phase 3a-2: turning database and form text into inert shell code, and CSV export.
export * from './shell/literals'
// Secret-looking values in shell code masked: the audit log, and a command shown again on the page.
export { maskShellSecrets } from './shell/secrets'
// Whether shell code may go on (mongosh's "..."), and the shell commands a line can be.
export { CodeScanner, isIncomplete, shellCommand } from './shell/scan'
export { MAX_CSV_COLUMNS, csvCell, csvFile, flattenDocument, toCsv } from './csv'
export * from './shell/catalogue.generated'
export { HIDDEN, maskStrings } from './shell/mask'
// Phase 3b: the personal-field rules of a connection.
export * from './masking/rules'
export * from './masking/glob'
// Phase 3b: the server dashboard's filters.
export * from './api/server-dashboard'
// Plugins wave 4: a database's storage, compact, a shard key's analysis.
export * from './api/storage'
// W3: MongoDB users and roles, sharding management, alerts and live health.
export * from './api/database-access'
export * from './api/sharding-admin'
export * from './api/alerts'
// W5: keyboard shortcuts, and each user's own bindings of the global ones.
export * from './shortcuts'
// Password strength (2026-10-28): account password rules and meter, shared by browser and server.
export * from './password-policy'
// Session lifetime (2026-10-29): the idle time an administrator chooses.
export * from './api/session-policy'
// Sign-in bans (2026-10-30): addresses refused at the team-mode sign-in.
export * from './api/sign-in-bans'
// Panel access (2026-10-30): the addresses the team-mode panel answers.
export * from './api/access-list'
// Languages (2026-10-29): the app's ten languages.
export * from './languages'
