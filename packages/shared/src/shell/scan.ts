// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * Where shell code stands after some text — what mongosh's own reader asks before it runs a line: is
 * something left open (a bracket, a string, a template and its `${…}`, a block comment), or can the
 * code not end here (after `.`, `,`, an operator, `=>`, an operator word such as `typeof`, a control
 * header such as `if (…)` or `function f()`, or `else`, `do`, `try`, `class A`)?
 * Review 2026-10-12 (I2): a regex with `//` or a quote in it, or a template with a backtick inside
 * `${}`, was taken for open, and Enter only ever started a new line; `db.orders.` was run, an error.
 *
 * It reads text fed in parts as one text, in one pass: the shell asks after every line of a script of
 * thousands (review 2026-10-12, I3: the cut was quadratic). Parts are whole lines: a two-character
 * token (`//`, `${`) is never split across them.
 */

/** After one of these (or at the start), a `/` opens a regular expression rather than dividing. */
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''))
/** Words after which a `/` opens a regular expression too (`return /x/`). */
const REGEX_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
])
/** Words whose `(…)` is a header: a statement must follow it. */
const HEADERS = new Set(['if', 'for', 'while', 'with', 'switch', 'catch'])
/** Words after which something must follow: a statement, a block, an operand. */
const LEADING = new Set([
  'else',
  'do',
  'try',
  'finally',
  'typeof',
  'instanceof',
  'in',
  'new',
  'delete',
  'void',
  'await',
  'yield',
  'function',
  'class',
])
/** The last characters after which an expression cannot end. */
const OPERATOR = new Set('.,=+-*/%&|^!?:<>~'.split(''))
/** A character of a word: ASCII letters, digits, `_`, `$`, and any other that is no space. */
const SPACE = /\s/
const isWordChar = (ch: string) => /[\w$]/.test(ch) || (ch > '\x7f' && !SPACE.test(ch))

type Open = '(' | '[' | '{' | 'header' | '${'

export class CodeScanner {
  /** The brackets open, innermost last; `${` for a template's hole, `header` for an `if (`. */
  private stack: Open[] = []
  private quote: '"' | "'" | '`' | null = null
  /** Inside a string or a regular expression, the character after a backslash is taken as it is. */
  private escape = false
  private regex = false
  private regexClass = false
  private lineComment = false
  private blockComment = false
  /** The last significant character outside literals and comments ('x' for a value). */
  private last = ''
  /** The one before it, to tell `i++` from `a +`. */
  private before = ''
  /** The word being read, and the last whole one (when nothing significant has followed it). */
  private word = ''
  private lastWord = ''
  /** The word being read came after a dot: a property's name, never a keyword (`x.do`, `stats.in`). */
  private property = false
  /** A header's `)` was the last thing read: its statement is still to come. */
  private header = false
  /** The next `(` opens a header: after `if`, `for`, `while` … and after `function` and its name. */
  private pendingHeader = false
  /** After `function`: its name may come before the `(` of its head. */
  private functionHead = false
  /** After `class`, until its `{`: its name and what it extends. */
  private classHead = false
  /** The `do` statements whose `while` has not come yet: that `while` heads nothing. */
  private pendingDo = 0
  /** The next character is part of a two-character token already read (`/*`, `*\/`, `${`). */
  private skip = false

  feed(text: string): this {
    for (let i = 0; i < text.length; i++) this.step(text[i]!, text[i + 1])
    return this
  }

  /** Nothing left open: no bracket, string, template, regex or comment. */
  get topLevel(): boolean {
    return (
      this.stack.length === 0 && this.quote === null && !this.regex && !this.blockComment && !this.lineComment
    )
  }

  /** Whether the code may go on: something is open, or it cannot end where it stops. */
  get incomplete(): boolean {
    if (this.stack.length > 0 || this.quote !== null || this.blockComment) return true
    if (this.header || this.classHead) return true
    if (this.word) return !this.property && LEADING.has(this.word)
    if (LEADING.has(this.lastWord)) return true
    if (!OPERATOR.has(this.last)) return false
    // `i++` and `i--` end a statement; a lone `+` does not.
    return !((this.last === '+' || this.last === '-') && this.before === this.last)
  }

  private significant(ch: string): void {
    this.before = this.last
    this.last = ch
    this.header = false
    this.lastWord = ''
    // A head goes on through `*` (a generator) and, for a class, the dots of what it extends.
    if (ch !== '*') this.functionHead = false
    if (ch !== '.' && ch !== '{') this.classHead = false
  }

