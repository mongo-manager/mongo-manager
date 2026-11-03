import { describe, expect, it } from 'vitest'
import {
  FavouriteQuerySchema,
  FavouriteUpdateSchema,
  LibraryQuerySchema,
  SavedPipelineUpdateSchema,
  TagsSchema,
  checkTag,
} from '../src'

describe('tags (phase 2c, final review Minor 7 and I3)', () => {
  it('drops a leading #, trims, lower-cases and removes duplicates before counting', () => {
    expect(TagsSchema.parse(['#Sales', ' sales ', '##q3'])).toEqual(['sales', 'q3'])
    const eleven = [...Array.from({ length: 10 }, (_, i) => `t${i}`), 'T0']
    expect(TagsSchema.parse(eleven)).toHaveLength(10)
    expect(TagsSchema.safeParse(Array.from({ length: 11 }, (_, i) => `t${i}`)).success).toBe(false)
  })

  it('says what is wrong with a tag', () => {
    const message = (tags: string[]) => {
      const r = TagsSchema.safeParse(tags)
      return r.success ? '' : r.error.issues[0]!.message
    }
    expect(message(['  '])).toBe('A tag cannot be empty')
    expect(message(['#'])).toBe('A tag cannot be empty')
    expect(message(['x'.repeat(31)])).toBe('A tag has 30 characters at most')
    expect(message(['satış'])).toBe('A tag uses a-z, 0-9, _ and - only')
    expect(message(['has space'])).toBe('A tag uses a-z, 0-9, _ and - only')
  })

  it('checks one tag as the server does, for the web form', () => {
    expect(checkTag('#Hot')).toEqual({ tag: 'hot' })
    expect(checkTag('é')).toEqual({ error: 'chars' })
    expect(checkTag('   ')).toEqual({ error: 'empty' })
    expect(checkTag('x'.repeat(31))).toEqual({ error: 'long' })
  })

  it('takes library tags as one comma list or as repeated parameters', () => {
    expect(LibraryQuerySchema.parse({ tags: '#A, b' }).tags).toEqual(['a', 'b'])
    expect(LibraryQuerySchema.parse({ tags: ['a', 'B'] }).tags).toEqual(['a', 'b'])
  })
})

describe('updates keep the tags they do not name (final review Minor 6)', () => {
  it('leaves tags undefined when a PUT has none', () => {
    expect(FavouriteUpdateSchema.parse({ name: 'n', query: { filter: {} } }).tags).toBeUndefined()
    expect(SavedPipelineUpdateSchema.parse({ name: 'n', stages: [] }).tags).toBeUndefined()
    expect(SavedPipelineUpdateSchema.parse({ name: 'n', stages: [], tags: ['#x'] }).tags).toEqual(['x'])
  })
})

describe('favourites keep the query, not the page size (final review Minor 20)', () => {
  it('has no limit', () => {
    expect(FavouriteQuerySchema.parse({ filter: {}, limit: 5 })).toEqual({ filter: {} })
  })
})
