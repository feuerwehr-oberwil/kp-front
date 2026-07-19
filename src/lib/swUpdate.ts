// Service-worker lifecycle. registerType is 'prompt' (vite.config.ts): a new build does NOT
// silently take over mid-work — it installs and WAITS, so the running app is never reloaded
// out from under an operator mid-incident (the 3am rule: nothing surprising). Two surfaces:
//   · Boot window: an update discovered right after page load, before any interaction, is
//     applied silently — nothing is in progress yet, so the reload is invisible and simply
//     reopening the app after a deploy auto-updates.
//   · Mid-session: a waiting build is only ANNOUNCED via onUpdateAvailable (UpdateBanner:
//     «wird beim nächsten Start aktiv»). There is deliberately NO in-place «Neu laden»
//     any more: the skipWaiting+reload dance proved unreliable on iOS standalone (the
//     waiting worker wedges and the reload lands back on the old build — field reports
//     2026-07-08/09), while fully closing and reopening the app always activates the
//     waiting build cleanly. The banner tells the operator exactly that. (There is no
//     manual "check for updates" — the 5-min poll + visibility-resume check discover
//     deploys automatically.)
// Silent applies go through applySilently(); a watchdog forces the reload if the SW
// 'controlling' event never delivers one — vite-plugin-pwa's updateSW() only POSTS
// skipWaiting. They share a localStorage-backed attempt budget (updatePolicy): iOS
// standalone can wedge a waiting worker so activation never happens, and can also reset
// sessionStorage across the watchdog's forced reloads, which made a session-scoped retry
// cap useless (field report 2026-07-08). A silent apply that never lands surrenders to
// the banner — the operator keeps a working (old) build plus the restart hint.
import { registerSW } from 'virtual:pwa-register'
import { autoApplyBudgetLeft, recordAutoApply, RELOAD_WATCHDOG_MS, RESUME_CHECK_MIN_GAP_MS, shouldAutoApply, type AutoApplyRecord } from './updatePolicy'
import { BUILD_TIME, GIT_SHA } from './buildInfo'

// Build identity for the landed-vs-stalled comparison. The git sha ALONE is not enough:
// Docker/Railway builds have no .git (dockerignored), so every prod build reported
// GIT_SHA='dev' — a landed update then compared dev===dev, was misdiagnosed as STALLED,
// the «Aktualisiert» toast never fired, and the auto-apply budget was never reset. After
// enough deploys in one 6 h window the budget ran dry and every reload showed the banner
// (field report 2026-07-18). BUILD_TIME is stamped per `vite build`, so this is unique
// per deployable build even without git.
const BUILD_ID = `${GIT_SHA}@${BUILD_TIME}`

// 5 min, not hourly: with no manual check, an app that stays FOREGROUNDED (active incident,
// desk testing) discovers a deploy only through this poll — the visibility-resume check never
// fires. The check is a conditional GET of sw.js (304 when unchanged), so the cost is nil.
const UPDATE_INTERVAL_MS = 5 * 60 * 1000
// stamped with the OLD build's git sha before the update reload; consumed at next boot to
// tell a real update (sha changed) from a STALLED one (same sha — iOS sometimes never
// activates the waiting worker, so the watchdog reload lands back on the old build).
// localStorage, not sessionStorage: iOS standalone reloads may open a fresh session.
const JUST_UPDATED_KEY = 'kp-sw-just-updated'
const ATTEMPTS_KEY = 'kp-sw-auto-attempts'    // persisted automatic-apply budget (see updatePolicy)

const readAttempts = (): AutoApplyRecord | null => {
  try {
    const v = localStorage.getItem(ATTEMPTS_KEY)
    return v ? (JSON.parse(v) as AutoApplyRecord) : null
  } catch {
    // storage unreadable (private mode) → report an exhausted budget: with no way to COUNT
    // attempts, automatic applies could loop — the banner path stays available
    return { n: Number.MAX_SAFE_INTEGER, at: Date.now() }
  }
}
const spendAttempt = () => {
  try { localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(recordAutoApply(readAttempts(), Date.now()))) } catch { /* ignore */ }
}

let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null
let registration: ServiceWorkerRegistration | undefined
let updateWaiting = false
let applying = false
let notify: ((available: boolean) => void) | null = null
let loadedAt = 0
let interacted = false

