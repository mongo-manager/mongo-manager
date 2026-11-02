/**
 * Plugins wave 2 (charts): the geometry of a chart — round ticks, linear scales, line and donut
 * paths — as pure functions; the page draws them as SVG.
 */

/** A number short enough for a path, without float noise. */
const n = (v: number) => String(Math.round(v * 100) / 100)

/** Round steps over [min, max], about `count` of them, covering both ends. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (max < min) [min, max] = [max, min]
  // One value: a range around it that doubles can tell apart (review I2).
  if (max === min) max = min + Math.max(1, Math.abs(min) * 1e-9)
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  if (!Number.isFinite(step) || step <= 0) return [min, max]
  const decimals = Math.max(0, Math.min(20, -Math.floor(Math.log10(step))))
  const round = (v: number) => Number(v.toFixed(decimals))
  const ticks: number[] = []
  const last = Math.ceil(max / step) * step
  // At most 50, and never a step that adds nothing (beyond 2^53 a double may not move).
  for (let t = Math.floor(min / step) * step, i = 0; t <= last + step / 2 && i < 50; t += step, i++) {
    const tick = round(t)
    if (ticks.length && tick <= ticks.at(-1)!) break
    ticks.push(tick)
    if (t + step === t) break
  }
  if (ticks.length < 2 || ticks[0]! > min || ticks.at(-1)! < max) return [min, max]
  return ticks
}

/** Maps a domain onto a range (a flat domain onto the range's start). */
export function scaleLinear(domain: [number, number], range: [number, number]): (v: number) => number {
  const [d0, d1] = domain
  const [r0, r1] = range
  if (d1 === d0) return () => r0
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0)
}

export function linePath(points: Array<[number, number]>): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`).join('')
}

/** A point on a circle; angles from twelve o'clock, clockwise. */
const at = (cx: number, cy: number, r: number, a: number): [number, number] => [
  cx + r * Math.sin(a),
  cy - r * Math.cos(a),
]

/** A donut segment from angle a0 to a1 (a whole circle drawn as two halves). */
export function arcPath(cx: number, cy: number, r: number, inner: number, a0: number, a1: number): string {
  if (a1 - a0 >= 2 * Math.PI - 1e-9) {
    const mid = a0 + Math.PI
    return arcPath(cx, cy, r, inner, a0, mid) + arcPath(cx, cy, r, inner, mid, a0 + 2 * Math.PI)
  }
  const large = a1 - a0 > Math.PI ? 1 : 0
  const [x0, y0] = at(cx, cy, r, a0)
  const [x1, y1] = at(cx, cy, r, a1)
  const [x2, y2] = at(cx, cy, inner, a1)
  const [x3, y3] = at(cx, cy, inner, a0)
  return (
    `M${n(x0)} ${n(y0)}A${n(r)} ${n(r)} 0 ${large} 1 ${n(x1)} ${n(y1)}` +
    `L${n(x2)} ${n(y2)}A${n(inner)} ${n(inner)} 0 ${large} 0 ${n(x3)} ${n(y3)}Z`
  )
}
