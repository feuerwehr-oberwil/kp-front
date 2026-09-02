// Crash-loop detection for the incident workspace.
//
// The ErrorBoundary deliberately never clears persisted state, and its only action used to be
// `location.reload()`. But boot AUTO-REOPENS the last incident (pickBootIncident, which falls
// back to the first open one even with no remembered id), so a render throw that comes from
// that incident's own data turns «Neu laden» into a loop the operator cannot leave: the landing
// list is unreachable while an incident is active, and the only cache-clearing UI lives behind
// /admin. Worse, the poison can sit in the SERVER-side workspace blob, so it reaches every
// device and clearing browser data doesn't help either.
//
// So we count crashes per incident across reloads. The first crash offers the lossless escape
// (close the incident → land on the launcher). A repeat crash on the SAME incident within the
// window means reopening won't help, and only then do we offer the destructive one (discard the
// local cached copy and re-pull from the server).
//
// localStorage, not IndexedDB: this must be readable and writable synchronously from inside
// componentDidCatch, and it's a tiny counter — exactly the "tiny flags" carve-out.

const KEY = 'kp-front-crash'
/** Crashes further apart than this are unrelated incidents, not a loop. */
export const CRASH_WINDOW_MS = 5 * 60_000
/** How long an incident must stay up before App forgets its streak (it also forgets on a clean
 *  switch or close). Deliberately LONGER than the window: a crash that only happens once some
 *  surface is opened — minutes after the reload that reproduces it — must still find its
 *  predecessor, or the count restarts at one on every round and the destructive recovery is
 *  never offered for a loop that is real. */
export const CRASH_HEALTHY_MS = 10 * 60_000

export interface CrashRecord {
  /** incident id that crashed (or '' for a crash outside any incident) */
  id: string
  /** consecutive crashes for this id inside the window */
  n: number
  /** epoch ms of the most recent crash */
  at: number
}

/** Fold a new crash into the previous record. Pure. A crash on a DIFFERENT incident, or one
 *  outside the window, restarts the count at 1 rather than inheriting a stale streak. */
export function foldCrash(prev: CrashRecord | null, id: string, now: number): CrashRecord {
  const continues = prev != null && prev.id === id && now - prev.at <= CRASH_WINDOW_MS
  return { id, n: continues ? prev.n + 1 : 1, at: now }
}

/** Has this id crashed more than once in the window? Then reloading into it is futile and the
 *  destructive recovery is worth offering. Pure. */
export function isLooping(rec: CrashRecord | null, id: string, now: number): boolean {
  return rec != null && rec.id === id && rec.n >= 2 && now - rec.at <= CRASH_WINDOW_MS
}

export function readCrash(): CrashRecord | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<CrashRecord>
    return typeof v?.id === 'string' && typeof v.n === 'number' && typeof v.at === 'number'
      ? { id: v.id, n: v.n, at: v.at }
      : null
  } catch {
    return null // unreadable storage (private mode) → treat as "no history", never throw
  }
}

/** Record a crash for `id` and return the folded record (so the caller can branch on `n`
 *  immediately, without a second read). Never throws — this runs inside componentDidCatch. */
export function recordCrash(id: string, now: number = Date.now()): CrashRecord {
  const next = foldCrash(readCrash(), id, now)
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* best-effort */ }
  return next
}

/** Forget the streak — called once an incident has stayed up long enough to count as healthy,
 *  and after a successful recovery, so an unrelated crash months later starts from scratch. */
export function clearCrash(): void {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
