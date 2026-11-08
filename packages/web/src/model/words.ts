// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { ModelReference } from '@mongo-manager/shared/browser'

type T = (key: string, values?: Record<string, unknown>) => string

/** How a reference was found, in words: "by name, by values (3 of 3 found)". */
export const referenceWords =
  (t: T) =>
  (r: ModelReference): string =>
    r.sources
      .map((s) =>
        s === 'values' && r.overlap
          ? t('model.sources.valuesFound', { found: r.overlap.found, checked: r.overlap.checked })
          : t(`model.sources.${s}`),
      )
      .join(', ')
