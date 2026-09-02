// Make room for the incident record by throwing away map tiles.
//
// Everything cached for offline use shares one origin quota, and when it runs out the loser is
// whatever tries to write next — which, on a working Lage, is the workspace. That ordering is
// backwards: a map tile is re-downloadable from the internet in a second, the Lagekarte is not
// reproducible at all. So when a workspace write is refused we evict tiles and try again.
//
// The `map-tiles` cache is the right victim. It is the largest consumer by far (up to 4000
// entries per the Workbox runtimeCaching rule, plus whatever «Alles für offline laden» pushed in),
// and it is the only cache holding purely derivative data — plan PDFs, reference geodata and
// incident media are all station or incident records.

const TILE_CACHE = 'map-tiles'
/** How many tiles to drop per attempt. Big enough that one pass frees real space (≈ 15 MB at
 *  30 KB/tile), small enough that an operator who prefetched an area doesn't lose all of it. */
export const EVICT_BATCH = 500
/** Minimum gap between two evictions. A burst of refused writes (every keystroke on a full
 *  device, before the cache write was debounced) used to cost one batch PER write — a 10-word
 *  Bemerkung wiped the prefetched map area in seconds. One batch per window is all the rescue a
 *  write needs; if that did not make room, tiles were not the problem. */
export const EVICT_MIN_GAP_MS = 30_000
let lastEvictAt = -Infinity

/**
 * Delete up to `batch` of the OLDEST entries from the tile cache. Returns how many were removed
 * (0 when there is no cache, nothing in it, Cache Storage is unavailable, or an eviction ran
 * less than EVICT_MIN_GAP_MS ago).
 *
 * Ordering caveat, deliberately accepted: the Cache Storage API exposes no timestamps, so we lean
 * on `cache.keys()` resolving in insertion order — which the spec does require, since the request
 * list is append-ordered. That makes the first N keys the least recently ADDED (not the least
 * recently used, which we cannot know). Good enough: it evicts an older area rather than the one
 * just downloaded. We deliberately do NOT read Workbox's expiration metadata to do better — that
 * is a private implementation detail of the plugin and would break silently on upgrade.
 */
export async function evictOldTiles(batch = EVICT_BATCH): Promise<number> {
  const now = Date.now()
  if (now - lastEvictAt < EVICT_MIN_GAP_MS) return 0 // rate-limited: reads as «nothing to evict»
  lastEvictAt = now
  try {
    if (typeof caches === 'undefined') return 0
    if (!(await caches.has(TILE_CACHE))) return 0
    const cache = await caches.open(TILE_CACHE)
    const keys = await cache.keys()
    if (!keys.length) return 0
    const victims = keys.slice(0, batch)
    const results = await Promise.all(victims.map((r) => cache.delete(r).catch(() => false)))
    return results.filter(Boolean).length
  } catch {
    return 0 // eviction is a best-effort rescue; never let it become its own failure
  }
}

/**
 * Run `write`, and if it reports failure, free tile space and try once more.
 *
 * One retry, not a loop: if a single 500-tile eviction didn't help, the pressure is not coming
 * from tiles and hammering the cache would only destroy the operator's prefetched area for
 * nothing. The caller still gets `false` and surfaces the degraded state.
 */
export async function withTileEviction(write: () => Promise<boolean>): Promise<boolean> {
  if (await write()) return true
  if ((await evictOldTiles()) === 0) return false
  return write()
}
