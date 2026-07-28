import { useCallback, useEffect, useState } from 'react'
import { listPersonnel } from './incidents'
import { idbGet, idbSet } from './idb'
import type { Person } from '../types'

// Persist the roster across app restarts so a close→open (and especially an offline launch)
// shows the last-known Mannschaft instantly instead of an empty list — the API is NetworkOnly
// for the SW, so we cache it here, the same way the incident list is cached (see incidents.ts).
const ROSTER_CACHE = 'kp-front-roster'
function readCachedRoster(): Promise<Person[]> {
  return idbGet<Person[]>(ROSTER_CACHE).then((v) => v ?? [])
}
function cacheRoster(list: Person[]): void {
  void idbSet(ROSTER_CACHE, list)
}

/** Same roster, same order, same rows? Then hand the CALLER back its own array.
 *
 *  The background refresh below runs while somebody is ticking people in and out, and a fresh
 *  array identity every time would re-render the whole Mannschaft grid for a list that did not
 *  change — the exact shape of the bug that once cost the phone its battery. `updated_at` moves
 *  whenever anything about a person does, so it is enough to compare alongside the ids. */
function sameRoster(a: Person[], b: Person[]): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i].id && p.updatedAt === b[i].updatedAt)
}

/** How often a visible surface re-checks the roster. Long on purpose: nothing in the app can
 *  change it — only an admin running the Divera sync or editing somebody — so this exists to
 *  notice THAT, not to keep up with anything. Attendance is live already (see useIncidentSync). */
const BACKGROUND_MS = 5 * 60_000

// Loads the brigade roster (Mannschaft) and keeps it fresh in the BACKGROUND: on regaining
// network, on coming back to the foreground, and on a slow heartbeat while visible. There used
// to be an «Aktualisieren» button in the Anwesenheit header for this, which was misleading twice
// over — it suggested the ATTENDANCE needed refreshing (it never did; the workspace blob follows
// live) and it sat permanently in a header short of width for a list that changes maybe monthly.
// What is left of it is a retry, shown only when a fetch actually failed.
//
// Offline-tolerant: seeds from the local cache so it survives a restart / offline launch,
// keeps the last list on failure, and flags `error` so the Anwesenheit surface can show a
// stale/offline hint instead of an empty screen.
export function usePersonnel(enabled = true) {
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // Seed from the cache (IndexedDB, async) so the roster appears on the first frames even with
  // no signal; the server fetch below then refreshes + re-caches it. Only seed while we don't
  // yet have a (fresher) server result, so a slow cache read can't clobber a fast fetch.
  useEffect(() => {
    let alive = true
    void readCachedRoster().then((cached) => {
      if (alive && cached.length) setPeople((cur) => (cur.length ? cur : cached))
    })
    return () => { alive = false }
  }, [])

  /** Take a fetched roster without disturbing anything that did not change. */
  const apply = useCallback((list: Person[]) => {
    setPeople((cur) => (sameRoster(cur, list) ? cur : list))
    cacheRoster(list)
  }, [])

  // explicit retry — the only path that may show a spinner and raise `error`
  const reload = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      apply(await listPersonnel())
    } catch {
      setError(true)
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [apply])

  // The background refresh. Deliberately QUIET: no spinner, and a failure does NOT raise `error`
  // — we still hold a good list, and putting a retry button on the header because a poll missed
  // once would be the surface crying about something the operator cannot act on and does not
  // need to. Only the initial load and an explicit retry can say the roster is broken.
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      listPersonnel().then((list) => { if (alive) apply(list) }).catch(() => {})
    }
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    // the heartbeat keeps ticking while hidden but `refresh` returns immediately, so a
    // backgrounded tab costs nothing and the first tick after it returns is the visibility one
    const timer = setInterval(refresh, BACKGROUND_MS)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, apply])

  // initial load — state changes only inside the promise callbacks (no sync setState in effect)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    listPersonnel()
      .then((list) => { if (alive) { apply(list); setError(false) } })
      .catch(() => { if (alive) setError(true) })
      .finally(() => { if (alive) { setLoading(false); setLoaded(true) } })
    return () => { alive = false }
  }, [enabled, apply])

  return { people, loading, error, loaded, reload }
}
