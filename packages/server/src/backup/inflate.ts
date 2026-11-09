// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { constants, createGunzip, createZstdCompress, createZstdDecompress } from 'node:zlib'
import { Transform, type TransformCallback } from 'node:stream'
import { Errors } from '../errors'
import { INFLATE_RATIO_BACKUP } from './limits'

const tooMuch = () => Errors.badFile('The backup expands too much', { reason: 'inflate' })

/** zstd at level 3: fast, and close to gzip -9 on BSON. */
export const zstdCompress = (): Transform =>
  createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 3 } })

/**
 * Spec §8 B1: gunzip or zstd that counts what it produces and fails as soon as the output passes
 * `INFLATE_RATIO_BACKUP` × the compressed size (when known) or `absoluteMax`. Output follows the
 * reader's pace: the inner stream pauses while the outer buffer is full.
 */
class BoundedInflate extends Transform {
  private out = 0

  constructor(
    private readonly inner: Transform,
    private readonly max: number,
  ) {
    super()
    inner.on('data', (data: Buffer) => {
      this.out += data.length
      if (this.out > this.max) {
        inner.destroy()
        this.destroy(tooMuch())
        return
      }
      if (!this.push(data)) inner.pause()
    })
    inner.on('error', () =>
      this.destroy(Errors.badFile('The compressed data is damaged', { reason: 'compressed' })),
    )
  }

  override _read(size: number): void {
    this.inner.resume()
    super._read(size)
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    if (this.inner.write(chunk)) done()
    else this.inner.once('drain', () => done())
  }

  override _flush(done: TransformCallback): void {
    this.inner.once('end', () => done())
    this.inner.end()
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.inner.destroy()
    done(error)
  }
}

export function boundedInflate(
  kind: 'gzip' | 'zstd',
  compressedSize: number | null,
  absoluteMax: number,
): Transform {
  const byRatio = compressedSize === null ? absoluteMax : Math.max(compressedSize, 1) * INFLATE_RATIO_BACKUP
  return new BoundedInflate(
    kind === 'gzip' ? createGunzip() : createZstdDecompress(),
    Math.min(absoluteMax, byRatio),
  )
}
