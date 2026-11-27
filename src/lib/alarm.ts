// Reusable escalating alarm tone — Web Audio, dependency-free (no asset files, so
// it works offline on station/vehicle tablets). Intended for the SCBA (Atemschutz)
// time/pressure warnings, but generic: any feature can prime + start + stop it.
//
// AUTOPLAY UNLOCK: browsers start an AudioContext "suspended" and refuse to make
// sound until it is resumed inside a real user gesture (tap/click/keydown). So
// `primeAudio()` must run inside such a gesture once. The first tap ANYWHERE in the app does
// it (`armOnAnyTap`, mounted by App; owner pick UX journeys M·3, 25.11.2026), with a short
// «Alarmton an» toast once that tap is over and no layer is open (the tap still does its own job). It replaces the
// rule that only «Einsatz starten / öffnen», the Trupp-Formular and a tap on the Tafel unlocked
// it (App · selectIncident, 2026-08): after a reload of a running Einsatz an überfällig alarm
// stayed silent until somebody happened to touch one of those. After that the `Alarm` can sound later without interaction. Whether it worked is
// readable via `audioUnlocked()`, so the bell can say "Ton nicht freigegeben" instead of
// claiming to be armed.
//
// THE ONE ALARM LAYER: time-based alerts (Atemschutz
// clock, reminders, a new alarm) go through this shared layer, not ad-hoc timers. Two voices, one
// per level (FEEDBACK.10, 17.11.2026 – the faster square beeper `startAlarm` that a due
// Wiedervorlage still used is gone), and the calm one comes in two shapes:
//   - `Alarm` – the Atemschutz alarm, the LOUDEST thing the app says: square pip 820 Hz every
//     2.4 s at Kontakt fällig / Alarmdruck, a 1100 Hz double pip every 1.5 s at überfällig /
//     Notfall, with vibration and the wake-lock;
//   - `chime()` – one soft 660 Hz sine pip: «something is due», calm. A due Wiedervorlage rings it
//     once (useReminders · RemindersHost), and so does a station's opt-in «Kontakt fällig».
//   - `arrivalTone()` – the chime's voice, three rising pips: a new alarm row on the Karte home
//     (owner pick UX journeys B3·7, 25.11.2026; lib/useArrivalTone).
// Nothing louder than the Atemschutz warn may ever be added for a non-safety reminder. Delivery: foreground
// tone/wake-lock + service-worker notification, plus – once the deployment sets VAPID keys
// (`app.gen_vapid`) – server-side Web Push for killed apps: `backend/app/push.py` re-derives
// due-ness from the synced data (no mirror API) and also pushes «Neuer Einsatz» when a new
// Divera alarm lands in the pool. Fail-closed: no keys → `/api/push/vapid-key` serves `null`
// and no sweep runs. Every stamp counts in `serverNow()` (`lib/serverClock`).

let ctx: AudioContext | null = null

// Fan-out for the context's `statechange` — subscribed BEFORE the context exists (the bell
// mounts long before the first Einsatz tap primes audio), so the listeners live here and the
// one DOM listener is attached the moment the context is built.
const stateListeners = new Set<() => void>()

function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const Ctor =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null // no Web Audio (SSR / very old browser) — fail silent
  ctx = new Ctor()
  ctx.addEventListener('statechange', () => { for (const fn of stateListeners) fn() })
  return ctx
}

/**
 * Try to get the context running. `resume()` on anything that is not `running`: browsers
 * start `suspended`, and WebKit ALSO reports the non-standard `'interrupted'` after a phone
 * call, Siri or another app taking the audio session — and does not resume a page that was in
 * the background when the interruption ended. Resuming only on `'suspended'` left the tone
 * silent while the bell still said «an». A rejected resume (closed context) is swallowed.
 */
function resumeIfNeeded(c: AudioContext): void {
  if (c.state !== 'running') void c.resume().catch(() => {})
}

/**
 * Unlock audio from within a user gesture. Resumes a suspended AudioContext so a
 * later alarm or chime (which may fire with no interaction) is allowed to play.
 * Safe to call repeatedly; returns true once an AudioContext is running.
 */
export function primeAudio(): boolean {
  const c = getCtx()
  if (!c) return false
  resumeIfNeeded(c)
  return c.state !== 'closed'
}

/**
 * Subscribe to the AudioContext's state transitions (`statechange`). Fires on the unlock
 * itself and whenever the OS takes the audio session away, so a caller showing «Ton nicht
 * freigegeben» can re-read `audioUnlocked()` instead of polling. Returns the unsubscribe.
 * Never creates a context (see `audioUnlocked`).
 */
