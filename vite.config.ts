/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
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
          name: 'kp-front Lagekarte',
          short_name: 'kp-front',
          description: 'Operative Lagekarte der Feuerwehr — Einsätze, Pläne, Fahrzeuge.',
          lang: 'de-CH',
          display: 'standalone',
          orientation: 'any',
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
          globPatterns: ['**/*.{js,css,html,svg,woff2,json}'],
          // custom notificationclick handler (focus/open the app + route to the right tab)
          importScripts: ['sw-notify.js'],
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
              // Incident media (immutable by id).
              urlPattern: /\/api\/media\/.*/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'incident-media',
                cacheableResponse: { statuses: [0, 200] },
                expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
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
      rollupOptions: {
        output: {
          // Split the two heavyweight libs into their own chunks so they no longer bloat the
          // initial app chunk. maplibre (~800 KB) loads with the map; pdfjs (~1.2 MB incl. the
          // worker) is dynamically imported by PdfViewport, so this chunk only ships when the
          // Plan tab is opened. Result: a smaller initial JS payload → faster tablet first paint.
          manualChunks: {
            maplibre: ['maplibre-gl'],
            pdfjs: ['pdfjs-dist'],
          },
        },
      },
    },
  }
})
