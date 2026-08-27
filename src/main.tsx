import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { initServiceWorker } from './lib/swUpdate'
import { initInstallPrompt } from './lib/installPrompt'
import { installGlobalErrorReporting } from './lib/reportError'
import App from './App'
import './fonts.css'
import './app.css'
import { AuthProvider, useAuth } from './lib/auth'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoginScreen } from './components/LoginScreen'
import { DemoRibbon } from './components/DemoRibbon'
import { Splash } from './components/Splash'
import { lockChromeZoom } from './lib/lockZoom'
import { loadPrefs, applyTheme, resolveTheme } from './lib/prefs'
import { loadDeploymentConfigBounded, applyDeploymentBranding } from './lib/deploymentConfig'
import { loadStationPlanScales, refreshStationPlanScales } from './lib/stationPlanScale'
import { migrateLocalStorageToIdb } from './lib/storageMigration'
import { requestPersistentStorage } from './lib/idb'
import { applyLocale } from './config/copy'

// zoom applies only to the map/plan, not the UI chrome (app feel, not a web page)
lockChromeZoom()

// Report uncaught errors (outside the render tree) to the server log so a field crash on a
// solo operator's tablet isn't invisible. The ErrorBoundary reports render throws separately.
installGlobalErrorReporting()

// Night ergonomics: resolve the colour scheme before first paint so the app never
// flashes the wrong chrome. Default 'auto' tracks daylight (brigade region at boot,
// the incident coordinate once known via useAutoTheme); 'day'/'night' are overrides.
applyTheme(resolveTheme(loadPrefs().theme, null, new Date()))

// Ask for PERSISTENT storage: without it this origin's bucket is "best-effort" and the browser
// may evict the whole offline cache — cached incident workspaces, queued media, unsynced edits —
// under disk pressure, with no error to catch. Deliberately NOT awaited: nothing on the boot path
// may block first paint (that was the af9b842 white-screen class of bug).
void requestPersistentStorage()

// PWA: register the service worker (precaches the app shell + runtime-caches map tiles
// and reference data so the tool launches and renders offline on station/vehicle tablets).
// registerType 'prompt' → a new build installs and WAITS (no silent mid-incident reload); the
// UpdateBanner announces that it will activate on the next full app start. swUpdate also polls
// every five minutes so always-on tablets that never reload still discover a fresh deploy.
initServiceWorker()

// "Als App installieren": capture Chromium's beforeinstallprompt BEFORE React mounts (it can
// fire early and is lost if nothing listens) — the InstallGuide then offers one-tap install.
initInstallPrompt()

// Admin surface: an unlinked /admin route loaded as its OWN lazy chunk so field
// users (the overwhelming majority of loads) never download any admin code. The
// Suspense fallback reuses the same boot Splash as the auth Gate below.
const AdminApp = lazy(() => import('./admin/AdminApp'))

// Station capture (/e/<token>, the Erfassungs-Poster QR): its own lazy chunk, token-authed
// against /api/capture — no login, no auth provider, none of the field-app bundle.
const CaptureApp = lazy(() => import('./capture/CaptureApp'))

// Einsatz-Link (/l/<token>, the URL an external alerting system puts into the alert): its own
// lazy chunk like the capture view, token-exchanged against /api/incident-link/session — no
// login. Unlike capture it hands off to the normal field app afterwards, so it brings its own
// AuthProvider (mounted only once the session cookie exists — see LinkApp).
const LinkApp = lazy(() => import('./link/LinkApp'))

// Auth gate: hold the boot Splash while the /me probe settles, then show the
// kiosk login until someone is authenticated, then the app. The brand pulse +
// wordmark instead of a blank colour flash, so the launch feels continuous with
// the login screen that follows.
function Gate() {
  const { user, loading } = useAuth()
  return (
    <>
      <DemoRibbon />
      {loading ? <Splash /> : !user ? <LoginScreen /> : <App />}
    </>
  )
}

