// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
/**
 * The JS-context scanner (strings, templates, regular expressions, comments) lives in `shared`, where
 * the snippet placeholder check uses it too; the editor's completer and bracket matching share it.
 */
export { HIDDEN, maskStrings } from '@mongo-manager/shared/browser'
