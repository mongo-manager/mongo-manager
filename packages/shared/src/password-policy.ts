/**
 * Password strength (2026-10-28): the rules for a Mongo Manager account's password, and how guessable
 * it is — the same code in the browser (the meter, as it is typed) and on the server (which refuses).
 * No dictionary download: the estimate counts what an attacker tries first (common words and names,
 * the username, years, sequences, keyboard rows, repeats) as cheap, and every other character by the
 * kinds of characters the password uses.
 */
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 1024

export const PASSWORD_PROBLEMS = [
  'too_short',
  'too_long',
  'contains_username',
  'too_common',
  'repeated_char',
  'too_predictable',
] as const
export type PasswordProblem = (typeof PASSWORD_PROBLEMS)[number]

const COMMON = new Set([
  'password1234',
  'password12345',
  'passwordpassword',
  'password123!',
  '123456789012',
  '1234567890123',
  'qwertyuiop12',
  'qwerty123456',
  '1q2w3e4r5t6y',
  'iloveyou1234',
  'administrator',
  'administrator1',
  'letmeinletmein',
  'changemechangeme',
  'welcome12345',
  'mongomanager',
  'mongo-manager',
  'mongodb12345',
  'admin1234567',
  'abcdefghijkl',
])

/** Words tried first, in English and Turkish (matched after undoing look-alikes and accents). */
const WORDS = [
  'password',
  'pass',
  'parola',
  'parolam',
  'sifre',
  'sifrem',
  'qwerty',
  'azerty',
  'admin',
  'administrator',
  'root',
  'welcome',
  'hosgeldin',
  'letmein',
  'iloveyou',
  'love',
  'seniseviyorum',
  'sevgilim',
  'askim',
  'canim',
  'kardesim',
  'aslan',
  'cimbom',
  'ataturk',
  'bismillah',
  'allah',
  'monkey',
  'dragon',
  'master',
  'shadow',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'superman',
  'trustno',
  'secret',
  'gizli',
  'login',
  'changeme',
  'mongo',
  'mongodb',
  'manager',
  'database',
  'default',
  'guest',
  'user',
  'test',
  'hello',
  'merhaba',
  'summer',
  'winter',
  'istanbul',
  'ankara',
  'izmir',
  'galatasaray',
  'fenerbahce',
  'besiktas',
  'trabzonspor',
  'turkiye',
  'turkey',
]
/** Common first names (four letters or more: shorter ones would match inside any word). */
const NAMES = [
  'ahmet',
  'mehmet',
  'mustafa',
  'ayse',
  'fatma',
  'emine',
  'hatice',
  'zeynep',
  'elif',
  'murat',
  'ibrahim',
  'hasan',
  'huseyin',
  'ismail',
  'osman',
  'yusuf',
  'omer',
  'emre',
  'burak',
  'deniz',
  'merve',
  'esra',
  'ozge',
  'gokhan',
  'serkan',
  'volkan',
  'hakan',
  'kemal',
  'michael',
  'jennifer',
  'john',
  'david',
  'james',
  'robert',
  'mary',
  'linda',
  'maria',
  'daniel',
  'thomas',
  'jessica',
  'sarah',
  'ashley',
]
const DICTIONARY = [...WORDS, ...NAMES]
const REVERSED = DICTIONARY.map((w) => [...w].reverse().join(''))
const WORD_BITS = Math.log2(DICTIONARY.length)
/**
 * Keyboard rows and columns people walk along, either way: US (and its Shift row), QWERTZ, AZERTY,
 * the Turkish Q and F layouts (without accents, as the estimate reads letters) and the number pad.
 */
const ROWS = [
  '1234567890',
  '!@#$%^&*()_+',
  "!'^+%&/()=?",
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'qwertzuiop',
  'azertyuiop',
  'qwertyuiopgu',
  'asdfghjklsi',
  'zxcvbnmoc',
  'fggiodrnhpqw',
  'uieautkmlysx',
  'jovcczsbr',
  '1qaz2wsx3edc4rfv5tgb',
  '!qaz@wsx#edc$rfv%tgb',
  '7894561230',
  '147258369',
]
const LINES = ROWS.flatMap((row) => [row, [...row].reverse().join('')])
/** Look-alikes undone two ways: a 1 (or !) read as i, and as l. */
const LOOK_ALIKE: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'g',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
}
const LOOK_ALIKE_L: Record<string, string> = { ...LOOK_ALIKE, '1': 'l', '!': 'l' }
const ACCENTS: Record<string, string> = { ı: 'i', ş: 's', ç: 'c', ğ: 'g', ö: 'o', ü: 'u', İ: 'i' }

