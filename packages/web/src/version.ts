// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * User request 2026-10-31: the app's version, read from this package's own manifest as the server and
 * the CLI read theirs. A named import: the build keeps this one field, not the whole manifest.
 */
import { version } from '../package.json'

export const APP_VERSION: string = version
