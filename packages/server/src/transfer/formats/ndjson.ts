import { Errors } from '../../errors'
import { MAX_RECORD_CHARS } from '../limits'

const strip = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line)

/** Spec §5.1: one document per line (LF or CRLF); blank lines are skipped; n is the line number. */
export async function* ndjsonLines(text: AsyncIterable<string>): AsyncGenerator<{ n: number; raw: string }> {
  let line = ''
  let n = 0
  for await (const chunk of text) {
    let from = 0
    for (let i = chunk.indexOf('\n'); i >= 0; i = chunk.indexOf('\n', from)) {
      line += chunk.slice(from, i)
      from = i + 1
      n++
      const raw = strip(line)
      line = ''
      if (raw.length > MAX_RECORD_CHARS)
        throw Errors.badFile(`Line ${n} is longer than 16 MiB`, { reason: 'record_size', record: n })
      if (raw.trim() !== '') yield { n, raw }
    }
    line += chunk.slice(from)
    if (line.length > MAX_RECORD_CHARS)
      throw Errors.badFile(`Line ${n + 1} is longer than 16 MiB`, { reason: 'record_size', record: n + 1 })
  }
  n++
  if (line.trim() !== '') yield { n, raw: strip(line) }
}