export function onAudioState(fn: () => void): () => void {
  stateListeners.add(fn)
  return () => { stateListeners.delete(fn) }
}

/**
 * Can the tone actually be heard right now? True only once an AudioContext exists AND is
 * running — i.e. the browser released audio inside a user gesture.
 *
 * ⚠️ Never CREATES a context: this is a read-out, and a read-out must not have a side effect.
 * "No context yet" is honestly "not unlocked", which is exactly what the caller has to show.
 */
export function audioUnlocked(): boolean {
  return ctx?.state === 'running'
}

/** A single soft pip (one-shot sine) — the calm «something is due» voice: a due Wiedervorlage
 *  (useReminders · RemindersHost) and the amber «Kontakt fällig» cue when a station opts in
 *  (atemschutz.contactDueChime). Distinct from the looping Atemschutz `Alarm`; its own
 *  short-lived nodes. No-op if audio isn't unlocked. */
export function chime() {
  const c = getCtx()
  if (!c || c.state !== 'running') return
  sinePip(c, 660, c.currentTime)
}

/** The «Neuer Alarm» voice (owner pick UX journeys B3·7, 25.11.2026): three rising sine pips
 *  (660 · 880 · 1100 Hz, 0.18 s apart), once per alarm, on the Karte home – App ·
 *  useArrivalTone. The chime's soft sine at the chime's gain, so it stays below the Atemschutz
 *  `Alarm` (the rule in the header). No-op if audio isn't unlocked. */
export function arrivalTone() {
  const c = getCtx()
  if (!c || c.state !== 'running') return
  const t = c.currentTime
  ;[660, 880, 1100].forEach((f, i) => sinePip(c, f, t + i * 0.18))
}

/** One soft sine pip at `freq`, starting at `t` – its own short-lived nodes. */
function sinePip(c: AudioContext, freq: number, t: number) {
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = 'sine'
  o.frequency.value = freq
  o.connect(g).connect(c.destination)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
  o.start(t)
  o.stop(t + 0.22)
}

/** Prime audio from a user gesture so a later alarm tone may play (alias of primeAudio,
 *  named for the Atemschutz call sites that "unlock" the alarm on the first wizard tap). */
export function unlockAlarm() {
  primeAudio()
}

/** The events that count as a user gesture for audio. `pointerdown` alone is not enough: for a
 *  finger, the HTML spec's user activation comes with `pointerup` / `touchend`, not with the
 *  press, so a tablet needs those too. Each one primes only while the tone is still off.
 *  `pointercancel` is no gesture: it only ends a press (a drag the browser took over). */
const GESTURES = ['pointerdown', 'pointerup', 'pointercancel', 'touchend', 'click', 'keydown'] as const

/** How long `onArmed` waits after the finger lifts. A touch's `click` comes after its
 *  `pointerup`, and whatever appears under the finger before that takes the tap. */
const SETTLE_MS = 300

/**
 * Arm the tone with the first tap anywhere in the app (owner pick UX journeys M·3, 25.11.2026).
 * Listens on the document in the capture phase, so no surface can swallow the tap first. Every
 * gesture while the tone is off primes it; `onArmed` runs each time the context reaches
 * `running` because of such a prime (App shows «Alarmton an»). It keeps listening after that: an
 * interruption (a call, Siri) stops the context again, and the next tap brings it back.
 * ⚠️ `onArmed` runs only once the arming tap is over (no pointer down, SETTLE_MS after the
 * last lift): the first tap must still do its own job. A toast shown on the `pointerdown` stood
 * under the finger, took the `pointerup`, and the tap's `click` never reached the Karte search
 * row it was meant for (PR #752's CI, 25.11.2026).
 * ⚠️ The tap PRIMES the tone everywhere, but App's «Alarmton an» shows only when no sheet,
 * composer or dialog is open at that moment (lib/useArmOnAnyTap · overlays/layer · layerOpen).
 * Inside a layer it stays silent – the tone works either way. A pill over the composer took the
 * next «Erfassen» tap (e2e F8; lead's call, 25.11.2026).
 * ⚠️ The tone can be running before the arming tap's `click`: a control that shows the audio
 * state must decide on the press what that click does. The bell's «Ton freigeben» muted the tone
 * it had just unlocked (AtemschutzView · bellClick, Üben clip 5.4, 27.11.2026). Returns the uninstall.
 */