export type PasswordLevel = 'veryWeak' | 'weak' | 'fair' | 'strong' | 'veryStrong'
const LEVELS: PasswordLevel[] = ['veryWeak', 'weak', 'fair', 'strong', 'veryStrong']
/** Below this many bits a password of any length is refused (too_predictable). */
const PREDICTABLE_BITS = 30

export interface PasswordStrength {
  /** 0 (very weak) to 4 (very strong). */
  score: 0 | 1 | 2 | 3 | 4
  level: PasswordLevel
  /** The estimated guessing cost, in bits. */
  bits: number
}

export interface PasswordCheck {
  /** What the server refuses, as codes the client explains in the user's language. */
  problems: PasswordProblem[]
  strength: PasswordStrength
  /** The meter's rules, each met or not: all are met exactly when there is no problem. */
  rules: { length: boolean; username: boolean; guessable: boolean }
  /** The length rule is broken by too many characters rather than too few. */
  tooLong: boolean
}

/**
 * The whole check, the estimate made once (final review M6). Characters are counted as the user
 * sees them (code points, not UTF-16 units: an emoji is one), on the NFC form (M5).
 */
export function accountPasswordCheck(raw: string, username?: string): PasswordCheck {
  const password = raw.normalize('NFC')
  const user = username?.normalize('NFC')
  const length = [...password].length
  const tooShort = length < PASSWORD_MIN_LENGTH
  const tooLong = length > PASSWORD_MAX_LENGTH
  const lower = password.toLowerCase()
  const containsUser = !!user && [...user].length >= 3 && lower.includes(user.toLowerCase())
  const common = COMMON.has(lower)
  const repeated = length > 0 && /^(.)\1+$/su.test(password)
  const bits = tooLong ? 0 : estimateBits(password, user)
  const easy = !tooLong && (common || repeated || bits < PREDICTABLE_BITS)
  const problems: PasswordProblem[] = []
  if (tooShort) problems.push('too_short')
  if (tooLong) problems.push('too_long')
  if (containsUser) problems.push('contains_username')
  if (common) problems.push('too_common')
  if (repeated) problems.push('repeated_char')
  // Long enough, but still among the first guesses: said only when no plainer reason is.
  if (problems.length === 0 && bits < PREDICTABLE_BITS) problems.push('too_predictable')
  const score = problems.length > 0 ? 0 : bits < 45 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4
  return {
    problems,
    strength: { score, level: LEVELS[score]!, bits: Math.round(bits) },
    rules: { length: !tooShort && !tooLong, username: !containsUser, guessable: length > 0 && !easy },
    tooLong,
  }
}

/** The rules the server enforces. */
export function accountPasswordProblems(password: string, username?: string): PasswordProblem[] {
  return accountPasswordCheck(password, username).problems
}

/**
 * Whether the password is among the first guesses — common, one repeated character, or a cheap
 * pattern — whatever its length (the meter's own rule, apart from the length one).
 */
export function isEasyToGuess(password: string, username?: string): boolean {
  return !accountPasswordCheck(password, username).rules.guessable
}

/** How hard the password is to guess; a password a rule refuses is very weak. */
export function accountPasswordStrength(password: string, username?: string): PasswordStrength {
  return accountPasswordCheck(password, username).strength
}

/** The guessing cost in bits alone, for other passwords' meters (a backup's, a database user's). */
export function estimatePasswordBits(password: string): number {
  const p = password.normalize('NFC')
  return [...p].length > PASSWORD_MAX_LENGTH ? 0 : estimateBits(p)
}

function poolOf(p: string): number {
  let pool = 0
  if (/[a-z]/.test(p)) pool += 26
  if (/[A-Z]/.test(p)) pool += 26
  if (/[0-9]/.test(p)) pool += 10
  if (/[^a-zA-Z0-9]/.test(p)) pool += 33
  return Math.max(pool, 1)
}

/** Lower case without accents, one UTF-16 unit for one (so its indexes are the password's). */
const plain = (s: string) =>
  s
    .split('')
    .map((c) => {
      const low = c.toLowerCase()
      return ACCENTS[c] ?? ACCENTS[low] ?? (low.length === 1 ? low : c)
    })
    .join('')
const undo = (s: string, map: Record<string, string>) =>
  s
    .split('')
    .map((c) => (Object.hasOwn(map, c) ? map[c]! : c))
    .join('')

