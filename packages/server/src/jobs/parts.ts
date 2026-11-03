import type { JobPart, JobParts } from '@mongo-manager/shared'

/** At most this many parts are listed in a job's view (the running ones always among them). */
export const MAX_PARTS_SHOWN = 200
/** A part's name as shown: a namespace, cut. */
const MAX_NAME = 256

const FINISHED = new Set<JobPart['state']>(['done', 'failed', 'skipped'])

/**
 * W4.3, W4.4: a job's progress per part (a collection of a database copy, a namespace of a dump or
 * restore). Each change is handed to `emit` (the runner coalesces what reaches listeners); the view
 * is bounded — the running parts, then the first others in order.
 *
 * W4 review (minor): kept incrementally — the finished count and the running parts are followed as
 * parts change, and a view walks the parts only until it is full and every running one is in it, not
 * all of them on every update.
 */
export class PartTracker {
  private readonly parts = new Map<string, JobPart>()
  private readonly running = new Set<string>()
  private finished = 0
  private current: string | undefined

  constructor(private readonly emit: (parts: JobParts) => void) {}

  start(names: string[], phase?: string): void {
    this.parts.clear()
    this.running.clear()
    this.finished = 0
    for (const name of names)
      if (!this.parts.has(name)) this.parts.set(name, { name, state: 'waiting', done: 0, total: null })
    this.current = phase
    this.send()
  }

  /** Adds a part found while the job runs (a restore learns its namespaces from the archive). */
  add(name: string): void {
    if (this.parts.has(name) || this.parts.size >= 100_000) return
    this.parts.set(name, { name, state: 'waiting', done: 0, total: null })
    this.send()
  }

  update(name: string, patch: Partial<Omit<JobPart, 'name'>>): void {
    const part = this.parts.get(name)
    if (!part) return
    const was = part.state
    Object.assign(part, patch)
    if (was !== part.state) {
      if (FINISHED.has(was)) this.finished--
      if (FINISHED.has(part.state)) this.finished++
      if (part.state === 'running') this.running.add(name)
      else this.running.delete(name)
    }
    this.send()
  }

  phase(phase: string | undefined): void {
    this.current = phase
    this.send()
  }

  view(): JobParts {
    // The running parts first, then the first others in order; listed in their own order.
    const quota = Math.max(0, MAX_PARTS_SHOWN - this.running.size)
    const items: JobPart[] = []
    let others = 0
    let runningLeft = this.running.size
    for (const p of this.parts.values()) {
      if (items.length >= MAX_PARTS_SHOWN && runningLeft === 0) break
      if (p.state === 'running') {
        runningLeft--
        if (items.length < MAX_PARTS_SHOWN) items.push(p)
      } else if (others < quota) {
        others++
        items.push(p)
      }
      if (others >= quota && runningLeft === 0) break
    }
    return {
      ...(this.current ? { phase: this.current } : {}),
      count: this.parts.size,
      finished: this.finished,
      items: items.map((p) => ({ ...p, name: p.name.slice(0, MAX_NAME) })),
    }
  }

  private send(): void {
    this.emit(this.view())
  }
}