  /** A word ends: a keyword decides what a following `/` or `(` means. */
  private endWord(): void {
    if (!this.word) return
    const word = this.word
    this.word = ''
    this.before = this.last
    if (this.property) {
      this.last = 'x'
      this.lastWord = ''
      this.pendingHeader = false
      return
    }
    // `while` closing a `do` heads nothing.
    const closesDo = word === 'while' && this.pendingDo > 0
    if (closesDo) this.pendingDo--
    if (word === 'do') this.pendingDo++
    // A function's name comes between `function` and its `(`: the head goes on through it.
    this.pendingHeader = (HEADERS.has(word) && !closesDo) || this.functionHead || word === 'function'
    this.functionHead = word === 'function'
    if (word === 'class') this.classHead = true
    this.last = REGEX_WORDS.has(word) ? '(' : 'x'
    this.header = false
    this.lastWord = word
  }

  private step(ch: string, next: string | undefined): void {
    if (this.skip) {
      this.skip = false
      return
    }
    if (this.lineComment) {
      if (ch === '\n') this.lineComment = false
      return
    }
    if (this.blockComment) {
      if (ch === '*' && next === '/') {
        this.blockComment = false
        this.skip = true
      }
      return
    }
    if (this.quote !== null) {
      if (this.escape) {
        this.escape = false
        return
      }
      if (ch === '\\') this.escape = true
      else if (this.quote === '`' && ch === '$' && next === '{') {
        this.stack.push('${')
        this.quote = null
        this.skip = true // the `{`
        this.significant('{')
      } else if (ch === this.quote) {
        this.quote = null
        this.significant('x')
      } else if (ch === '\n' && this.quote !== '`') {
        // A string a newline ended is ended: the shell then says what is wrong.
        this.quote = null
        this.significant('x')
      }
      return
    }
    if (this.regex) {
      if (this.escape) {
        this.escape = false
        return
      }
      if (ch === '\\') this.escape = true
      else if (ch === '[') this.regexClass = true
      else if (ch === ']') this.regexClass = false
      else if ((ch === '/' && !this.regexClass) || ch === '\n') {
        this.regex = false
        this.significant('x')
      }
      return
    }
    // A number's dot is part of it (`5.` and `1.5` are numbers, not a member access).
    if (ch === '.' && /^\d+$/.test(this.word)) {
      this.word += ch
      return
    }
    if (isWordChar(ch)) {
      // A new word is something read: a header's statement has begun, the word before is past.
      if (!this.word) {
        this.header = false
        this.property = this.last === '.'
        if (this.lastWord !== 'function' && this.lastWord !== 'class') this.lastWord = ''
      }
      this.word += ch
      return
    }
    this.endWord()
    if (ch === '/' && next === '/') {
      this.lineComment = true
      return
    }
    if (ch === '/' && next === '*') {
      this.blockComment = true
      this.skip = true
      return
    }
    if (SPACE.test(ch)) return
    if (ch === '/' && (REGEX_AFTER.has(this.last) || this.last === '')) {
      this.regex = true
      this.regexClass = false
      return
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      this.quote = ch
      return
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      this.stack.push(ch === '(' && this.pendingHeader ? 'header' : ch)
      this.pendingHeader = false
      this.significant(ch)
      if (ch === '{') this.classHead = false
      return
    }
    this.pendingHeader = false
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = this.stack.pop()
      if (open === '${') {
        // The hole closes: back inside its template.
        this.quote = '`'
        return
      }
      // After a header's `)` a statement begins: a `/` there opens a regular expression.
      this.significant(open === 'header' ? '(' : ch === '}' ? '}' : 'x')
      if (open === 'header') this.header = true
      return
    }
    this.significant(ch)
  }
}

/** mongosh's direct shell commands (shell-api's @directShellCommand). */
const SHELL_COMMANDS = new Set(['use', 'show', 'it', 'exit', 'quit', 'cls'])

/**
 * The shell command a line is, as mongosh reads one — its first word one of them, the next not opening
 * with `(` (shell-evaluator's own rule: `use ('x')` is a call) — or null.
 */
export function shellCommand(line: string): string | null {
  const words = line.trim().replace(/;$/, '').split(/\s+/)
  const first = words[0] ?? ''
  return SHELL_COMMANDS.has(first) && !(words[1] ?? '').startsWith('(') ? first : null
}

/** Whether the code may go on (mongosh's "..."): something is open, or it cannot end here. */
export function isIncomplete(code: string): boolean {
  return new CodeScanner().feed(code).incomplete
}
