// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// README, landing page and Product Hunt media (2026-10-31): turns what tests/media recorded into
// the published files. Needs ffmpeg on the PATH (or FFMPEG=path/to/ffmpeg) and the installed Chrome.
//   MM_MEDIA=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/media --project=chrome
//   node packages/e2e/scripts/readme-media.mjs            (--cards: only the cards, the link preview and the promo video)
//
//   site/assets/screens/<scene>-<light|dark>.png  the screens, both themes (landing page and README)
//   site/assets/clips/<scene>.mp4                 a looping clip of each scene (landing page)
//   site/assets/og-image.png                      the link preview (1200×630)
//   docs/media/demo.mp4, demo.gif                 the tour (README)
//   docs/media/clips/<scene>.gif                  a short GIF of each scene (README)
//   docs/promo/gallery/<n>-<scene>.png            Product Hunt's gallery (1270×760)
//   docs/promo/frames/intro.png, outro.png        the tour's first and last cards
//   docs/promo/mongo-manager-demo.mp4             the tour between them (Product Hunt, YouTube)
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const from = join(here, '..', 'test-results', 'media')
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
// Where the project lives, as the last card says it (MM_PROMO_REPO when it moves).
const REPO = process.env.MM_PROMO_REPO ?? 'github.com/mongo-manager/mongo-manager'
const out = {
  screens: join(repo, 'site', 'assets', 'screens'),
  clips: join(repo, 'site', 'assets', 'clips'),
  media: join(repo, 'docs', 'media'),
  gifs: join(repo, 'docs', 'media', 'clips'),
  gallery: join(repo, 'docs', 'promo', 'gallery'),
  frames: join(repo, 'docs', 'promo', 'frames'),
}
// --cards: only the intro and outro cards, the link preview and the promo video, from the committed
// screens and docs/media/demo.mp4 (when the words on a card change; nothing of the recordings is needed).
const CARDS_ONLY = process.argv.includes('--cards')
// Made again whole each time: nothing left over from a scene that is gone.
for (const dir of CARDS_ONLY ? [out.frames] : Object.values(out)) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { stdio: 'inherit' })

if (!CARDS_ONLY) {
  // The screens.
  const screens = readdirSync(from).filter((n) => /-(light|dark)\.png$/.test(n))
  for (const name of screens) copyFileSync(join(from, name), join(out.screens, name))

  // The tour, and a clip of each scene.
  const videos = readdirSync(join(from, 'video')).filter((n) => n.endsWith('.webm'))
  if (videos.length !== 1) throw new Error(`expected one recording, found ${videos.length}`)
  const video = join(from, 'video', videos[0])
  const marks = JSON.parse(readFileSync(join(from, 'video', 'marks.json'), 'utf8'))
  const LEAD = 0.8 // the first moment is the page still loading
  run([
    '-ss',
    String(LEAD),
    '-i',
    video,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    join(out.media, 'demo.mp4'),
  ])
  const gif = (speed, width) =>
    `setpts=PTS/${speed},fps=${width > 760 ? 10 : 12},scale=${width}:-1:flags=lanczos,split[a][b];` +
    '[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle'
  run(['-ss', String(LEAD), '-i', video, '-vf', gif(1.6, 800), join(out.media, 'demo.gif')])
  for (const { scene, start, end } of marks) {
    const span = ['-ss', String(Math.max(0, start - 0.2)), '-t', String(end - start + 0.3), '-i', video]
    run([
      ...span,
      '-vf',
      'scale=1280:-2',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '24',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      join(out.clips, `${scene}.mp4`),
    ])
    run([...span, '-vf', gif(1.25, 720), join(out.gifs, `${scene}.gif`)])
  }
}
// The cards and the gallery: an HTML page in the app's own look, photographed by Chrome.
const dataUri = (path, type) => `data:${type};base64,${readFileSync(path).toString('base64')}`
const inter = dataUri(
  join(
    repo,
    'packages',
    'web',
    'node_modules',
    '@fontsource-variable',
    'inter',
    'files',
    'inter-latin-wght-normal.woff2',
  ),
  'font/woff2',
)
const icon = readFileSync(join(repo, 'packages', 'web', 'public', 'favicon.svg'), 'utf8')
const base = `
  @font-face { font-family: Inter; src: url(${inter}) format('woff2'); font-weight: 100 900; }
  * { margin: 0; box-sizing: border-box; }
  /* The whole page tall: what is placed absolutely gives the body no height of its own, and the
     background's gradients are sized by the body. */
  html, body { height: 100%; }
  body { font-family: Inter, system-ui, sans-serif; color: #fff; overflow: hidden; position: relative;
    background: radial-gradient(60% 70% at 12% 20%, rgb(4 122 77 / .35), transparent 70%),
      radial-gradient(50% 60% at 90% 0%, rgb(16 185 129 / .18), transparent 70%),
      linear-gradient(160deg, #04110c, #0a1a14 55%, #04110c); }
  .icon svg { width: 100%; height: 100%; display: block; filter: drop-shadow(0 18px 40px rgb(16 185 129 / .35)); }
  .shot { border-radius: 14px; border: 1px solid rgb(255 255 255 / .12);
    box-shadow: 0 40px 80px -20px rgb(0 0 0 / .65), 0 0 0 1px rgb(0 0 0 / .4); display: block; }`
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ deviceScaleFactor: 1 })
async function photograph(width, height, html, path) {
  await page.setViewportSize({ width, height })
  await page.setContent(`<!doctype html><html><head><style>${base}</style></head><body>${html}</body></html>`)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path, clip: { x: 0, y: 0, width, height } })
}
const screen = (name) => dataUri(join(out.screens, name), 'image/png')