// One boot-time read of the pre-reload stamp: same build ⇒ the apply STALLED (we're still
// on the old build); different build ⇒ the update landed (drives the «Aktualisiert» toast).
const bootStamp = ((): string | null => {
  try {
    const v = localStorage.getItem(JUST_UPDATED_KEY)
    localStorage.removeItem(JUST_UPDATED_KEY)
    return v
  } catch { return null }
})()
const stalledUpdate = bootStamp === BUILD_ID
const landedUpdate = bootStamp != null && bootStamp !== BUILD_ID
// a landed update proves activation works — reset the attempt budget for the next deploy
if (landedUpdate) { try { localStorage.removeItem(ATTEMPTS_KEY) } catch { /* ignore */ } }

export function initServiceWorker() {
  loadedAt = Date.now()
  const markInteracted = () => { interacted = true }
  window.addEventListener('pointerdown', markInteracted, { once: true, capture: true })
  window.addEventListener('keydown', markInteracted, { once: true, capture: true })
  updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, r) {
      registration = r
      if (!r) return
      // No worker waiting at boot ⇒ whatever update the attempt record belonged to has
      // RESOLVED (activated via full restart, or never existed) — a leftover budget would
      // only block the NEXT deploy's silent apply (dense-deploy days burned it and every
      // reload showed the banner). A truly wedged worker is still waiting here, so the
      // reload-loop protection is untouched.
      if (!r.waiting) { try { localStorage.removeItem(ATTEMPTS_KEY) } catch { /* ignore */ } }
      // Stalled-update recovery: the previous page life stamped an apply, but we booted into
      // the SAME build with the new worker still waiting (iOS occasionally never activates it
      // in-page — the operator used to be stuck on «Neue Version wird geladen» until they
      // killed the app). Right after a fresh navigation the activation reliably goes through,
      // so re-post SKIP_WAITING directly and let the applyUpdate listener reload. Capped so a
      // pathologically stuck worker can never reload-loop.
      // deploy polling is set up FIRST, unconditionally — the stalled-recovery path below
      // used to return early without it, leaving a recovered-but-stale app deaf to deploys
      let lastCheck = Date.now()
      // never check mid-apply: a poll that installs yet ANOTHER worker while an apply's
      // skipWaiting/reload is in flight races the activation (iOS freeze reports 2026-07-18)
      const check = () => { if (applying) return; lastCheck = Date.now(); r.update().catch(() => { /* offline — retry next tick */ }) }
      setInterval(check, UPDATE_INTERVAL_MS)
      // A tablet waking from standby shouldn't wait up to an hour to hear about a deploy.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - lastCheck > RESUME_CHECK_MIN_GAP_MS) check()
      })
      // The announced build can take over without this page applying it — another window
      // of the app applies it, or a late activation lands after a surrendered stall. The
      // moment the new worker controls the page the pending update is resolved (a plain
      // next start now activates it trivially), so RETRACT the banner instead of keeping
      // an «Update verfügbar» for a version that is already in charge. The applying path
      // reloads on this same event before the check below runs.
      navigator.serviceWorker?.addEventListener('controllerchange', () => {
        if (!applying && updateWaiting) {
          updateWaiting = false
          notify?.(false)
          // the new worker taking over proves activation works on this device — earn the
          // next deploy a fresh automatic-apply budget, same as a landed silent update
          try { localStorage.removeItem(ATTEMPTS_KEY) } catch { /* ignore */ }
        }
      })
      if (stalledUpdate && r.waiting) {
        updateWaiting = true
        if (autoApplyBudgetLeft(readAttempts(), Date.now())) {
          spendAttempt()
          void applySilently()
        } else {
          // budget exhausted — this waiting worker is wedged. Boot NORMALLY on the old
          // build and let the banner offer a manual retry (a later deploy, an app restart,
          // or the budget window expiring all earn a fresh automatic attempt).
          notify?.(true)
        }
      }
    },
    onNeedRefresh() {
      // A new build finished installing and is waiting.
      updateWaiting = true
      const budgetLeft = autoApplyBudgetLeft(readAttempts(), Date.now())
      if (shouldAutoApply({ msSinceLoad: Date.now() - loadedAt, interacted, alreadyAutoApplied: !budgetLeft })) {
        spendAttempt()
        void applySilently()
        return
      }
      // Mid-session: never apply — announce it. The banner explains that the new version
      // becomes active on the next app start (full close + reopen).
      notify?.(true)
    },
  })
}

