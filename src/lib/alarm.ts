// Reusable escalating alarm tone — Web Audio, dependency-free (no asset files, so
// it works offline on station/vehicle tablets). Intended for the SCBA (Atemschutz)
// time/pressure warnings, but generic: any feature can prime + start + stop it.
//
// AUTOPLAY UNLOCK: browsers start an AudioContext "suspended" and refuse to make
// sound until it is resumed inside a real user gesture (tap/click/keydown). So the
// caller must invoke `primeAudio()` from such a gesture once (e.g. the "Einsatz
// starten" button) — after that `startAlarm()` can fire later without interaction.

type AlarmLevel = 'warn' | 'critical'

interface ToneSpec {
  freq: number // oscillator pitch (Hz)
  beepMs: number // length of each beep
  gapMs: number // silence between beeps
  gain: number // peak volume 0..1
}

// critical = higher, faster, louder than warn
const TONES: Record<AlarmLevel, ToneSpec> = {
  warn: { freq: 660, beepMs: 220, gapMs: 380, gain: 0.18 },
  critical: { freq: 920, beepMs: 150, gapMs: 130, gain: 0.32 },
}

let ctx: AudioContext | null = null
let osc: OscillatorNode | null = null
let gainNode: GainNode | null = null
let timer: ReturnType<typeof setInterval> | null = null

function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const Ctor =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null // no Web Audio (SSR / very old browser) — fail silent
  ctx = new Ctor()
  return ctx
}

/**
 * Unlock audio from within a user gesture. Resumes a suspended AudioContext so a
 * later `startAlarm()` (which may fire with no interaction) is allowed to play.
 * Safe to call repeatedly; returns true once an AudioContext is running.
 */
export function primeAudio(): boolean {
  const c = getCtx()
  if (!c) return false
  if (c.state === 'suspended') void c.resume().catch(() => {})
  return c.state !== 'closed'
}

/**
 * Start (or switch) a looping beep at the given level. Re-calling with a new level
 * escalates without a gap. No-op if Web Audio is unavailable.
 */
export function startAlarm(level: AlarmLevel = 'warn') {
  const c = getCtx()
  if (!c) return
  if (c.state === 'suspended') void c.resume().catch(() => {})

  const spec = TONES[level]

  if (!osc) {
    osc = c.createOscillator()
    gainNode = c.createGain()
    gainNode.gain.value = 0 // start silent; the beat envelope ramps it
    osc.connect(gainNode).connect(c.destination)
    osc.type = 'square'
    osc.start()
  }
  osc.frequency.setValueAtTime(spec.freq, c.currentTime)

  if (timer) clearInterval(timer)
  const beat = () => {
    if (!gainNode || !ctx) return
    const t = ctx.currentTime
    // quick attack/decay click-free envelope for one beep
    gainNode.gain.cancelScheduledValues(t)
    gainNode.gain.setValueAtTime(0.0001, t)
    gainNode.gain.exponentialRampToValueAtTime(spec.gain, t + 0.01)
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + spec.beepMs / 1000)
  }
  beat()
  timer = setInterval(beat, spec.beepMs + spec.gapMs)
}

/** A single soft pip (one-shot sine) — the amber «Kontakt fällig» cue when a station opts in
 *  (atemschutz.contactDueChime). Distinct from the looping überfällig alarm; uses its own
 *  short-lived nodes so it never touches the alarm oscillator. No-op if audio isn't unlocked. */
export function chime() {
  const c = getCtx()
  if (!c || c.state !== 'running') return
  const t = c.currentTime
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = 'sine'
  o.frequency.value = 660
  o.connect(g).connect(c.destination)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
  o.start(t)
  o.stop(t + 0.22)
}

/** Stop the alarm and silence the oscillator. Safe to call when nothing is playing. */
export function stopAlarm() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (gainNode && ctx) {
    const t = ctx.currentTime
    gainNode.gain.cancelScheduledValues(t)
    gainNode.gain.setValueAtTime(0.0001, t)
  }
  if (osc) {
    try {
      osc.stop()
    } catch {
      /* already stopped */
    }
    try {
      osc.disconnect()
    } catch {
      /* ignore */
    }
    osc = null
  }
  gainNode = null
}

/** Prime audio from a user gesture so a later alarm tone may play (alias of primeAudio,
 *  named for the Atemschutz call sites that "unlock" the alarm on the first wizard tap). */
export function unlockAlarm() {
  primeAudio()
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
    if (c.state === 'suspended') void c.resume().catch(() => {})
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
  }

  // keep the screen awake while an alarm is active (best-effort; minimal)
  private async acquireWake() {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } }
      if (!this.wake && nav.wakeLock) this.wake = await nav.wakeLock.request('screen')
    } catch {
      /* ignore — non-essential */
    }
  }
  private releaseWake() {
    try {
      void this.wake?.release()
    } catch {
      /* ignore */
    }
    this.wake = null
  }
}