const card = (size, line, tagline) => `
  <div style="height:100vh;display:grid;place-items:center;text-align:center">
    <div>
      <div class="icon" style="width:${size}px;height:${size}px;margin:0 auto 36px">${icon}</div>
      <div style="font-size:${size * 0.56}px;font-weight:700;letter-spacing:-.02em">Mongo Manager</div>
      <div style="width:72px;height:4px;border-radius:2px;background:#10b981;margin:26px auto 24px"></div>
      <div style="font-size:30px;color:rgb(255 255 255 / .82)">${line}</div>
      ${tagline ? `<div style="display:inline-block;margin-top:28px;padding:10px 20px;border-radius:999px;font-size:20px;color:#6ee7b7;border:1px solid rgb(110 231 183 / .35);background:rgb(16 185 129 / .08)">${tagline}</div>` : ''}
    </div>
  </div>`
await photograph(
  1440,
  900,
  card(136, 'A secure MongoDB manager in your browser.'),
  join(out.frames, 'intro.png'),
)
await photograph(
  1440,
  900,
  card(104, 'Self-hosted · Works offline · Free to use', REPO),
  join(out.frames, 'outro.png'),
)

// The link preview, from the committed screens (so --cards makes it too, user request 2026-11-03).
await photograph(
  1200,
  630,
  `<div style="position:absolute;left:64px;top:110px;width:430px">
  <div class="icon" style="width:112px;height:112px;margin-bottom:30px">${icon}</div>
  <div style="font-size:56px;font-weight:700;letter-spacing:-.02em;line-height:1.05">Mongo Manager</div>
  <div style="margin-top:22px;font-size:27px;line-height:1.45;color:rgb(255 255 255 / .8)">A secure MongoDB manager<br>in your browser</div>
  <div style="margin-top:16px;font-size:22px;color:#6ee7b7">Self-hosted · Works offline<br>Free to use</div>
</div>
<img class="shot" src="${screen('aggregation-dark.png')}" style="position:absolute;left:530px;top:78px;width:760px;height:475px;object-fit:cover;object-position:left top">`,
  join(repo, 'site', 'assets', 'og-image.png'),
)

// The gallery and the icons are made from the recordings.
if (!CARDS_ONLY) {
  const GALLERY = [
    ['documents', 'Your MongoDB, in your browser'],
    ['ai-agent', 'An AI agent that asks before it changes anything'],
    ['aggregation', 'Pipelines built stage by stage, each one previewed'],
    ['explain', 'See why a query is slow'],
    ['performance', 'Live performance, history and alerts'],
    ['plugins', 'Extended with sandboxed plugins you approve'],
    ['security', 'Built for teams: roles, 2FA and panel access'],
    ['documents', 'Light and dark, in ten languages', 'dark'],
  ]
  for (const [i, [scene, headline, theme = 'light']] of GALLERY.entries()) {
    await photograph(
      1270,
      760,
      `<div style="position:absolute;top:44px;width:100%;text-align:center;font-size:40px;font-weight:700;letter-spacing:-.015em">${headline}</div>
    <img class="shot" src="${screen(`${scene}-${theme}.png`)}" style="position:absolute;left:95px;top:124px;width:1080px;height:675px;object-fit:cover;object-position:top">`,
      join(out.gallery, `${i + 1}-${scene}${theme === 'dark' ? '-dark' : ''}.png`),
    )
  }

  // The page's icons: the app's own mark, as an SVG and as the PNGs browsers and phones ask for.
  copyFileSync(
    join(repo, 'packages', 'web', 'public', 'favicon.svg'),
    join(repo, 'site', 'assets', 'icon.svg'),
  )
  for (const [px, name] of [
    [32, 'favicon-32.png'],
    [180, 'apple-touch-icon.png'],
  ]) {
    await page.setViewportSize({ width: px, height: px })
    await page.setContent(
      `<!doctype html><html><head><style>*{margin:0}svg{width:${px}px;height:${px}px;display:block}</style></head><body>${icon}</body></html>`,
    )
    await page.screenshot({ path: join(repo, 'site', 'assets', name), omitBackground: true })
  }
}
await browser.close()

// The tour between its cards, for Product Hunt and video sites.
run([
  '-loop',
  '1',
  '-t',
  '2.6',
  '-i',
  join(out.frames, 'intro.png'),
  '-i',
  join(out.media, 'demo.mp4'),
  '-loop',
  '1',
  '-t',
  '3.4',
  '-i',
  join(out.frames, 'outro.png'),
  '-filter_complex',
  '[0:v]fps=30,setsar=1,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st=2.2:d=0.4[a];' +
    '[1:v]fps=30,setsar=1,format=yuv420p,fade=t=in:st=0:d=0.3[b];' +
    '[2:v]fps=30,setsar=1,format=yuv420p,fade=t=in:st=0:d=0.4[c];[a][b][c]concat=n=3:v=1:a=0[v]',
  '-map',
  '[v]',
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  join(repo, 'docs', 'promo', 'mongo-manager-demo.mp4'),
])

const size = (path) => `${(statSync(path).size / 1024 / 1024).toFixed(2)} MB`
for (const dir of Object.values(out))
  for (const name of readdirSync(dir).sort())
    if (statSync(join(dir, name)).isFile())
      console.log(
        `${join(dir, name)
          .slice(repo.length + 1)
          .padEnd(48)} ${size(join(dir, name))}`,
      )
for (const name of ['site/assets/og-image.png', 'docs/promo/mongo-manager-demo.mp4'])
  console.log(`${name.padEnd(48)} ${size(join(repo, name))}`)
