// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { PluginClient } from '../../kit/src/client'
import { MESSAGES, sqlMessage, type SqlCode } from '../src/messages'
import { translate, SqlError } from '../src/translate'
import { LANGUAGES, pick, shown } from '../../kit/src/i18n'
import { formatNumber } from '../../kit/src/ui'
import { TEXT, mount } from '../src/view'

const NEW = ['zh', 'ja', 'es', 'pt', 'ko', 'de', 'fr', 'ru'] as const
const flush = () => new Promise((r) => setTimeout(r, 0))

/** The keys of a text block: functions by name, objects deeply. */
function shape(value: unknown): unknown {
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shape(v)]),
    )
  }
  return typeof value
}

async function opened(locale: string) {
  document.body.innerHTML = '<div id="app"></div>'
  document.documentElement.lang = ''
  let ready: (() => void) | null = null
  const client: PluginClient = {
    contribution: { kind: 'collectionTab', id: 'sql' },
    ask: async <T>(method: string) => {
      if (method === 'context.get')
        return {
          plugin: { id: 'sql-to-mongodb', version: '1' },
          contribution: { kind: 'collectionTab', id: 'sql' },
          locale,
          theme: 'light',
          accent: 'violet',
          place: { connectionId: 'c', connectionName: 'Shop', db: 'shop', coll: 'users', documentId: null },
          settings: {},
        } as T
      return { documents: [], hasMore: false } as T
    },
    onReady: (fn) => (ready = fn),
    onContext: () => {},
    onCells: () => {},
  }
  mount(document.getElementById('app')!, client)
  ready!()
  for (let i = 0; i < 4; i++) await flush()
}

describe('languages', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('has every language block with the same keys as English', () => {
    for (const lang of NEW) {
      expect(TEXT[lang], lang).toBeDefined()
      expect(shape(TEXT[lang]), lang).toEqual(shape(TEXT.en))
    }
    for (const lang of NEW) {
      expect(Object.keys(MESSAGES[lang]!).sort(), lang).toEqual(Object.keys(MESSAGES.en).sort())
    }
  })

  it.each([
    ['zh', '运行', 'zh-CN'],
    ['ja', '実行', 'ja'],
    ['es', 'Ejecutar', 'es'],
    ['pt', 'Executar', 'pt-BR'],
    ['ko', '실행', 'ko'],
    ['de', 'Ausführen', 'de'],
    ['fr', 'Exécuter', 'fr'],
    ['ru', 'Выполнить', 'ru'],
  ])('shows the tab in %s', async (locale, run, tag) => {
    await opened(locale)
    expect(document.getElementById('run')!.textContent).toContain(run)
    expect(document.documentElement.lang).toBe(tag)
  })

  it('falls back to English for an unknown locale', async () => {
    await opened('xx')
    expect(document.getElementById('run')!.textContent).toContain('Run')
    expect(document.documentElement.lang).toBe('en')
    expect(sqlMessage({ code: 'expected_value', values: {} }, 'xx')).toBe('A value is expected here')
  })

  it('lists every language, with no gaps', () => {
    for (const lang of LANGUAGES) {
      expect(TEXT[lang], lang).toBeDefined()
      expect(MESSAGES[lang], lang).toBeDefined()
    }
  })

  it('writes counts in the right plural form', () => {
    const rows = (lang: 'en' | 'de' | 'fr' | 'ru' | 'es' | 'pt', n: number) =>
      TEXT[lang].rows(n, String(n), false)
    expect(rows('en', 1)).toBe('1 row')
    expect(rows('en', 0)).toBe('0 rows')
    expect(rows('de', 1)).toBe('1 Zeile')
    expect(rows('de', 3)).toBe('3 Zeilen')
    expect(rows('fr', 0)).toBe('0 ligne')
    expect(rows('fr', 1)).toBe('1 ligne')
    expect(rows('fr', 2)).toBe('2 lignes')
    expect(rows('es', 1)).toBe('1 fila')
    expect(rows('pt', 2)).toBe('2 linhas')
    const ru: [number, string][] = [
      [0, 'строк'],
      [1, 'строка'],
      [2, 'строки'],
      [5, 'строк'],
      [11, 'строк'],
      [21, 'строка'],
      [22, 'строки'],
    ]
    for (const [n, word] of ru) expect(rows('ru', n), String(n)).toBe(`${n} ${word}`)
    expect(TEXT.de.moreColumns(1)).toContain('+1 weitere Spalte ')
    expect(TEXT.de.moreColumns(2)).toContain('Spalten')
    expect(TEXT.fr.moreColumns(0)).toContain('colonne de plus non affichée')
    expect(TEXT.fr.moreColumns(1)).toContain('colonne de plus non affichée')
    expect(TEXT.fr.moreColumns(2)).toContain('colonnes de plus non affichées')
    expect(TEXT.ru.moreColumns(1)).toBe('+1 столбец не показан')
    expect(TEXT.ru.moreColumns(2)).toBe('+2 столбца не показаны')
    expect(TEXT.ru.moreColumns(5)).toBe('+5 столбцов не показано')
    expect(TEXT.ru.moreColumns(12)).toBe('+12 столбцов не показано')
    expect(TEXT.ru.moreColumns(21)).toBe('+21 столбец не показан')
    expect(TEXT.ru.moreColumns(22)).toBe('+22 столбца не показаны')
  })

  it('falls back to English text and numbers for a language a table lacks', () => {
    const partial = { en: TEXT.en, tr: TEXT.tr }
    expect(shown(partial, 'ko')).toBe('en')
    expect(pick<typeof TEXT.en>(partial, 'ko').run).toBe('Run')
    expect(formatNumber(12345, shown(partial, 'ko'))).toBe('12,345')
  })

  it('writes the Russian text with е, never ё', () => {
    const flat = JSON.stringify(TEXT.ru, (_k, v) => (typeof v === 'function' ? String(v) : v))
    expect(flat).not.toContain('ё')
    expect(Object.values(MESSAGES.ru!).join(' ')).not.toContain('ё')
  })

  it('words a refusal in each language, keeping what it names', () => {
    let error: SqlError | undefined
    try {
      translate('SELECT * FROM a RIGHT JOIN b ON a.x = b.y')
    } catch (e) {
      error = e as SqlError
    }
    expect(error).toBeInstanceOf(SqlError)
    const failure = error as unknown as { code: SqlCode; values: Record<string, string> }
    for (const lang of NEW) {
      const text = sqlMessage(failure, lang)
      expect(text, lang).toContain('RIGHT JOIN')
      expect(text, lang).not.toBe(sqlMessage(failure, 'en'))
    }
  })
})
