// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { h, type FunctionalComponent } from 'vue'
import type { Spans } from '../lineDiff'

const SIGN = { same: ' ', del: '−', add: '+' } as const
export type LineTone = keyof typeof SIGN
const SIGN_TONE = { same: 'text-fg-subtle', del: 'text-danger', add: 'text-success' } as const
const MARK = { same: '', del: 'bg-danger/25', add: 'bg-success/25' } as const

/** One side of a diff line: its sign (not only its colour tells), its text, the changed part marked. */
export const DiffLine: FunctionalComponent<{ spans: Spans; tone: LineTone }> = ({
  spans: [lead, changed, tail],
  tone,
}) => [
  h(
    'span',
    { class: ['mr-2 inline-block w-2 select-none', SIGN_TONE[tone]], 'aria-hidden': 'true' },
    SIGN[tone],
  ),
  lead,
  changed ? h('mark', { class: ['rounded-sm text-inherit', MARK[tone]] }, changed) : null,
  tail,
]
DiffLine.props = ['spans', 'tone']
