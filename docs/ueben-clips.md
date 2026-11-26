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
it passes every request to the assets and slices a single range out (206, or 416 past the end).
Each request is one Functions invocation (free plan: 100 000 a day).

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
- `video`, `poster`, `vtt` – paths relative to the catalogue's folder.

The subtitles are WebVTT in German: cue i runs from step i to step i+1, the last one to the
clip's end. The cue text is the step's `html` with `<b>` kept and every other tag dropped.

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
carry every other app's folder along. The script builds `<out>/site` (default
`.ueben-publish/`, gitignored) from the live site: it reads `/apps.json`, downloads each other
app's `catalogue.json` and every file it names, adds this app's new folder, and writes
`apps.json`, `_headers` and `_worker.js`. Wrangler uploads only files whose hash it has not
seen. Nothing is deployed when the live `apps.json` cannot be read (`--drop-others` overrides
that, for a site that really holds no other app) or when a download fails. Publish one app at
a time: two publishes at once would each drop the other's new folder.
