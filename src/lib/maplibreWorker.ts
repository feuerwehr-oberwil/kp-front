// Where MapLibre's tile worker comes from — imported for its side effect by every file that
// mounts a <Map>, next to the stylesheet import.
//
// ⚠️ LOAD-BEARING since MapLibre 6 (23.09.2026). v6 is ESM-only and spawns its worker as a real
// URL (`new Worker(url, { type: 'module' })`) instead of the v4 blob it built out of its own
// bundle. Without a URL it guesses `./maplibre-gl-worker.mjs` next to `import.meta.url` — next
// to OUR hashed `maplibre-*.js` chunk, where no such file exists — so the build loads the map
// chrome with a grey, tileless canvas and nothing but a console line says why.
//
// `?worker&url`, not `?url` (upstream's Vite recipe): the dist worker imports its sibling
// `maplibre-gl-shared.mjs`, and `?url` copies the file verbatim without it. `?worker&url` runs
// it through Vite's worker build into ONE self-contained `.js` asset, which the precache glob
// (`**/*.js`) picks up — the map therefore still starts offline from a cold launch. The worker
// is same-origin, so no `blob:` is needed in a `worker-src`.
//
// Kept out of main.tsx on purpose: a static maplibre import in the entry would make every route
// modulepreload the 800 KB maplibre chunk (vite.config · codeSplitting). The worker pool reads
// the URL when the FIRST map is constructed, so it has to be set before any <Map> renders — a
// module side effect in the mounting file is exactly that.
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

setWorkerUrl(workerUrl)
