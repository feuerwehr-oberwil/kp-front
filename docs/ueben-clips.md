# «Üben» clips – catalogue and publishing

The «Üben» clips are short narrated screen recordings, one per task. The videos never go into
git: [`scripts/ueben-publish.mjs`](../scripts/ueben-publish.mjs) turns the recorder's output
into one app folder and deploys it to a Cloudflare Pages project that KP Front and KP Rück
share. This page is the contract both apps build against. KP Rück copies the two scripts and
this page; keep them app-agnostic (the app, title, project and URL are arguments, the mirror
and its lock are shared).

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
  size, measured on the published copy; the worker answers ranges from it. `--seed-from-live`
  adds it to a catalogue from before it existed. Key order carries no meaning.

The subtitles are WebVTT in German: cue i runs from step i to step i+1, the last one to the
clip's end, both rounded to the millisecond (a cue that rounds to nothing is refused). The cue
text is the step's `html` with `<b>` kept, every other tag dropped and the rest escaped; a step
without `html` gets its `text`, escaped. Either is put on one line – a blank line would end the
cue.

## Recorder output

Each recording run writes a `clips.json` (or `tab-clips.json`): a list of
`{ id, chapter, title, src, dur, steps: [{ t, text, html }] }`, `src` relative to that file,
in watching order. Several runs can be given; a later one wins per id (a re-recording replaces
its clip, title and all). `--order order.json` overrides the order:
`[{ "chapter": "Die Startseite", "clips": ["startseite-ueberblick", …] }, …]`.

## Publishing

**Publish only from this box.** The source of truth is a local mirror of the whole site that
every app's copy of the script shares: `~/.local/share/kp-ueben-site/` (`$UEBEN_SITE_DIR`).

```
~/.local/share/kp-ueben-site/
├── site/          what is deployed: front/, rueck/, apps.json, _headers, _worker.js
├── .lock          the flock every run holds
├── .project       the Pages project this mirror is for – written by --init / --seed-from-live
├── next-<app>/    a staged app folder (a --dry-run leaves it to look at)
├── old-<app>/     only while a swap runs – the folder it replaces
└── .wrangler/     wrangler's cache – outside site/, never uploaded
```

```sh
FFMPEG=~/.local/share/x-ffmpeg/ffmpeg node scripts/ueben-publish.mjs <recorder dir | clips.json>…
#   --app front (default) · --title "…" (required for another app) · --order order.json
#   --project kp-ueben · --dry-run: stage the app folder only
node scripts/ueben-publish.mjs --seed-from-live   # an empty mirror for a project that is live
node scripts/ueben-publish.mjs --init             # an empty mirror for a project with nothing live
```

Needs `wrangler` logged in to the FWO Cloudflare account and `ffmpeg` (or `$FFMPEG`). Wrangler
runs inside the mirror, never from `~` (a `~/.wrangler` folder there hides the login). The
script creates the project when it is missing – with `--force`, because wrangler ≥ 4.159
otherwise makes a Workers project without `pages.dev`.

A publish, start to end under an `flock` on `<mirror>/.lock` (a second run waits; the kernel
drops the lock when a run ends, crash or not):

1. puts back any `old-<app>/` whose `site/<app>/` is missing (a swap that died midway) and drops
   one whose swap finished – it never promotes a `next-<app>/`, so a dry run never goes live;
2. refuses unless `.project` names this project – a lost or mistyped mirror would otherwise
   replace the whole site with one app;
3. stages the app in `next-<app>/`: each video **copied** from the recorder output, the poster
   and the catalogue's `bytes` taken from that copy, a `.vtt` per clip, files above 25 MiB and
   clip ids that are not one plain segment (letters, digits, «-») refused;
4. swaps it into `site/<app>/` (the old folder steps aside to `old-<app>/` first);
5. regenerates `apps.json` from the app folders present, writes `_headers` and `_worker.js`;
6. deploys all of `site/` – wrangler uploads only files whose hash it has not seen.

A Pages deployment replaces the whole site, and every deploy uploads the **full** mirror, so
each one carries every app. If a deploy fails after the swap, or production is rolled back in
the dashboard, the mirror still holds every app's newest folder and the next publish restores
it. Nothing is read back from the live site – except by `--seed-from-live`, the one recovery
path (a new box, a lost mirror). It refuses a mirror that is not empty, reads `apps.json`, each
`catalogue.json` (format 1, its own `app`) and every file it names, each a complete
uncompressed 200 whose length matches `Content-Length` and, for a video, `bytes`. It builds the
whole site – root files and size checks included – in `seeding/`, writes the project name to
`.project.pending`, renames `seeding/` to `site/` and only then renames the pending file to
`.project`. A seed that fails before the rename leaves the mirror empty and seedable again; one
killed after it is finished by the next run's recovery (pending + `site/` → `.project`). A
marked mirror always has its `site/`.
Neither `--seed-from-live` nor `--init` takes `--dry-run`.
