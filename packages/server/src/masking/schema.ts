import type { FieldStats, SchemaAnalysis } from '@mongo-manager/shared'
import type { NsMasker } from './match'

const segments = (f: FieldStats) => f.keys.filter((k): k is string => k !== null)

/** Phase 3c §4.4: personal paths keep only their count; nothing below them is listed. */
export function maskAnalysis(analysis: SchemaAnalysis, output: NsMasker): SchemaAnalysis {
  if (!output.any) return analysis
  const personal = (f: FieldStats) => output.matches(segments(f))
  // A field above it is personal (matches answers for the fields above: review 2026-10-13, I1).
  const below = (f: FieldStats) => {
    const s = segments(f)
    return s.length > 1 && output.matches(s.slice(0, -1))
  }
  return {
    ...analysis,
    fields: analysis.fields
      .filter((f) => !below(f))
      .map((f) =>
        personal(f)
          ? { path: f.path, keys: f.keys, count: f.count, types: {}, masked: true }
          : f.geo && output.under(segments(f))
            ? withoutGeo(f)
            : f,
      ),
  }
}

/**
 * W2 (2026-10-16): a field's places come from what is below it (a GeoJSON value's coordinates, a
 * pair's latitude): with anything personal there, it has none to show. The documents were masked
 * before the analysis already; this holds even if a masked value still read as a place.
 */
function withoutGeo(f: FieldStats): FieldStats {
  const { geo: _geo, ...rest } = f
  return rest
}
