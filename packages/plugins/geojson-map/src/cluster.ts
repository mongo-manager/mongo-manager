import { project, unproject, worldSize, wrapLng, type LngLat } from './projection'

/** Places drawn as one circle: where it stands, and which places (by index) it holds. */
export interface Cluster extends LngLat {
  members: number[]
}

/**
 * Map redesign (spec §2.5): places closer than `radius` pixels at this zoom become one circle. A
 * place joins the nearest circle whose first place is within the radius — looked up in a grid of
 * radius-sized cells, so tens of thousands of places take milliseconds; the grid wraps at the
 * antimeridian like the world does. The circle stands at the middle of its places.
 */
export function cluster(points: LngLat[], zoom: number, radius = 28): Cluster[] {
  const world = worldSize(zoom)
  // Cells at least `radius` wide, a whole number of them around the world.
  const columns = Math.max(1, Math.floor(world / radius))
  const cell = world / columns
  const seeds: Array<{ x: number; y: number; sumX: number; sumY: number; members: number[] }> = []
  const grid = new Map<number, number[]>()
  const key = (cx: number, cy: number) => cy * columns + cx
  const r2 = radius * radius
  points.forEach((point, index) => {
    const p = project(point, zoom)
    const x = ((p.x % world) + world) % world
    const cx = Math.min(columns - 1, Math.floor(x / cell))
    const cy = Math.floor(p.y / cell)
    let best = -1
    let bestDistance = Infinity
    let bestDx = 0
    for (const dcx of new Set([-1, 0, 1].map((d) => (((cx + d) % columns) + columns) % columns)))
      for (let dcy = cy - 1; dcy <= cy + 1; dcy++)
        for (const s of grid.get(key(dcx, dcy)) ?? []) {
          let dx = x - seeds[s]!.x
          // The short way round the world.
          if (dx > world / 2) dx -= world
          else if (dx < -world / 2) dx += world
          const dy = p.y - seeds[s]!.y
          const d = dx * dx + dy * dy
          if (d <= r2 && d < bestDistance) {
            best = s
            bestDistance = d
            bestDx = dx
          }
        }
    if (best >= 0) {
      const seed = seeds[best]!
      seed.sumX += seed.x + bestDx
      seed.sumY += p.y
      seed.members.push(index)
      return
    }
    const k = key(cx, cy)
    const inCell = grid.get(k)
    if (inCell) inCell.push(seeds.length)
    else grid.set(k, [seeds.length])
    seeds.push({ x, y: p.y, sumX: x, sumY: p.y, members: [index] })
  })
  return seeds.map((s) => {
    const n = s.members.length
    const at = unproject({ x: s.sumX / n, y: s.sumY / n }, zoom)
    return { lng: wrapLng(at.lng), lat: at.lat, members: s.members }
  })
}
