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
import { loadDeploymentConfig, applyDeploymentBranding } from './lib/deploymentConfig'
import { migrateLocalStorageToIdb } from './lib/storageMigration'
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

// PWA: register the service worker (precaches the app shell + runtime-caches map tiles
// and reference data so the tool launches and renders offline on station/vehicle tablets).
// registerType 'prompt' → a new build installs and WAITS (no silent mid-incident reload); the
// UpdateBanner surfaces it and the operator applies it. swUpdate also polls hourly so always-on
// tablets that never reload still discover a fresh deploy.
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

// Resolve the deployment config (PUBLIC /api/config) BEFORE first render so per-deployment
// branding/defaults are in place from the very first paint and the synchronous accessor
// (getDeploymentConfig) is already populated when read sites run. The await is bounded by a
// single public fetch and falls back safely on error (offline cache, else {}), so it never
// blocks the launch — no separate splash needed; the auth Gate's /me splash still follows.
void (async () => {
  try {
    // Move operational state (workspace caches, incident list, roster, config, outlines) from
    // localStorage into IndexedDB once, BEFORE anything reads its cache — loadDeploymentConfig's
    // offline fallback and WorkspaceSync.init both now read from IDB. Bounded + best-effort.
    await migrateLocalStorageToIdb()
    const cfg = await loadDeploymentConfig()
    applyDeploymentBranding(cfg)
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
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {/* Root boundary: login, landing list, overlays, and the admin app used to sit
          OUTSIDE any boundary, so a throw there still white-screened. The inner
          per-incident boundary (App) stays — it recovers without tearing down auth. */}
      <ErrorBoundary>
        {isCapture ? (
          <Suspense fallback={<Splash />}><CaptureApp /></Suspense>
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
