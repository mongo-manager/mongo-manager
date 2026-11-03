import type { TokenType } from './tokenize'

/** Colours only: font style and weight stay constant so the mirror lines up with the textarea. */
export const TOKEN_CLASSES: Record<TokenType, string> = {
  string: 'text-v-string',
  number: 'text-v-number',
  key: 'text-v-key',
  operator: 'text-v-boolean',
  constructor: 'text-v-date',
  keyword: 'text-accent-fg',
  comment: 'text-fg-subtle',
  punct: 'text-fg-subtle',
  text: 'text-fg',
}
