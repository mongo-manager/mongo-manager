// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// Mongo Manager's landing page: languages, theme, install tabs, copy buttons, the tour's clips, the
// screenshot viewer and the latest release. No dependency; the only request leaves for api.github.com.
;(function () {
  'use strict'
  var I18N = window.MM_I18N || {}
  var LOCALE_TAGS = {
    en: 'en',
    tr: 'tr',
    zh: 'zh-CN',
    ja: 'ja',
    es: 'es',
    pt: 'pt-BR',
    ko: 'ko',
    de: 'de',
    fr: 'fr',
    ru: 'ru',
  }

  // The repository this page belongs to: from <owner>.github.io/<repo>/, so a move needs no edit.
  var OWNER = 'mongo-manager'
  var REPO = 'mongo-manager'
  ;(function () {
    var host = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i)
    var path = location.pathname.split('/').filter(Boolean)[0]
    if (host) {
      OWNER = host[1]
      if (path && !/\.html?$/.test(path)) REPO = path
    }
  })()
  var REPO_URL = 'https://github.com/' + OWNER + '/' + REPO

  var store = {
    get: function (k) {
      try {
        return localStorage.getItem(k)
      } catch {
        return null
      }
    },
    set: function (k, v) {
      try {
        localStorage.setItem(k, v)
      } catch {
        /* nothing kept */
      }
    },
  }
  var session = {
    get: function (k) {
      try {
        return sessionStorage.getItem(k)
      } catch {
        return null
      }
    },
    set: function (k, v) {
      try {
        sessionStorage.setItem(k, v)
      } catch {
        /* nothing kept */
      }
    },
  }

  // Languages: ?lang=, then the visitor's choice, then the browser's languages, then English.
  var lang = 'en'
  function detectLang() {
    var asked = new URLSearchParams(location.search).get('lang')
    if (asked && I18N[asked]) return asked
    var kept = store.get('mm-site-lang')
    if (kept && I18N[kept]) return kept
    var wanted = navigator.languages || [navigator.language || 'en']
    for (var i = 0; i < wanted.length; i++) {
      var base = String(wanted[i]).toLowerCase().split('-')[0]
      if (I18N[base]) return base
    }
    return 'en'
  }
  function t(key, vars) {
    var text = (I18N[lang] && I18N[lang][key]) || (I18N.en && I18N.en[key]) || ''
    if (vars) for (var k in vars) text = text.split('{' + k + '}').join(vars[k])
    return text
  }
  function applyLang() {
    document.documentElement.lang = LOCALE_TAGS[lang] || lang
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = t(el.dataset.i18n)
      if (v) el.textContent = v
    })
    // Trusted, static strings of this page only (they may hold <code>).
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var v = t(el.dataset.i18nHtml)
      if (v) el.innerHTML = v
    })
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      var v = t(el.dataset.i18nAria)
      if (v) el.setAttribute('aria-label', v)
    })
    document.querySelectorAll('[data-i18n-alt]').forEach(function (el) {
      var v = t(el.dataset.i18nAlt)
      if (v) el.alt = v
    })
    document.querySelectorAll('.shot').forEach(function (fig) {
      var caption = t('shots.' + fig.dataset.shot)
      fig.querySelectorAll('img').forEach(function (img) {
        img.alt = caption
      })
    })
    var title = t('meta.title')
    if (title) document.title = title
    var description = document.querySelector('meta[name="description"]')
    if (description && t('meta.description')) description.setAttribute('content', t('meta.description'))
    document.getElementById('lang-select').value = lang
    syncTheme()
    syncClips()
    renderRelease()
  }

  // Theme: automatic (the system's), light or dark, in turn.
  var THEMES = ['auto', 'light', 'dark']
  function syncTheme() {
    var now = document.documentElement.getAttribute('data-theme') || 'auto'
    var button = document.getElementById('theme-toggle')
    button.setAttribute('aria-label', t('a11y.theme', { mode: t('theme.' + now) }))
    button.title = t('theme.' + now)
  }
  function setupTheme() {
    document.getElementById('theme-toggle').addEventListener('click', function () {
      var now = document.documentElement.getAttribute('data-theme') || 'auto'
      var next = THEMES[(THEMES.indexOf(now) + 1) % THEMES.length]
      document.documentElement.setAttribute('data-theme', next)
      if (next === 'auto') {
        try {
          localStorage.removeItem('mm-site-theme')
        } catch {
          /* nothing kept */
        }
      } else store.set('mm-site-theme', next)
      syncTheme()
    })
  }

  function rewriteRepoLinks() {
    var links = {
      'gh-link': REPO_URL,
      'repo-link': REPO_URL,
      'source-link': REPO_URL,
      'license-link': REPO_URL + '/blob/main/LICENSE',
      'releases-link': REPO_URL + '/releases/latest',
    }
    for (var id in links) {
      var a = document.getElementById(id)
      if (a) a.href = links[id]
    }
    var image = document.querySelector('[data-repo-image]')
    if (image)
      image.textContent =
        'docker run -d -p 127.0.0.1:4321:4321 -v mm-data:/data ghcr.io/' + OWNER + '/' + REPO
  }

  // Install tabs (WAI-ARIA): arrows, Home and End move between them.
  function setupTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'))
    function select(tab, focus) {
      tabs.forEach(function (t2) {
        var on = t2 === tab
        t2.setAttribute('aria-selected', on ? 'true' : 'false')
        t2.tabIndex = on ? 0 : -1
        document.getElementById(t2.getAttribute('aria-controls')).hidden = !on
      })
      if (focus) tab.focus()
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () {
        select(tab, false)
      })
      tab.addEventListener('keydown', function (e) {
        var to =
          e.key === 'ArrowRight'
            ? (i + 1) % tabs.length
            : e.key === 'ArrowLeft'
              ? (i - 1 + tabs.length) % tabs.length
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? tabs.length - 1
                  : -1
        if (to < 0) return
        e.preventDefault()
        select(tabs[to], true)
      })
    })
  }

  function setupCopy() {
    document.querySelectorAll('.copy').forEach(function (button) {
      button.addEventListener('click', function () {
        var text = button.parentElement.querySelector('code').textContent
        var done = function () {
          button.textContent = t('install.copied')
          setTimeout(function () {
            button.textContent = t('install.copy')
          }, 1600)
        }
        if (navigator.clipboard)
          navigator.clipboard.writeText(text).then(done, function () {
            /* left as it was */
          })
      })
    })
  }

  // The tour's clips: they play while on screen, never on their own for a visitor who asked for less
  // motion, and each has a button that stops or starts it.
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var clips = []
  function syncClips() {
    clips.forEach(function (c) {
      var playing = !c.video.paused
      c.button.setAttribute('aria-pressed', playing ? 'true' : 'false')
      c.button.setAttribute('aria-label', t(playing ? 'tour.pause' : 'tour.play'))
    })
  }
  function setupClips() {
    document.querySelectorAll('.clip-frame').forEach(function (frame) {
      var c = {
        video: frame.querySelector('video'),
        button: frame.querySelector('.clip-toggle'),
        stopped: still,
        seen: false,
      }
      clips.push(c)
      c.video.addEventListener('play', syncClips)
      c.video.addEventListener('pause', syncClips)
      c.button.addEventListener('click', function () {
        if (c.video.paused) {
          c.stopped = false
          c.video.play().catch(function () {})
        } else {
          c.stopped = true
          c.video.pause()
        }
      })
    })
    if (!('IntersectionObserver' in window)) return syncClips()
    var watcher = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var c = clips.filter(function (x) {
            return x.video === entry.target
          })[0]
          if (!c) return
          if (entry.isIntersecting && !c.stopped) c.video.play().catch(function () {})
          else if (!entry.isIntersecting) c.video.pause()
        })
      },
      { threshold: 0.4 },
    )
    clips.forEach(function (c) {
      watcher.observe(c.video)
    })
    syncClips()
  }

  // The screenshot viewer: the picture of the page's theme, arrows and swipes between them.
  function setupLightbox() {
    var dialog = document.getElementById('lightbox')
    var img = document.getElementById('lb-img')
    var caption = document.getElementById('lb-caption')
    var counter = document.getElementById('lb-counter')
    var figures = Array.prototype.slice.call(document.querySelectorAll('.shot'))
    var at = 0
    var opener = null
    function dark() {
      var mode = document.documentElement.getAttribute('data-theme')
      return (
        mode === 'dark' || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      )
    }
    function srcOf(fig) {
      return fig.querySelector(dark() ? '.shot-dark' : '.shot-light').getAttribute('src')
    }
    function show(i) {
      at = (i + figures.length) % figures.length
      img.src = srcOf(figures[at])
      img.alt = t('shots.' + figures[at].dataset.shot)
      caption.textContent = img.alt
      counter.textContent = at + 1 + ' / ' + figures.length
      new Image().src = srcOf(figures[(at + 1) % figures.length])
    }
    figures.forEach(function (fig, i) {
      fig.tabIndex = 0
      fig.setAttribute('role', 'button')
      fig.addEventListener('click', function () {
        opener = fig
        show(i)
        dialog.showModal()
        document.body.style.overflow = 'hidden'
      })
      fig.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          fig.click()
        }
      })
    })
    dialog.addEventListener('close', function () {
      document.body.style.overflow = ''
      if (opener) opener.focus()
    })
    dialog.querySelector('.lb-close').addEventListener('click', function () {
      dialog.close()
    })
    dialog.querySelector('.lb-prev').addEventListener('click', function () {
      show(at - 1)
    })
    dialog.querySelector('.lb-next').addEventListener('click', function () {
      show(at + 1)
    })
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog || e.target.classList.contains('lb-figure')) dialog.close()
    })
    dialog.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') show(at + 1)
      else if (e.key === 'ArrowLeft') show(at - 1)
      else if (e.key === 'Home') show(0)
      else if (e.key === 'End') show(figures.length - 1)
    })
    var startX = null
    dialog.addEventListener(
      'touchstart',
      function (e) {
        startX = e.touches[0].clientX
      },
      { passive: true },
    )
    dialog.addEventListener('touchend', function (e) {
      if (startX === null) return
      var dx = e.changedTouches[0].clientX - startX
      if (Math.abs(dx) > 50) show(at + (dx < 0 ? 1 : -1))
      startX = null
    })
    figures.forEach(function (fig) {
      fig.addEventListener('focus', function () {
        fig.setAttribute('aria-label', t('lb.open', { caption: t('shots.' + fig.dataset.shot) }))
      })
    })
  }

  // The latest release: one request, without credentials or referrer, kept for an hour.
  var release = null
  function renderRelease() {
    var el = document.getElementById('release-info')
    if (!el) return
    if (!release) {
      el.textContent = ''
      return
    }
    var date = new Intl.DateTimeFormat(LOCALE_TAGS[lang] || lang, { dateStyle: 'medium' }).format(
      new Date(release.date),
    )
    el.textContent = t('release.info', { v: release.version, date: date })
  }
  function fetchRelease() {
    var kept = session.get('mm-site-release')
    if (kept) {
      try {
        release = JSON.parse(kept)
        if (Date.now() - release.at < 3600000) return renderRelease()
      } catch {
        /* asked again */
      }
    }
    if (!window.fetch || !window.AbortController) return
    var abort = new AbortController()
    var timer = setTimeout(function () {
      abort.abort()
    }, 6000)
    fetch('https://api.github.com/repos/' + OWNER + '/' + REPO + '/releases/latest', {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: abort.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then(function (r) {
        return r.ok ? r.json() : null
      })
      .then(function (data) {
        clearTimeout(timer)
        if (!data || !data.tag_name) return
        release = {
          version: String(data.tag_name).replace(/^v/, ''),
          date: data.published_at,
          at: Date.now(),
        }
        session.set('mm-site-release', JSON.stringify(release))
        renderRelease()
      })
      .catch(function () {
        clearTimeout(timer)
      })
  }

  document.getElementById('year').textContent = String(new Date().getFullYear())
  lang = detectLang()
  rewriteRepoLinks()
  setupTheme()
  setupTabs()
  setupCopy()
  setupClips()
  setupLightbox()
  document.getElementById('lang-select').addEventListener('change', function (e) {
    var next = e.target.value
    if (!I18N[next]) return
    lang = next
    store.set('mm-site-lang', lang)
    var url = new URL(location.href)
    url.searchParams.set('lang', lang)
    history.replaceState(null, '', url)
    applyLang()
  })
  applyLang()
  fetchRelease()
})()
