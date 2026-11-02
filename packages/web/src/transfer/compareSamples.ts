import type { CompareDiffSample, CompareSample } from '@mongo-manager/shared/browser'

export type SampleGroup = 'onlySource' | 'onlyTarget' | 'different' | 'same'
export interface SampleSet {
  coll: string
  samples: { onlySource: CompareSample[]; onlyTarget: CompareSample[]; different: CompareDiffSample[] }
}
export type ShownSample =
  | { coll: string; id: unknown; kind: 'diff'; sample: CompareDiffSample }
  | { coll: string; id: unknown; kind: 'doc'; sample: CompareSample }

/** One group's samples across the collections (W4.6: the compare view and a sync's verification). */
export function samplesOf(sets: SampleSet[], group: SampleGroup): ShownSample[] {
  return sets.flatMap((c): ShownSample[] => {
    if (group === 'same') return []
    if (group === 'different')
      return c.samples.different.map((s) => ({ coll: c.coll, id: s.id, kind: 'diff', sample: s }))
    return c.samples[group].map((s) => ({ coll: c.coll, id: s.id, kind: 'doc', sample: s }))
  })
}
