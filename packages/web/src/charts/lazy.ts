// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { defineAsyncComponent } from 'vue'

/** ECharts and vue-echarts, loaded once, with the first chart shown (phase 1j spec §1). */
export const LazyVChart = defineAsyncComponent(() => import('./echarts'))
