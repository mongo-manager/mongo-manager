import { expect } from 'vitest'
import { AppError } from '../../src/errors'

/** A small seeded PRNG (mulberry32): the same seed gives the same inputs on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SPECIAL = [0x00, 0x22, 0x5c, 0x7b, 0x7d, 0x5b, 0x5d, 0x2c, 0x0a, 0x0d, 0x3c, 0x3e, 0x26, 0xff, 0xc3]

/** Mutations of a valid input: flipped bytes, cut tails, repeated slices, inserted special bytes, noise. */
export function mutate(base: Buffer, r: () => number): Buffer {
  const b = Buffer.from(base)
  const kind = Math.floor(r() * 5)
  if (kind === 0) {
    for (let i = 0; i < 1 + r() * 8; i++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256)
    return b
  }
  if (kind === 1) return b.subarray(0, Math.floor(r() * b.length))
  if (kind === 2) {
    const at = Math.floor(r() * b.length)
    const len = Math.floor(r() * 64)
    return Buffer.concat([b.subarray(0, at), b.subarray(at, at + len), b.subarray(at)])
  }
  if (kind === 3) {
    const at = Math.floor(r() * b.length)
    const byte = SPECIAL[Math.floor(r() * SPECIAL.length)]!
    return Buffer.concat([b.subarray(0, at), Buffer.from([byte]), b.subarray(at)])
  }
  return Buffer.from(Array.from({ length: Math.floor(r() * 256) }, () => Math.floor(r() * 256)))
}

/**
 * Runs `check` on `runs` mutated inputs (spec §7 fuzzing). Each must end with a value or an AppError
 * within `ms`; any other exception or a hang fails the test, naming the seed and the run.
 */
export async function fuzz(
  seed: number,
  runs: number,
  base: Buffer,
  check: (input: Buffer) => Promise<unknown>,
  ms = 2_000,
): Promise<void> {
  const r = rng(seed)
  for (let i = 0; i < runs; i++) {
    const input = mutate(base, r)
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      check(input).then(
        () => 'ok',
        (e: unknown) => (e instanceof AppError ? 'app-error' : `${(e as Error)?.stack ?? String(e)}`),
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('hang'), ms)
      }),
    ])
    clearTimeout(timer)
    expect({ seed, run: i, outcome }).toEqual({
      seed,
      run: i,
      outcome: expect.stringMatching(/^(ok|app-error)$/),
    })
  }
}
