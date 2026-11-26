# «Üben» clips – catalogue and publishing

The «Üben» clips are short narrated screen recordings, one per task. The videos never go into
git: [`scripts/ueben-publish.mjs`](../scripts/ueben-publish.mjs) turns the recorder's output
into one app folder and deploys it to a Cloudflare Pages project that KP Front and KP Rück
share. This page is the contract both apps build against. KP Rück copies the two scripts and
this page; keep them app-agnostic (the app, title, project and URL are arguments).

## The site

One Pages project, `kp-ueben` → `https://kp-ueben.pages.dev`, one folder per app:

```
/apps.json                 ["front", "rueck"] – the app folders on the site
/_headers                  CORS (*) and content types for json, vtt, mp4, jpg
/_worker.js                byte ranges for the videos (see below)
/front/catalogue.json      the catalogue
/front/<id>.mp4            the video
/front/<id>.vtt            its subtitles
/front/posters/<id>.jpg    its still
/rueck/…                   the same for KP Rück
```

Every file is CORS-open (`Access-Control-Allow-Origin: *`): a player on another origin fetches
`catalogue.json` and the `.vtt`. A file is at most 25 MiB (Pages' limit); the script refuses a
bigger one by name.

**Byte ranges.** Pages' asset server answers a `Range` request with the whole file (200, seen
26.11.2026), and Safari on iPhone and iPad does not play a video without 206 answers. The
site therefore runs a Pages worker in advanced mode,
[`scripts/ueben-pages-worker.mjs`](../scripts/ueben-pages-worker.mjs), deployed as `_worker.js`:
it passes every request to the assets and, for an `.mp4` only, answers a single range with 206
(416 past the end). The asset server gives the worker no `Content-Length`, so the size comes
from the catalogue's `bytes`; the worker streams only the asked span and buffers nothing. An
`If-Range` that no longer matches the file's ETag or date gets the whole file. Each request is
one Functions invocation (free plan: 100 000 a day).

## catalogue.json

```json
{
  "format": 1,
  "app": "front",
  "title": "KP Front – Üben",
  "chapters": [
    {
      "n": 1,
      "title": "Die Startseite",
      "clips": [
        {
          "id": "startseite-ueberblick",
          "n": 1,
          "title": "Der Überblick",
          "dur": 138.2,
          "video": "startseite-ueberblick.mp4",
          "bytes": 2977818,
          "poster": "posters/startseite-ueberblick.jpg",
          "vtt": "startseite-ueberblick.vtt",
          "steps": [6.2, 14.2, 25.2]
        }
      ]
    }
  ]
}
```

- `format` – 1. A reader refuses another number; a change that breaks readers raises it.
- `app` – the folder name; `title` – the player's heading.
- `chapters` in watching order, `n` from 1 without gaps; `clips` in watching order, `n` from 1
  per chapter («3.2» = chapter 3, clip 2).
- `id` – stable across re-recordings; a link or a «seen» mark names it. Ids read
  `<chapter key>-<clip>`, so a player can fall back to the chapter of an id that a re-recording
  merged away.
- `dur` – seconds. `steps` – each caption's start in seconds, ascending: the player's step bar.
- `video`, `poster`, `vtt` – paths relative to the catalogue's folder. `bytes` – the video's
  size; the worker answers ranges from it, and a publish checks a copied video against it.

The subtitles are WebVTT in German: cue i runs from step i to step i+1, the last one to the
clip's end, both rounded to the millisecond (a cue that rounds to nothing is refused). The cue
text is the step's `html` with `<b>` kept, every other tag dropped and the rest escaped; a step
without `html` gets its `text`, escaped.

## Recorder output

Each recording run writes a `clips.json` (or `tab-clips.json`): a list of
`{ id, chapter, title, src, dur, steps: [{ t, text, html }] }`, `src` relative to that file,
in watching order. Several runs can be given; a later one wins per id (a re-recording replaces
its clip, title and all). `--order order.json` overrides the order:
`[{ "chapter": "Die Startseite", "clips": ["startseite-ueberblick", …] }, …]`.

## Publishing

```sh
FFMPEG=~/.local/share/x-ffmpeg/ffmpeg node scripts/ueben-publish.mjs <recorder dir | clips.json>…
#   --app front (default) · --title "…" (required for another app) · --order order.json
#   --project kp-ueben · --base-url https://kp-ueben.pages.dev · --out .ueben-publish
#   --dry-run: build the deploy dir, deploy nothing
```

Needs `wrangler` logged in to the FWO Cloudflare account and `ffmpeg` (or `$FFMPEG`). The
script runs wrangler inside `--out`, never from `~` (a `~/.wrangler` folder there hides the
login). It creates the project when it is missing – with `--force`, because wrangler ≥ 4.159
otherwise makes a Workers project without `pages.dev`.

**The deploy dir.** A Pages deployment replaces the whole site, so publishing one app must
carry every other app's folder along. The script reads them from the **current production
deployment's immutable URL** (`https://<hash>.kp-ueben.pages.dev`, the newest production entry
of `wrangler pages deployment list`), not from the alias, so a deploy that lands meanwhile
cannot mix two versions; it refuses when the alias serves another `apps.json` (a dashboard
rollback – roll forward first). From there it reads `/apps.json` (every entry must be an app
name, and the new list keeps all of them), each other app's `catalogue.json` (format 1, its own
`app`; those exact bytes are shipped) and every file the catalogue names – each a complete 200
whose length matches `Content-Length` and, for a video, the catalogue's `bytes`. It adds this
app's new folder and writes `apps.json`, `_headers` and `_worker.js`. All of that is built in
`<out>/next` (default `.ueben-publish/`, gitignored, marked by `.ueben-publish-out`) and moved to
`<out>/site` only when complete, so a failed run leaves the last good site and a reusable dir.
Wrangler uploads only files whose hash it has not seen. `--drop-others` skips the copy, for a
site that really holds no other app.

**One publish at a time.** Every run, `--dry-run` too, holds an `flock` on
`/tmp/kp-ueben-publish.lock` (`$UEBEN_PUBLISH_LOCK` overrides) from start to deploy; a second
run waits. KP Rück's copy must use the same path. The lock covers this box only – do not
publish from two machines at once.
