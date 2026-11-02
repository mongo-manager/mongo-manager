/**
 * Security review 2026-10-13 (L2): sessions that proved a second factor lately — at a two-factor
 * sign-in, on adding a factor, or by stepping up. Managing second factors takes one. In memory: a
 * restart asks for it again.
 */
export const STEP_UP_MS = 10 * 60_000

export class StepUps {
  private readonly at = new Map<string, number>()

  constructor(
    private readonly now: () => number,
    private readonly max = 10_000,
  ) {}

  /** The session (by its id's hash) proved a second factor now. */
  mark(sessionIdHash: string): void {
    this.at.delete(sessionIdHash)
    this.at.set(sessionIdHash, this.now())
    if (this.at.size > this.max) this.at.delete(this.at.keys().next().value!)
  }

  fresh(sessionIdHash: string): boolean {
    const when = this.at.get(sessionIdHash)
    return when !== undefined && this.now() - when < STEP_UP_MS
  }
}
