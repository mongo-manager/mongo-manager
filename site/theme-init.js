// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// Before the first paint: the theme a visitor chose (light or dark), so the page never flashes the
// other one. Its own file: the page's CSP allows no inline script.
try {
  var theme = localStorage.getItem('mm-site-theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme)
} catch {
  // No storage (a private window, blocked site data): the system's theme.
}
