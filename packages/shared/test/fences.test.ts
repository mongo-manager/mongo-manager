import { describe, expect, it } from 'vitest'
import { FENCE, fencedBlocks } from '../src/index'

describe('fenced blocks (phase 4a-2 plan ruling 6)', () => {
  it('finds every fenced block with its language, in order', () => {
    const text = 'Try:\n```json\n{ "a": 1 }\n```\nor\n```\n[1]\n```\nand\n```python\nx = 1\n```'
    expect(fencedBlocks(text)).toEqual([
      { lang: 'json', text: '{ "a": 1 }' },
      { lang: '', text: '[1]' },
      { lang: 'python', text: 'x = 1' },
    ])
  })

  it('reads an unclosed fence to the end, CRLF lines, capitals and an indented fence as the web does', () => {
    expect(fencedBlocks('a\r\n  ```JSON\r\n{ "b": 2 }\r\n')).toEqual([{ lang: 'JSON', text: '{ "b": 2 }\n' }])
    expect(fencedBlocks('```js\n1\n```js\n2\n```')).toEqual([
      { lang: 'js', text: '1' },
      { lang: '', text: '' },
    ])
    expect(FENCE.test('   ```mongodb  ')).toBe(true)
    expect(FENCE.test('```json extra')).toBe(false)
  })
})
