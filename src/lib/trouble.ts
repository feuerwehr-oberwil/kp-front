// Trouble log — the trigger for the feedback prompt.
//
// The app already tells the DEPLOYER when something breaks: reportError beacons render throws to
// the station's own `/api/diag/client-error`. What no log can produce is the half sentence only
// the operator has — «ich hab den Trupp gerade auf Rückweg gesetzt, dann war der Bildschirm weg».
// So we remember that something went wrong and ask for that sentence later.
//
// Two rules make this bearable rather than nagging, and both are the 3am tenet applied to
// ourselves:
//
//   1. We only ask when something ACTUALLY went wrong. A prompt after every Einsatz gets
//      dismissed reflexively within three of them, and then the Einstellungen entry is dead too.
//   2. We never ask during an incident. The prompt renders on the launcher only (see
//      FeedbackPrompt) — at 3am with a Trupp inside, the answer to any question is «nein», and
//      asking is exactly the kind of thing the operator must not have to deal with.
//
// localStorage, not IndexedDB: `record()` runs inside componentDidCatch, which cannot await, and
// this is a handful of small records — the same "tiny flags" carve-out lib/crashLoop takes.

const KEY = 'kp-front-trouble'

/** How long a trouble event is worth asking about. Past this the operator won't remember the
 *  Einsatz, let alone what they were tapping, and a vague answer is worse than none. */
export const STALE_MS = 14 * 24 * 60 * 60_000
/** Minimum gap between two prompts, however much breaks in between. */
export const COOLDOWN_MS = 14 * 24 * 60 * 60_000
/** Same kind inside this window is one episode, not two — a crash loop is not five reports. */
export const DEDUPE_MS = 60 * 60_000
/** Keep the log tiny; we only ever ask about the most severe one anyway. */
export const MAX_EVENTS = 5

/** Ordered by how much we want to hear about it — `pickTrouble` asks about the worst one. */
export type TroubleKind = 'crashLoop' | 'crash' | 'storageFull' | 'syncConflict'

const SEVERITY: Record<TroubleKind, number> = {
  crashLoop: 4,
  crash: 3,
  storageFull: 2,
  syncConflict: 1,
}

export interface TroubleEvent {
  kind: TroubleKind
  /** epoch ms */
  at: number
}

export interface TroubleLog {
  events: TroubleEvent[]
  /** epoch ms of the last prompt we showed, for the cooldown. Absent = never asked. */
  askedAt?: number
}

export const EMPTY_LOG: TroubleLog = { events: [] }

/** Fold a new event into the log: drop stale ones, collapse a repeat of the same kind inside
 *  DEDUPE_MS into the newer timestamp, keep the newest MAX_EVENTS. Pure. */
export function foldTrouble(log: TroubleLog, kind: TroubleKind, now: number): TroubleLog {
  const fresh = log.events.filter((e) => now - e.at <= STALE_MS)
  const recentSame = fresh.find((e) => e.kind === kind && now - e.at <= DEDUPE_MS)
  const events = recentSame
    ? fresh.map((e) => (e === recentSame ? { ...e, at: now } : e))
    : [...fresh, { kind, at: now }]
  // newest first, then cap — so the cap drops the oldest, not the one we'd ask about
  events.sort((a, b) => b.at - a.at)
  return { ...log, events: events.slice(0, MAX_EVENTS) }
}

/** The event worth asking about right now, or null. Honours the cooldown and staleness, and
 *  picks the most severe (ties → most recent). Pure, so the policy is testable without a DOM. */
export function pickTrouble(log: TroubleLog, now: number): TroubleEvent | null {
  if (log.askedAt != null && now - log.askedAt < COOLDOWN_MS) return null
  const fresh = log.events.filter((e) => now - e.at <= STALE_MS)
  if (fresh.length === 0) return null
  return fresh.reduce((best, e) => {
    const d = SEVERITY[e.kind] - SEVERITY[best.kind]
    return d > 0 || (d === 0 && e.at > best.at) ? e : best
  })
}

/** Asked (whether or not they answered): start the cooldown and clear the log, so the same
 *  crash can't come back next week. Pure. */
export function markAsked(now: number): TroubleLog {
  return { events: [], askedAt: now }
}

export function readTrouble(): TroubleLog {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return EMPTY_LOG
    const v = JSON.parse(raw) as Partial<TroubleLog>
    if (!Array.isArray(v?.events)) return EMPTY_LOG
    const events = v.events.filter(
      (e): e is TroubleEvent =>
        !!e && typeof e.at === 'number' && typeof e.kind === 'string' && e.kind in SEVERITY,
    )
    return { events, ...(typeof v.askedAt === 'number' ? { askedAt: v.askedAt } : {}) }
  } catch {
    return EMPTY_LOG // unreadable storage (private mode) → no history, never throw
  }
}

function write(log: TroubleLog): void {
  try { localStorage.setItem(KEY, JSON.stringify(log)) } catch { /* best-effort */ }
}

/** Note that something went wrong. Never throws — this runs on the crash path. */
export function recordTrouble(kind: TroubleKind, now: number = Date.now()): void {
  try { write(foldTrouble(readTrouble(), kind, now)) } catch { /* diagnostics must never throw */ }
}

/** Start the cooldown after a prompt was shown. */
export function markTroubleAsked(now: number = Date.now()): void {
  write(markAsked(now))
}
