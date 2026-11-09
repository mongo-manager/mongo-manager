# Mongo Manager's landing page

A static page in this folder, with no build step: `index.html`, `styles.css`, `app.js`, `i18n.js`
(ten languages) and `theme-init.js`, and the pictures and clips under `assets/`. It loads nothing
from another site; its only request is the latest release, from `api.github.com`, without
credentials or referrer.

## Publishing on GitHub Pages

`.github/workflows/pages.yml` publishes this folder on GitHub Pages whenever it changes on `main`
(or by hand, from the Actions tab). In the repository's settings, **Pages → Source** is
**GitHub Actions**. The page is then at `https://<owner>.github.io/<repository>/`.

## When the project moves

The page finds its repository from its own address (`<owner>.github.io/<repository>/`): the GitHub
links, the release, the license and the Docker image follow by themselves. Two things do not:

- the link preview's picture: the absolute `og:image` and `twitter:image` addresses in `index.html`;
- the last card of the video: run the media script with `MM_PROMO_REPO=github.com/<owner>/<repository>`.

## Pictures and clips

They are made from the app itself, on an invented store, by an on-demand Playwright run, then cut and
composed by a script:

```sh
MM_MEDIA=1 pnpm --filter @mongo-manager/e2e exec playwright test tests/01-first-run.spec.ts tests/media --project=chrome
node packages/e2e/scripts/readme-media.mjs
```

The script writes this folder's `assets/` (screens in both themes, clips, the link preview, icons),
the READMEs' GIFs and video under `docs/media/`, and Product Hunt's gallery, cards and video under
`docs/promo/`. It needs ffmpeg and the installed Chrome.

`scripts/site.test.mjs` checks that every text is there in every language, that nothing is loaded
from another site, and that every file the page names exists.
