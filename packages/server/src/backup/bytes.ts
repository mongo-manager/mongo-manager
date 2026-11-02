/**
 * Reads exact byte counts from a chunked stream, whatever the chunk boundaries (the reader of every
 * backup format sits on it).
 */
export class ByteReader {
  private readonly it: AsyncIterator<Buffer>
  private parts: Buffer[] = []
  private have = 0
  private done = false
  /** Bytes consumed so far. */
  position = 0

  constructor(src: AsyncIterable<Buffer>) {
    this.it = src[Symbol.asyncIterator]()
  }

  private async fill(n: number): Promise<void> {
    while (this.have < n && !this.done) {
      const next = await this.it.next()
      if (next.done) this.done = true
      else if (next.value.length) {
        this.parts.push(next.value)
        this.have += next.value.length
      }
    }
  }

  /** n bytes, or null when the stream ended before any of them; a partial read throws. */
  async exactly(n: number, onShort: () => Error): Promise<Buffer | null> {
    await this.fill(n)
    if (this.have === 0 && n > 0) return null
    if (this.have < n) throw onShort()
    const all = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts)
    const out = all.subarray(0, n)
    const rest = all.subarray(n)
    this.parts = rest.length ? [rest] : []
    this.have = rest.length
    this.position += n
    return out
  }

  async atEnd(): Promise<boolean> {
    await this.fill(1)
    return this.have === 0
  }

  async close(): Promise<void> {
    await this.it.return?.()
  }
}
