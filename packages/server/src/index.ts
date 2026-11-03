export * from './errors'
export * from './config'
export { powershellArgs, powershellEnv, systemRoot, windowsEnv, windowsTool } from './windows-tools'
export { findTools, versionOk } from './backup/tools'
export { appendLogLine, logFileProblem } from './http/log-file'
export { parseInput } from './validate'
export { DB_FILE, openStore, transaction, type Migration, type Store } from './store/db'
export { KEY_FILE, createSecretBox, loadOrCreateKey, type SecretBox } from './crypto/secret-box'
export { setAsideEmpty, sweepPartials } from './store/key-file'
export { appKey, auditChainKey, type AppKeyPurpose } from './crypto/app-keys'
// Security audit 2026-10-16: local mode's launch links (the CLI's open commands).
export {
  LAUNCH_FILE,
  LAUNCH_TTL_OPEN_MS,
  LAUNCH_TTL_START_MS,
  LaunchGate,
  loadOrCreateLaunchSecret,
  mintForgetToken,
  mintLaunchToken,
  parseLaunchSecret,
  readLaunchSecret,
} from './auth/launch'
export { buildApp, type AppDeps } from './http/app'
export type { Principal, ServerContext } from './http/context'
export { requireAuth, requirePermission, requireTeamMode, userPrincipal } from './http/guards'
export { startServer, type StartedServer } from './server'
export { firstPluginFolder } from './plugins/bundled'
export { ConnectionManager, type TestResult } from './connections/manager'
export { toConnectionDto, type ConnectionDto, type ConnectionRecord } from './connections/repo'
export {
  LOCK_FILE,
  LOCK_INFO_FILE,
  acquireInstanceLock,
  runningInstance,
  type InstanceLock,
  type LockHolder,
  type LockPurpose,
} from './store/lock'
export {
  assertKeyMayBeCreated,
  checkKey,
  finishPendingRotation,
  keyFingerprint,
  ROTATION_KEPT_MS,
  rotateSecretKey,
  verifyKeyCheck,
  type RotationResult,
} from './crypto/rotate'
export { UserRepo, toPublicUser, type User, type UserRecord } from './auth/users'
export { SessionRepo } from './auth/sessions'
export { PasskeyRepo } from './auth/passkeys'
export { RecoveryCodeRepo } from './auth/mfa'
export { AuditRepo } from './audit/audit'
export { ConnectionRepo } from './connections/repo'
export { hashPassword, verifyPassword, passwordProblemCodes, passwordProblems } from './auth/passwords'
export { SignInBans, banTarget } from './auth/bans'
export { AccessList } from './auth/accessList'
export { defaultWebRoot, type WebAssets } from './http/web'
// Phase 3d-3a: the CLI's backup inspect and decrypt.
export { decryptMmbak, encryptMmbak, readMmbakHeader } from './backup/mmbak'
export { boundedInflate } from './backup/inflate'
export { detectContainer } from './backup/detect'
export { readArchive, type ArchiveEvent } from './backup/archive-reader'
export { readDirectoryZip } from './backup/dir-zip-reader'
// Phase 3d-3c: the CLI opens backup-key files with a recovery kit.
export { KitError, MAX_KIT_TEXT, backupKeyFingerprint, kitText, parseKit } from './backup/keys/kit'
export { slotsOf } from './backup/mmbak'
// The updater (2026-11-03): the launcher downloads a damaged version again with these.
export { downloadVersion } from './updates/install'
export { createEgress } from './net/egress'
