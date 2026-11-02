/**
 * Phase 3a-1 spec §8: mask secret-looking values before a shell command is written to the audit log.
 * The rule is shared with the page, which masks a command it shows again (review 2026-10-12, M5).
 */
export { maskShellSecrets as maskCode } from '@mongo-manager/shared'
