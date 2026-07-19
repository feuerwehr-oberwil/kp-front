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

// Loads the brigade roster (Mannschaft) once per session and exposes a manual reload.
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

  // manual refresh (event-driven — header button / empty-state retry)
  const reload = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const list = await listPersonnel()
      setPeople(list)
      cacheRoster(list)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [])

  // initial load — state changes only inside the promise callbacks (no sync setState in effect)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    listPersonnel()
      .then((list) => { if (alive) { setPeople(list); cacheRoster(list); setError(false) } })
      .catch(() => { if (alive) setError(true) })
      .finally(() => { if (alive) { setLoading(false); setLoaded(true) } })
    return () => { alive = false }
  }, [enabled])

  return { people, loading, error, loaded, reload }
}
