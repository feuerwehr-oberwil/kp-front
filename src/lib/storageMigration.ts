// One-time migration of operational state from localStorage into IndexedDB (see idb.ts for
// the why). Runs once at boot, before the app reads any cache. Idempotent and guarded by a
// localStorage flag — itself one of the "tiny flags" localStorage is still allowed to hold.
//
// What moves: the per-incident workspace sync caches (the large ones), the cached incident
// list, the cached user, the roster, the deployment config, and the OSM building outlines.
// What stays in localStorage: the prefs cookie (it's a cookie, not localStorage), the device
// toggles `kp.atemschutz.alarmMute` / `kp.divera.dismissed`, and migration flags.

import { idbSet } from './idb'

const MIGRATED_FLAG = 'kp-front-idb-migrated-v1'

// Exact keys + key-prefixes that hold operational state and should move to IDB. Kept here as
// the single source of truth so the inventory is reviewable in one place.
const EXACT_KEYS = [
  'kp-front-incidents', // cached active incident list (PWA reopen)
  'kp-front-user', // last-known authenticated user (offline launch)
  'kp-front-roster', // cached Mannschaft
  'kp-front-deployment-config', // station branding / map / fleet / doctrine
]
const PREFIXES = [
  'kp-front-ws-', // per-incident workspace sync cache (offline edits + merge ancestor)
  'kp.osm.bld.', // OSM building-outline cache, keyed by bbox
]

function isOperationalKey(key: string): boolean {
  return EXACT_KEYS.includes(key) || PREFIXES.some((p) => key.startsWith(p))
}

/**
 * Move operational localStorage entries into IndexedDB exactly once. Each value is JSON-parsed
 * (everything we wrote was JSON) and stored as a structured-clone object, matching what the
 * IDB-backed callers now read. After a successful copy the localStorage key is removed so the
 * two stores don't drift. Best-effort: a single corrupt/oversized entry is skipped, never
 * fatal — a missed cache entry just re-fetches from the server on next use.
 *
 * Safe to call on every boot; returns immediately once the flag is set.
 */
export async function migrateLocalStorageToIdb(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATED_FLAG) === '1') return
  } catch {
    return // no localStorage at all — nothing to migrate
  }

  let keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && isOperationalKey(k)) keys.push(k)
    }
  } catch { keys = [] }

  for (const key of keys) {
    let value: unknown
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) continue
      value = JSON.parse(raw)
    } catch {
      continue // corrupt entry — leave it; the cache will simply re-fetch
    }
    await idbSet(key, value)
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  }

  try { localStorage.setItem(MIGRATED_FLAG, '1') } catch { /* ignore — retry next boot */ }
}