// Nothing before createRoot may be unbounded. Anything still pending here is a LITERALLY blank
// screen — `#root` is empty, so there is no splash, no error boundary and nothing to tap, and
// killing the app just re-runs the same stall. Both awaits below therefore carry a hard
// wall-clock budget and fall back to their offline caches; first paint is guaranteed.
const BOOT_BUDGET_MS = 4_000

/** Resolve `p`, or `fallback` if it hasn't settled within `ms`. The loser keeps running. */
function withBudget<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((res) => { timer = setTimeout(() => res(fallback), ms) }),
  ]).finally(() => clearTimeout(timer))
}

// Resolve the deployment config (PUBLIC /api/config) BEFORE first render so per-deployment
// branding/defaults are in place from the very first paint and the synchronous accessor
// (getDeploymentConfig) is already populated when read sites run. Budgeted: a slow/stalled
// network serves the offline-cached config instead of holding the blank page.
void (async () => {
  try {
    // Move operational state (workspace caches, incident list, roster, config, outlines) from
    // localStorage into IndexedDB once, BEFORE anything reads its cache — loadDeploymentConfig's
    // offline fallback and WorkspaceSync.init both now read from IDB. Best-effort; budgeted too,
    // because a blocked IndexedDB upgrade (another tab holding the old version) never settles.
    await withBudget(migrateLocalStorageToIdb(), BOOT_BUDGET_MS, undefined)
    const cfg = await loadDeploymentConfigBounded(BOOT_BUDGET_MS)
    applyDeploymentBranding(cfg)
    // station plan calibration (public, offline-cached) — so plans measure out of the box (#3)
    void loadStationPlanScales()
    // …and re-read it whenever this device comes back to the foreground. The document holds
    // STATION data — the Massstab and the Georeferenz of a sheet — which somebody sets on the
    // KP tablet while the phone in the same Einsatz sits in a pocket. The boot load runs once,
    // so without this the other device only learned about it by being restarted.
    // Event-driven on purpose: no interval, no clock, nothing that ticks while the app is idle.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refreshStationPlanScales()
    })
    window.addEventListener('focus', () => { void refreshStationPlanScales() })
    // Resolve the UI language now that the deployment config is in: device pref →
    // deployment locale → de-CH. Runs before first render, so appConfig.copy.* (a getter
    // delegating to config/copy · getCopy) is already in the right language from the first paint.
    applyLocale(cfg.identity?.locale)
  } catch (e) {
    // Boot init must never white-screen the kiosk: fall through to defaults and render.
    console.error('Boot init failed (continuing with defaults):', e)
  }
  // Route without a router lib: /admin renders the lazy admin chunk, everything
  // else is the unchanged field app. Both stay inside <AuthProvider>.
  const isAdmin = window.location.pathname.startsWith('/admin')
  const isCapture = window.location.pathname.startsWith('/e/')
  // The field app is a fixed-height, non-scrolling shell (the map fills the viewport), so
  // `body` carries `overflow: hidden` and `height: 100%`. The capture poster is the opposite:
  // an ordinary page that grows as sections open — and once it grew past the viewport, the part
  // below could not scroll and the unpainted area under the shell showed through WHITE. Mark the
  // document so the stylesheet can let this one page scroll and keep its background.
  if (isCapture) document.documentElement.classList.add('page-scroll')
  const isLink = window.location.pathname.startsWith('/l/')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* Root boundary: login, landing list, overlays, and the admin app used to sit
          OUTSIDE any boundary, so a throw there still white-screened. The inner
          per-incident boundary (App) stays — it recovers without tearing down auth. */}
      <ErrorBoundary>
        {isCapture ? (
          <Suspense fallback={<Splash />}><CaptureApp /></Suspense>
        ) : isLink ? (
          <Suspense fallback={<Splash />}><LinkApp /></Suspense>
        ) : (
          <AuthProvider>
            {isAdmin
              ? <Suspense fallback={<Splash />}><AdminApp /></Suspense>
              : <Gate />}
          </AuthProvider>
        )}
      </ErrorBoundary>
    </StrictMode>,
  )
})()
