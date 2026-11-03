/** Lines decoded before the browser gets a turn (phase 2a spec R2: no Web Worker). */
export const CHUNK = 200

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Reads an NDJSON stream, handing the parsed lines over `chunk` at a time and letting the browser
 * paint between chunks. A line split across network chunks is joined; the last line may lack its
 * newline. A line that is not JSON ends the read with an error.
 */
export async function readNdjson(
  stream: ReadableStream<Uint8Array>,
  onLines: (lines: unknown[]) => void,
  chunk = CHUNK,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let rest = ''
  let batch: unknown[] = []
  const flush = async () => {
    // A stopped read hands nothing more over (final review 2a, I6).
    if (!batch.length || signal?.aborted) return
    onLines(batch)
    batch = []
    await yieldToBrowser()
  }
  const take = async (text: string) => {
    if (!text.trim()) return
    batch.push(JSON.parse(text))
    if (batch.length >= chunk) await flush()
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || signal?.aborted) break
      rest += decoder.decode(value, { stream: true })
      let at: number
      while ((at = rest.indexOf('\n')) !== -1) {
        const text = rest.slice(0, at)
        rest = rest.slice(at + 1)
        await take(text)
      }
      // What arrived is shown now, not when 200 lines have gathered (spec §4.6: the first rows at once).
      await flush()
    }
    rest += decoder.decode()
    await take(rest)
    await flush()
  } finally {
    reader.releaseLock()
  }
}
