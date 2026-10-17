// Throw away base-map tiles a provider has since drawn differently — once per device.
//
// The service worker keeps base tiles CACHE-FIRST for 30 days (vite.config · `map-tiles`), so a
// place looked at once renders with no signal. The price: when a provider re-renders its map
// under the SAME URL, a device shows the old look wherever it still holds a tile and the new one
// everywhere else, tile by tile. That is the «seam» of the owner's review (17.10.2026, staging on
// an iPhone, night): CARTO now renders Dark Matter from its GL style (ground #0e0e0e, buildings
// #393939 LIGHTER than the ground, minor roads a blue-grey #414758), where the tiles cached in
// September were the old raster style (buildings darker than the ground, a grain on the land).
// Under the night paint (components/MapLayers · DARK_BASE_PAINT) the two read as two different
// maps — pixel-exact: the light half of the screenshot is the new style, the stippled dark half
// the old one.
//
// So: each entry below names a provider change and the tile URLs it made stale; the first boot
// ONLINE after the entry ships deletes those tiles from `map-tiles`, and the map fetches them
// fresh. Never offline — a device without signal keeps the map it has, an old look beats no map —
// and never twice (the done ids are a tiny device flag in localStorage, AGENTS.md · Offline).
// A provider changes its look again → add an entry; never edit or reuse an id.

/** vite.config · runtimeCaching `map-tiles` (spelled out, like lib/tileEvict: this runs on the
 *  boot path and must not pull the Karte's modules into the entry chunk) */
const TILE_CACHE = 'map-tiles'

export interface TilePurge {
  /** stable, never reused: it is what a device remembers as done */
  id: string
  /** the tile URLs this change made stale */
  match: RegExp
}

export const TILE_PURGES: readonly TilePurge[] = [
  // CARTO's GL-rendered Voyager / Dark Matter replaced the raster style under the same URLs
  // (seen 17.10.2026; the tiles measured on 20.09.2026 were still the old style)
  { id: 'carto-gl-2026-10', match: /^https:\/\/([a-d]\.)?basemaps\.cartocdn\.com\// },
]

const DONE_KEY = 'kp.tilePurges'

function readDone(storage: Pick<Storage, 'getItem'> | null): Set<string> {
  try {
    const v = JSON.parse(storage?.getItem(DONE_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Run every purge this device has not run yet. Returns how many tiles were deleted. Best-effort
 * and silent: no Cache Storage, no localStorage or no network → nothing happens, and it is asked
 * again on the next boot.
 */
export async function purgeStaleTiles(env: {
  caches?: Pick<CacheStorage, 'has' | 'open'> | null
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  online?: boolean
  purges?: readonly TilePurge[]
} = {}): Promise<number> {
  const store = env.caches !== undefined ? env.caches : typeof caches === 'undefined' ? null : caches
  let storage: Pick<Storage, 'getItem' | 'setItem'> | null
  try { storage = env.storage !== undefined ? env.storage : window.localStorage } catch { storage = null }
  const online = env.online ?? (typeof navigator === 'undefined' || navigator.onLine !== false)
  const purges = env.purges ?? TILE_PURGES
  if (!store || !storage || !online) return 0
  const done = readDone(storage)
  const todo = purges.filter((p) => !done.has(p.id))
  if (!todo.length) return 0
  let removed = 0
  try {
    if (await store.has(TILE_CACHE)) {
      const cache = await store.open(TILE_CACHE)
      for (const req of await cache.keys()) {
        if (todo.some((p) => p.match.test(req.url)) && await cache.delete(req).catch(() => false)) removed++
      }
    }
  } catch {
    return removed // not marked done: the next boot tries again
  }
  for (const p of todo) done.add(p.id)
  try { storage.setItem(DONE_KEY, JSON.stringify([...done])) } catch { /* asked again next boot */ }
  return removed
}
