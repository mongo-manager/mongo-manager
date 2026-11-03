/**
 * Phase 3a-1 spec §8: mask secret-looking values in shell code — before it is written to the audit
 * log, and wherever the page shows a command again (the result history: review 2026-10-12, M5).
 * Passwords and tokens in code, credentialed URIs and long hex/base64 runs become `***`. The result
 * is also cut to a fixed length by the caller.
 */
const SECRET_KEY = /\b(pass(word)?|pwd|secret|token|key|credential|apikey|api_key)\b/i

export function maskShellSecrets(code: string): string {
  let masked = code
  // key: 'value' or key = "value" or key: `value` (backquotes too: security review 2026-10-13). The
  // key starts where a name begins (CodeQL 2026-11-01, polynomial ReDoS): a long run of name
  // characters is read once, not from each of its positions.
  masked = masked.replace(
    /(['"]?(?<![\w$])[A-Za-z_$][\w$]*['"]?\s*[:=]\s*)(['"`])((?:\\.|(?!\2).)*)\2/g,
    (match, prefix: string, quote: string) => {
      const keyPart = match.slice(0, prefix.length)
      return SECRET_KEY.test(keyPart) ? `${prefix}${quote}***${quote}` : match
    },
  )
  // Credentials in a mongodb URI: mongodb://user:pass@host
  masked = masked.replace(/(mongodb(?:\+srv)?:\/\/[^\s'"`:/@]+:)([^\s'"`@]+)(@)/gi, '$1***$3')
  // db.auth('user', 'password') and db.changeUserPassword('user', 'password') — the password is the
  // second string argument (changeUserPassword: security review 2026-10-13), whether the user is a
  // string or a name (a variable, a field: its review, minor 7).
  masked = masked.replace(
    /(\.(?:auth|changeUserPassword)\s*\(\s*(?:(['"`])(?:\\.|(?!\2).)*\2|[^,()'"`]+?)\s*,\s*)(['"`])((?:\\.|(?!\3).)*)\3/g,
    '$1$3***$3',
  )
  // Long opaque tokens (32+ hex or base64-ish), even without a telltale key.
  masked = masked.replace(/\b[A-Fa-f0-9]{32,}\b/g, '***')
  masked = masked.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '***')
  return masked
}