/** The longest run from i whose characters step by the same +1 or -1 (abc, 4321). */
function sequenceAt(s: string, i: number): number {
  if (i + 2 >= s.length) return 0
  const step = s.charCodeAt(i + 1) - s.charCodeAt(i)
  if (step !== 1 && step !== -1) return 0
  let end = i + 1
  while (end + 1 < s.length && s.charCodeAt(end + 1) - s.charCodeAt(end) === step) end++
  return end - i + 1
}

/** Final review I2: two runs woven together (a1b2c3, 1a2b3c) — how many pairs from i. */
function interleavedAt(s: string, i: number): number {
  if (i + 5 >= s.length) return 0
  const a = s.charCodeAt(i + 2) - s.charCodeAt(i)
  const b = s.charCodeAt(i + 3) - s.charCodeAt(i + 1)
  if ((a !== 1 && a !== -1) || (b !== 1 && b !== -1)) return 0
  let pairs = 2
  while (
    i + 2 * pairs + 1 < s.length &&
    s.charCodeAt(i + 2 * pairs) - s.charCodeAt(i + 2 * pairs - 2) === a &&
    s.charCodeAt(i + 2 * pairs + 1) - s.charCodeAt(i + 2 * pairs - 1) === b
  )
    pairs++
  return pairs
}

/** The longest walk from i along a keyboard row, either way. */
function rowAt(s: string, i: number): number {
  let best = 0
  for (const line of LINES)
    for (let start = line.indexOf(s[i]!); start >= 0; start = line.indexOf(s[i]!, start + 1)) {
      let n = 0
      while (i + n < s.length && start + n < line.length && line[start + n] === s[i + n]) n++
      best = Math.max(best, n)
    }
  return best
}

const isPair = (s: string, i: number) =>
  i + 1 < s.length && /[\uD800-\uDBFF]/.test(s[i]!) && /[\uDC00-\uDFFF]/.test(s[i + 1]!)

/** The guessing cost in bits: each step takes the reading of what follows that saves the most. */
function estimateBits(password: string, username?: string, depth = 0): number {
  const lower = plain(password)
  const readings = [undo(lower, LOOK_ALIKE), undo(lower, LOOK_ALIKE_L)]
  const user = username && [...username].length >= 3 ? plain(username) : null
  const charBits = Math.log2(poolOf(password))
  const units = new Map<string, number>()
  let bits = 0
  let i = 0
  while (i < password.length) {
    // One character (an emoji's two UTF-16 units are one).
    let best = { length: isPair(password, i) ? 2 : 1, cost: charBits }
    const saving = (b: { length: number; cost: number }) => b.length * charBits - b.cost
    const consider = (length: number, cost: number) => {
      if (length > 1 && length * charBits - cost > saving(best)) best = { length, cost }
    }
    if (user && lower.startsWith(user, i)) consider(user.length, 1)
    for (let w = 0; w < DICTIONARY.length; w++) {
      const word = DICTIONARY[w]!
      for (const [text, extra] of [
        [word, 0],
        [REVERSED[w]!, 1],
      ] as const)
        if (readings.some((r) => r.startsWith(text, i))) {
          const capitals = /[A-Z]/.test(password.slice(i, i + text.length)) ? 1 : 0
          const lookAlikes = lower.startsWith(text, i) ? 0 : 1
          consider(text.length, WORD_BITS + extra + capitals + lookAlikes)
        }
    }
    if (/^(19|20)\d\d/.test(lower.slice(i, i + 4))) consider(4, 7)
    const run = sequenceAt(lower, i)
    if (run >= 3) consider(run, 4 + Math.log2(run))
    const pairs = interleavedAt(lower, i)
    if (pairs >= 3) consider(2 * pairs, 2 * (4 + Math.log2(pairs)) + 1)
    const walk = rowAt(lower, i)
    if (walk >= 4) consider(walk, 5 + Math.log2(walk))
    // A unit said again and again (abcabc, 1212): the unit once, then how many times.
    if (depth === 0)
      for (let unit = 1; unit <= Math.min(32, (password.length - i) >> 1); unit++) {
        const piece = lower.slice(i, i + unit)
        let times = 1
        while (lower.startsWith(piece, i + unit * times)) times++
        // Only when it could beat what is found already (no estimate of the unit otherwise).
        if (times < 2 || unit * times < 3 || unit * times * charBits <= saving(best)) continue
        let cost = units.get(piece)
        if (cost === undefined)
          units.set(piece, (cost = estimateBits(password.slice(i, i + unit), undefined, 1)))
        consider(unit * times, cost + Math.log2(times))
      }
    bits += best.cost
    i += best.length
  }
  return bits
}
