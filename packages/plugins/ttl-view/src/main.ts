// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { createClient } from '../../kit/src/client'
import { mount } from './view'

mount(document.getElementById('app')!, createClient())
