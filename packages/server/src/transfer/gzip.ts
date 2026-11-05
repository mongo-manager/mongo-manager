// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createGunzip, type Gunzip } from 'node:zlib'
import { Transform, type TransformCallback } from 'node:stream'
import { Errors } from '../errors'
import { INFLATE_RATIO } from './limits'

export const isGzip = (head: Uint8Array): boolean => head[0] === 0x1f && head[1] === 0x8b

const tooMuch = () => Errors.badFile('The file expands too much', { reason: 'inflate' })

/**
 * Spec §7 T4: gunzip that counts what it produces and fails as soon as the output passes `max`.
 * Output follows the reader's pace: the inner gunzip pauses while the outer buffer is full.
 */
class BoundedGunzip extends Transform {
  private readonly gunzip: Gunzip = createGunzip()
  private out = 0

  constructor(private readonly max: number) {
    super()
    this.gunzip.on('data', (data: Buffer) => {
      this.out += data.length
      if (this.out > this.max) {
        this.gunzip.destroy()
        this.destroy(tooMuch())
        return
      }
      if (!this.push(data)) this.gunzip.pause()
    })
    this.gunzip.on('error', () =>
      this.destroy(Errors.badFile('The gzip data is damaged', { reason: 'gzip' })),
    )
  }

  override _read(size: number): void {
    this.gunzip.resume()
    super._read(size)
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    if (this.gunzip.write(chunk)) done()
    else this.gunzip.once('drain', () => done())
  }

  override _flush(done: TransformCallback): void {
    this.gunzip.once('end', () => done())
    this.gunzip.end()
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.gunzip.destroy()
    done(error)
  }
}

/** At most INFLATE_RATIO × the compressed size, and at most `absoluteMax` bytes. */
export function boundedGunzip(compressedSize: number, absoluteMax: number): Transform {
  return new BoundedGunzip(Math.min(absoluteMax, Math.max(compressedSize, 1) * INFLATE_RATIO))
}

/** Passes bytes through, telling `onBytes` how many; an error it throws ends the stream with it. */
export function countBytes(onBytes: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      try {
        onBytes(chunk.length)
      } catch (e) {
        return done(e as Error)
      }
      done(null, chunk)
    },
  })
}
