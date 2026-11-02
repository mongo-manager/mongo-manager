import { describe, expect, it } from 'vitest'
import { fromText, newCard, toPipeline, toText, type Card } from '../src/aggregation/stages'

const card = (operator: string, text: string, over: Partial<Card> = {}): Card => ({
  ...newCard(operator),
  text,
  ...over,
})

describe('toPipeline (phase 2a spec §4.1)', () => {
  it('sends the enabled cards as canonical EJSON, and maps each sent stage back to its card', () => {
    const cards = [
      card('$match', '{ a: 1 }'),
      card('$sort', '{ a: -1 }', { enabled: false }),
      card('$limit', '5'),
    ]
    const built = toPipeline(cards)
    expect(built.error).toBeNull()
    expect(built.stages).toEqual([{ $match: { a: { $numberInt: '1' } } }, { $limit: { $numberInt: '5' } }])
    // A disabled card in the middle: the third card is the second stage sent (Review Focus 1).
    expect(built.map).toEqual([cards[0]!.id, cards[2]!.id])
  })

  it('stops at the first card that does not parse, with its position', () => {
    const cards = [card('$match', '{ a: 1 }'), card('$project', '{ a: }'), card('$limit', '5')]
    const built = toPipeline(cards)
    expect(built.stages).toHaveLength(1)
    expect(built.map).toEqual([cards[0]!.id])
    expect(built.error).toMatchObject({ cardId: cards[1]!.id, line: 1, column: expect.any(Number) })
  })

  it('refuses an empty stage rather than sending it', () => {
    const cards = [card('$match', '   ')]
    expect(toPipeline(cards).error).toMatchObject({ cardId: cards[0]!.id })
  })
})

describe('text mode (phase 2a spec §4.3)', () => {
  it('turns empty text into no stages (Review Focus 4)', () => {
    expect(fromText('', [])).toEqual({ cards: [] })
    expect(fromText('  \n', [])).toEqual({ cards: [] })
  })

  it('round-trips the enabled cards through the text', () => {
    const cards = [
      card('$match', '{ a: 1 }'),
      card('$sort', '{ a: -1 }', { enabled: false }),
      card('$limit', '5'),
    ]
    const text = toText(cards)
    expect(text).toEqual({ text: expect.stringContaining('$match') })
    expect((text as { text: string }).text).not.toContain('$sort')
    const back = fromText((text as { text: string }).text, [])
    expect('cards' in back && back.cards.map((c) => [c.operator, c.text.replace(/\s+/g, ' ')])).toEqual([
      ['$match', '{ a: 1 }'],
      ['$limit', '5'],
    ])
  })

  it('keeps enabled and collapsed for a card with the same operator at the same place', () => {
    const before = [card('$match', '{}', { collapsed: true }), card('$limit', '1')]
    const result = fromText('[{ $match: { b: 2 } }, { $skip: 3 }]', before)
    expect('cards' in result && result.cards.map((c) => [c.operator, c.collapsed])).toEqual([
      ['$match', true],
      ['$skip', false],
    ])
  })

  it('reports text that is not a pipeline, or a stage that is not one operator', () => {
    expect(fromText('{ a: 1 }', [])).toMatchObject({ error: { message: expect.any(String) } })
    expect(fromText('[{ $match: {}, $limit: 1 }]', [])).toMatchObject({
      error: { message: expect.any(String) },
    })
    expect(fromText('[{ $match: ', [])).toMatchObject({ error: { line: 1 } })
  })

  it('cannot write text for cards that do not parse', () => {
    expect(toText([card('$match', '{ a: ')])).toMatchObject({ error: { message: expect.any(String) } })
  })
})

describe('text mode keeps disabled stages (final review 2a, I2)', () => {
  it('puts disabled cards back among the stages the text gives, matched against enabled cards only', () => {
    const before = [
      card('$match', '{ a: 1 }', { collapsed: true }),
      card('$sort', '{ a: -1 }', { enabled: false }),
      card('$limit', '5'),
    ]
    const result = fromText('[{ $match: { b: 2 } }, { $skip: 3 }]', before)
    expect('cards' in result && result.cards.map((c) => [c.operator, c.enabled, c.collapsed])).toEqual([
      ['$match', true, true],
      ['$sort', false, false],
      ['$skip', true, false],
    ])
    expect('cards' in result && result.cards[0]!.id).toBe(before[0]!.id)
    expect('cards' in result && result.cards[1]!.id).toBe(before[1]!.id)
  })

  it('keeps disabled cards at the end when the text has fewer stages', () => {
    const before = [card('$match', '{}'), card('$limit', '1'), card('$sort', '{ a: 1 }', { enabled: false })]
    const result = fromText('[{ $match: {} }]', before)
    expect('cards' in result && result.cards.map((c) => c.operator)).toEqual(['$match', '$sort'])
  })
})