export function armOnAnyTap(onArmed: () => void): () => void {
  // a prime was sent and the context has not reported `running` yet (resume is async)
  let waiting = false
  // the context is running; `onArmed` waits for the tap to end
  let due = false
  let pressed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const settle = () => {
    clearTimeout(timer)
    if (due && !pressed) timer = setTimeout(() => { due = false; onArmed() }, SETTLE_MS)
  }
  const armed = () => { waiting = false; due = true; settle() }
  const onGesture = (e: Event) => {
    if (e.type === 'pointerdown') { pressed = true; clearTimeout(timer) }
    if (e.type === 'pointerup' || e.type === 'pointercancel') { pressed = false; settle() }
    if (audioUnlocked() || !primeAudio()) return
    // a context created inside the gesture can be running at once, with no statechange to follow
    if (audioUnlocked()) armed(); else waiting = true
  }
  const off = onAudioState(() => {
    if (waiting && audioUnlocked()) armed()
  })
  for (const e of GESTURES) document.addEventListener(e, onGesture, { capture: true, passive: true })
  return () => {
    off()
    clearTimeout(timer)
    for (const e of GESTURES) document.removeEventListener(e, onGesture, { capture: true })
  }
}

// --- OS notification delivery (shared by Atemschutz + Wiedervorlagen) ---------------------
//
// The in-page tone + wake-lock above only reach someone looking at the tablet. This adds the
// background channel: a system notification shown through the active service-worker
// registration, so a due Wiedervorlage or an überfällig Atemschutztrupp surfaces in the OS
// tray even when the PWA is backgrounded (another app on top) or the screen is off.
//
// SCOPE/LIMIT: this fires while the app (or its SW) is still alive. A notification for a
// moment when the app has been fully KILLED comes from server-side Web Push instead — the
// backend sweep (backend/app/push.py) pushes to browsers registered via src/lib/push.ts,
// reusing the same tags so tray entries coalesce. Callers keep driving the in-app
// banner/tone as the primary channel and treat both notification paths as best-effort.

/** True once the user has granted notification permission. */
export function notificationsAllowed(): boolean {
  try {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted'
  } catch {
    return false
  }
}

/**
 * Whether this browser can EVER show an OS notification, permission aside — false on iOS/iPadOS
 * Safari unless the page has been added to the Home Screen (the `Notification` global does not
 * exist in a plain Safari tab there at all, iOS 16.4+ included). Distinct from
 * `notificationsAllowed` (permission not yet decided still answers true here): a bell showing
 * «Ton nicht freigegeben, sonst meldet die Benachrichtigung» is only honest where a
 * notification could fire at all — on an unsupported browser NOTHING will alert until the tone
 * itself is unlocked, and the bell has to say exactly that instead (AtemschutzView · bellLabel).
 */
export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined'
}

/**
 * Ask for notification permission. MUST be called from a user gesture (button tap) or the
 * browser ignores it. Safe to call repeatedly; resolves true once granted, false if denied
 * or unsupported. No-op (returns current state) when already decided.
 */
export async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (typeof Notification === 'undefined') return false
    if (Notification.permission === 'denied') return false
    const granted =
      Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted'
    if (granted) {
      // permission in hand → register this browser for server push (killed-app alarms).
      // Lazy import: alarm.ts is loaded early, the push plumbing only matters post-grant.
      void import('./push').then((m) => m.ensurePushSubscription(true)).catch(() => {})
    }
    return granted
  } catch {
    return false
  }
}

/**
 * Show a system notification (best-effort). Prefers the service-worker registration so it
 * works when the page is backgrounded; falls back to a page Notification. `tag` coalesces
 * repeat alerts for the same reminder/Trupp into one tray entry instead of stacking.
 */
export async function notify(title: string, opts: { body?: string; tag?: string; renotify?: boolean; target?: string } = {}): Promise<void> {
  if (!notificationsAllowed()) return
  const options: NotificationOptions = {
    body: opts.body,
    tag: opts.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Android honours this on the tray notification itself — a second, OS-level vibration
    // channel independent of the in-page Alarm class below (which cannot run once the tab is
    // backgrounded). Unknown/unsupported elsewhere (iOS has neither `Notification` in a plain
    // Safari tab nor the property): ignored by spec, not an error.
    vibrate: [200, 100, 200],
    // carried into the SW notificationclick handler so a tap opens the right tab
    ...(opts.target ? { data: { target: opts.target } } : {}),
    // renotify needs a tag; re-alert (sound/vibrate) even when coalescing onto an existing tag
    ...(opts.tag ? { renotify: opts.renotify ?? true } : {}),
  } as NotificationOptions
  try {
    const sw = navigator.serviceWorker
    if (sw) {
      const reg = await sw.ready
      await reg.showNotification(title, options)
      return
    }
  } catch {
    /* fall through to page Notification */
  }
  try {
    new Notification(title, options)
  } catch {
    /* unsupported / not permitted — the in-app banner remains the primary channel */
  }
}

