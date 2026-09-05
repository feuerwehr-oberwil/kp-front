/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Build stamp surfaced in the app menu so a tablet in the field can be matched to a
// known deploy: package version + short git SHA + build date. Docker/Railway builds have
// no .git (dockerignored) — there the sha arrives via the GIT_SHA env (Dockerfile ARG,
// fed by Railway's RAILWAY_GIT_COMMIT_SHA); 'dev' only when neither source exists.
// NOTE: update-landed detection does NOT rely on the sha (swUpdate.ts uses sha+BUILD_TIME).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
let gitSha = 'dev'
try { gitSha = execSync('git rev-parse --short HEAD').toString().trim() } catch { /* no git */ }
if (gitSha === 'dev' && process.env.GIT_SHA) gitSha = process.env.GIT_SHA.slice(0, 7)
const buildTime = new Date().toISOString()

// ⚠️ The web manifest is NOT a static file at runtime: the backend serves it
// (backend/app/webmanifest.py), overlaying the station's own name, accent colour and app
// icons onto the one built here, so the installed PWA on a crew tablet carries the station's
// identity and not ours.
//
// That only works if the service worker never answers for it. vite-plugin-pwa force-adds
// `manifest.webmanifest` to the precache list via workbox's `additionalManifestEntries` —
// `globPatterns` above neither matches it nor can exclude it, and `manifestTransforms` runs
// BEFORE that entry is appended (workbox-build/src/lib/transform-manifest.ts: "Run
// additionalManifestEntriesTransform last"), so neither knob reaches it. A precached manifest
// is frozen at service-worker INSTALL time, which is exactly the state this feature has to
// survive: a station that rebrands after the tablets were set up would keep the old identity
// until the next deploy.
//
// So the entry is removed from the generated sw.js after vite-plugin-pwa writes it. Nothing
// is lost offline — the OS keeps its own copy of an installed app's manifest, and the manifest
// is only ever read when the app is (re-)added to a home screen.
//
// Deliberately LOUD: if a vite-plugin-pwa/workbox upgrade changes the generated shape, the
// build fails here rather than silently restoring the stale-manifest behaviour.
function dropManifestFromPrecache(): Plugin {
  const ENTRY = /,?\{url:"manifest\.webmanifest",revision:"[^"]*"\},?/
  let outDir = 'dist'
  return {
    name: 'kp-drop-manifest-from-precache',
    apply: 'build',
    // `enforce: 'post'` puts us in the same ordering bucket as VitePWA's build plugin, so
    // the array order below decides — without it rollup sorts us into the earlier bucket and
    // we run before sw.js has been written.
    enforce: 'post',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    // `sequential` is required, not cosmetic: rollup runs closeBundle hooks in PARALLEL by
    // default, and VitePWA declares its own as sequential — without this we race it and find
    // no sw.js at all. Plugin order in the array then puts us after it.
    closeBundle: {
      sequential: true,
      handler() {
        const swPath = resolve(outDir, 'sw.js')
        const sw = readFileSync(swPath, 'utf-8')
        if (!ENTRY.test(sw)) {
          throw new Error(
            'kp-drop-manifest-from-precache: no manifest.webmanifest entry found in the generated '
            + 'sw.js. Either vite-plugin-pwa stopped precaching it (then delete this plugin) or the '
            + 'generated shape changed (then fix the pattern) — do NOT ship a precached manifest.',
          )
        }
        // keep exactly one separator when the entry sat between two others
        writeFileSync(swPath, sw.replace(ENTRY, (m) => (m.startsWith(',') && m.endsWith(',') ? ',' : '')))
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // kp-rueck backend (Traccar GPS feed). Proxying /api in dev means the browser
  // talks to the Vite origin and Vite forwards server-side, so the live vehicle
  // feed works without kp-rueck having to whitelist this app's origin for CORS.
  // VITE_API_PROXY overrides ONLY the dev proxy target, independent of the client fetch base
  // (which comes from VITE_KP_RUECK_URL). This lets the browser keep talking to the Vite origin
  // (same-origin, no CORS) while /api is forwarded to a local kp-front backend on another port.
  const apiTarget = env.VITE_API_PROXY || env.VITE_KP_RUECK_URL || 'http://localhost:8000'
  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __GIT_SHA__: JSON.stringify(gitSha),
      __BUILD_TIME__: JSON.stringify(buildTime),
    },
    plugins: [
      react(),
      VitePWA({
        // 'prompt' (not 'autoUpdate'): a fresh deploy installs and WAITS instead of silently
        // taking over and reloading the page — so the app is never swapped out from under an
        // operator mid-incident (the 3am rule). Boot-time discoveries apply silently; a
        // mid-session deploy is only announced by the banner and becomes active on the next
        // app start (in-place skipWaiting reloads proved unreliable on iOS standalone).
        registerType: 'prompt',
        injectRegister: 'auto',
        // App shell is precached for offline launch on station/vehicle tablets.
        includeAssets: ['icons/apple-touch-icon.png'],
        manifest: {
          name: 'kp-front Einsatzkarte',
          short_name: 'kp-front',
          description: 'Operative Einsatzkarte der Feuerwehr — Einsätze, Pläne, Fahrzeuge.',
          lang: 'de-CH',
          display: 'standalone',
          orientation: 'any',
          // An Einsatz-Link (/l/<token>) is in scope, so an installed app should open it
          // instead of a browser tab — the responder already has the map tiles cached.
          // Chromium honours both fields; iOS home-screen web apps do NOT capture links
          // and will open Safari regardless. Half the crew lands in a browser either way,
          // which is fine: the link surface works there too.
          handle_links: 'preferred',
          // A second dispatch group for the same Einsatz must focus the running app, not
          // stack another window on top of the Lage someone is already working in.
          launch_handler: { client_mode: 'focus-existing' },
          start_url: '/',
          scope: '/',
          theme_color: '#1b2330',
          background_color: '#1b2330',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
          // long-press the home-screen icon → jump straight to the two most likely
          // cold-start intents. The URLs ride the existing ?kpn= boot-target machinery
          // (lib/notifyTarget): 'divera' opens the intake pool (editor-gated in App),
          // 'journal' opens the Verlauf once the incident is mounted. German like the
          // rest of the manifest — it's baked at build time, before the deployment
          // locale is known.
          shortcuts: [
            { name: 'Neuer Einsatz', url: '/?kpn=divera', icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
            { name: 'Verlauf', url: '/?kpn=journal', icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
          ],
        },
        workbox: {
          // Once the waiting worker is activated (via our SKIP_WAITING on apply), claim the
          // already-open page so `controllerchange` fires and the reload actually swaps in the new
          // build. Without this (workbox default is false under registerType 'prompt') the new
          // worker activates but never controls the live tab, so applying an update just spins the
          // "wird geladen" overlay until the watchdog reloads — often back into the stale build.
          clientsClaim: true,
          // ⚠️ `mjs` IS LOAD-BEARING. pdf.js' 1.2 MB worker is imported with `?url`, so Vite
          // emits it as an ASSET keeping its own extension (pdf.worker.min-<hash>.mjs) rather
          // than as a `.js` chunk. Without `mjs` here the precache contained only the 68-byte
          // stub module that HOLDS that URL, never the worker itself — so the one file the
          // whole PDF stack cannot work without was fetched from the server on every open.
          // Combined with `registerType: 'prompt'` (a tablet legitimately stays on an old build
          // until the app is fully closed, which an installed iOS app never is) that meant:
          // deploy → the old hash is gone from the server → 404 → EVERY PDF fails, on exactly
          // the devices that had not restarted, while the rest of the app ran fine out of their
          // precache. Field report 2026-08-25 («PDF konnte nicht geladen werden», all PDFs, a
          // few devices, no pattern). Adding an extension here is never cosmetic — check what
          // is emitted with it (`ls dist/assets`) before removing one.
          globPatterns: ['**/*.{js,mjs,css,html,svg,woff2,json}'],
          // Notification routing plus the auth-aware incident-media cache. Imported before
          // Workbox registers routes; sw-media-cache owns /api/media/* itself.
          importScripts: ['sw-notify.js', 'sw-media-cache.js'],
          // maplibre + pdf.worker chunks are large; precache them so the shell works offline.
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          navigateFallback: '/index.html',
          // never let the SPA fallback shadow the API or health probe.
          navigateFallbackDenylist: [/^\/api\//, /^\/health/],
          cleanupOutdatedCaches: true,
          runtimeCaching: [
            {
              // Raster base-map tiles (cross-origin → opaque, status 0). Cache-first so a
              // previously-viewed (or pre-downloaded) area renders with no signal.
              urlPattern: /^https:\/\/([a-d]\.)?(basemaps\.cartocdn\.com|tile\.openstreetmap\.org|[a-c]\.tile\.opentopomap\.org|server\.arcgisonline\.com|wmts\.geo\.admin\.ch|geowms\.bl\.ch)\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'map-tiles',
                cacheableResponse: { statuses: [0, 200] },
                expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
            {
              // Reference datasets (symbols + geojson) — keep fresh when online, usable offline.
              urlPattern: /\/api\/reference\/.*/,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'reference-data',
                cacheableResponse: { statuses: [0, 200] },
                expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
            {
              // Bundled symbols fallback. (Plan PDFs and reference geodata are no longer
              // bundled — both are served from /api/reference, cached by the rule above.)
              urlPattern: /\/tactical-symbols\.json$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'static-data',
                expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
      // MUST stay after VitePWA — it rewrites the sw.js that plugin has just written.
      dropManifestFromPrecache(),
    ],
    server: {
      host: true,
      port: 5188,
      strictPort: true,
      proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    },
    test: {
      // Fast, dependency-light unit tests for pure lib code. jsdom only where a test needs
      // the DOM (the hook test); most run in the default node environment.
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      coverage: { provider: 'v8', include: ['src/lib/**'] },
    },
    build: {
      // Keep Vite 5's browser floor when upgrading the build tool, including older tablets.
      target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
      rolldownOptions: {
        output: {
          // Split the two heavyweight libs into their own chunks so they no longer bloat the
          // initial app chunk. maplibre (~800 KB) loads with the map; pdfjs (~1.2 MB incl. the
          // worker) is dynamically imported by PdfViewport, so this chunk only ships when the
          // Plan tab is opened. Result: a smaller initial JS payload → faster tablet first paint.
          codeSplitting: {
            groups: [
              { name: 'maplibre', test: /\/node_modules\/maplibre-gl\// },
              { name: 'pdfjs', test: /\/node_modules\/pdfjs-dist\// },
            ],
          },
        },
      },
    },
  }
})