/** Is a newer build installed and waiting to be applied? */
export function isUpdateAvailable(): boolean {
  return updateWaiting
}

/** Subscribe to the pending-update state: `cb(true)` when a new build is waiting (fires
 *  immediately if one already is), `cb(false)` when the wait resolves without us (the
 *  worker activated) so the banner retracts. Returns an unsubscribe. Single subscriber by
 *  design — the app mounts exactly one UpdateBanner. */
export function onUpdateAvailable(cb: (available: boolean) => void): () => void {
  notify = cb
  if (updateWaiting) cb(true)
  return () => { if (notify === cb) notify = null }
}

/** Apply the waiting build silently: skipWaiting + reload the page. Only the automatic
 *  boot-window and stalled-recovery paths call this — there is no operator-facing apply
 *  any more (the banner just announces the next-start activation). Never shows a blocking
 *  cover, so a wedged worker can only cost brief reload flickers. No-op if nothing is
 *  waiting or an apply is already in flight. */
async function applySilently(): Promise<void> {
  if (!updateSW || !updateWaiting || applying) return
  applying = true
  // stamp the CURRENT (old) build id — the next boot compares it to its own to tell
  // "update landed" from "activation stalled, still the old build"
  try { localStorage.setItem(JUST_UPDATED_KEY, BUILD_ID) } catch { /* no confirmation toast then */ }
  // Own the reload — and issue it exactly ONCE. Three triggers used to race here (this
  // controllerchange listener, the watchdog below, and vite-plugin-pwa's internal reload
  // from updateSW(true)); on iOS standalone a second location.reload() fired while the
  // first navigation is committing can blank/freeze the webview (field reports
  // 2026-07-18: app frozen right after an update). So: updateSW(false) only posts
  // skipWaiting, and every reload goes through the guarded reloadOnce(). First controller
  // change → reload (the normal path, sub-second). Watchdog: if nothing happened after
  // RELOAD_WATCHDOG_MS, re-post SKIP_WAITING straight to the waiting worker (the
  // vite/workbox message can get lost in an activation stall), give it a beat, reload.
  let reloadStarted = false
  const reloadOnce = () => {
    if (reloadStarted) return
    reloadStarted = true
    window.location.reload()
  }
  navigator.serviceWorker?.addEventListener('controllerchange', reloadOnce, { once: true })
  window.setTimeout(() => {
    if (reloadStarted) return // a reload is already committing — don't kick the worker again
    try { registration?.waiting?.postMessage({ type: 'SKIP_WAITING' }) } catch { /* reload regardless */ }
    window.setTimeout(reloadOnce, 600)
  }, RELOAD_WATCHDOG_MS)
  // Final backstop: if we are STILL executing this page after the watchdog's forced reload
  // (iOS standalone has been seen to swallow location.reload() during an activation stall),
  // surrender — clear the apply, un-stamp, and surface the banner: the operator keeps a
  // working (old) build plus the restart hint, which is the path that always works. A reload
  // that merely takes long is fine: this timer dies with the page the moment one lands.
  window.setTimeout(() => {
    applying = false
    reloadStarted = false // a later manual/retry path may reload again
    try { localStorage.removeItem(JUST_UPDATED_KEY) } catch { /* stale stamp is handled at boot */ }
    notify?.(true)
  }, RELOAD_WATCHDOG_MS + 4_000)
  await updateSW(false)
}

/** Did the previous page life end in an update reload that actually LANDED (new build)?
 *  One-shot semantics via the boot-time stamp read — the caller shows the "Aktualisiert"
 *  confirmation toast exactly once. A stalled apply (same build) returns false, so the
 *  toast can never congratulate an update that didn't happen. */
let justUpdatedConsumed = false
export function consumeJustUpdated(): boolean {
  if (justUpdatedConsumed) return false
  justUpdatedConsumed = true
  return landedUpdate
}