/**
 * Escalating beeper for the Atemschutz contact-timer alarm, as a small stateful object so the
 * view can drive it from a single peak severity per tick: level 0 = silent, 1 = warn (Kontakt
 * fällig — slow single beep), 2 = critical (überfällig — fast double beep, higher pitch).
 *
 * Holds a screen wake-lock while active so the Überwachungstafel stays lit at the scene.
 * `muted` keeps the wake-lock + (caller's) visual alarm but suppresses the tone, for
 * radio-heavy / silent-mode environments.
 */
export class Alarm {
  private level = 0
  private muted = false
  private timer: ReturnType<typeof setInterval> | null = null
  private wake: WakeLockSentinel | null = null

  /** Mute/unmute the tone without changing the level (wake-lock stays as-is). */
  setMuted(muted: boolean) {
    if (muted === this.muted) return
    this.muted = muted
    this.reschedule()
  }

  /** Set the alarm severity; re-schedules the repeating tone if it changed. */
  set(level: number) {
    if (level === this.level) return
    this.level = level
    this.reschedule()
    if (level > 0) void this.acquireWake()
    else this.releaseWake()
  }

  stop() {
    this.level = 0
    if (this.timer != null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.releaseWake()
  }

  private reschedule() {
    if (this.timer != null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.level <= 0 || this.muted) return
    // a calmer cadence than a frantic beeper — still clearly an alarm, less nagging
    const periodMs = this.level >= 2 ? 1500 : 2400
    this.pip() // fire immediately, then repeat
    this.timer = setInterval(() => this.pip(), periodMs)
  }

  private pip() {
    const c = getCtx()
    if (!c) return
    resumeIfNeeded(c) // every pip retries — an interrupted context comes back on the next beat
    const critical = this.level >= 2
    // softer pitch + gentler gain than the old piercing beeper (kept a double-pip so it still
    // reads as an urgent alarm, not a notification blip)
    const freq = critical ? 1100 : 820
    const pips = critical ? 2 : 1
    const t0 = c.currentTime
    for (let i = 0; i < pips; i++) {
      const start = t0 + i * 0.22
      const o = c.createOscillator()
      const g = c.createGain()
      o.type = 'square'
      o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime(0.14, start + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.16)
      o.connect(g).connect(c.destination)
      o.start(start)
      o.stop(start + 0.18)
    }
    // Same cadence, the device's own channel: on hardware/browsers that support it (Android
    // Chrome, most desktops with the API but no motor — a harmless no-op there) this fires
    // alongside every tone repeat, not just the OS notification's one-shot pattern above. iOS
    // has never exposed the Vibration API to Safari (Home button or not) — `'vibrate' in
    // navigator` is simply false there, so this silently does nothing rather than throwing.
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try { navigator.vibrate(critical ? [120, 90, 120] : [90]) } catch { /* unsupported / blocked */ }
    }
  }

  // keep the screen awake while an alarm is active (best-effort; minimal). The OS silently
  // releases the lock whenever the tab is hidden, so we re-acquire on visibilitychange while
  // the alarm is still active (same approach as useWakeLock).
  private onVisibility = () => {
    if (document.visibilityState === 'visible' && this.level > 0) void this.acquireWake()
  }
  private async acquireWake() {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } }
      if (!nav.wakeLock) return // API unavailable (older browsers, insecure context)
      // idempotent for the same handler reference — safe to (re-)add on every acquire
      document.addEventListener('visibilitychange', this.onVisibility)
      // a hidden tab can't hold the lock; the visibility listener retries on foreground
      if (document.visibilityState !== 'visible') return
      if (this.wake && !this.wake.released) return
      const s = await nav.wakeLock.request('screen')
      if (this.level <= 0) {
        // alarm stopped mid-request — release immediately
        void s.release().catch(() => {})
        return
      }
      this.wake = s
    } catch {
      /* ignore — non-essential (request can reject, e.g. low battery) */
    }
  }
  private releaseWake() {
    document.removeEventListener('visibilitychange', this.onVisibility)
    try {
      void this.wake?.release()
    } catch {
      /* ignore */
    }
    this.wake = null
  }
}
