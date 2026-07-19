// Pre-download a map area for offline use. We just `fetch()` each tile URL — the service
// worker's `map-tiles` runtimeCache (see vite.config.ts) stores the responses, so the
// base map renders later with no signal. Cross-origin raster tiles are opaque (mode
// 'no-cors', status 0); the SW caches them because we allow status 0.

export interface LngLatBounds {
  west: number
  south: number
  east: number
  north: number
}

function lon2tile(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}
function lat2tile(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

/** All {z,x,y} tiles covering `bounds` across the inclusive zoom range. */
export function tilesForBounds(b: LngLatBounds, minZ: number, maxZ: number): Array<{ z: number; x: number; y: number }> {
  const out: Array<{ z: number; x: number; y: number }> = []
  for (let z = minZ; z <= maxZ; z++) {
    const max = 2 ** z - 1
    const x0 = Math.max(0, lon2tile(b.west, z))
    const x1 = Math.min(max, lon2tile(b.east, z))
    const y0 = Math.max(0, lat2tile(b.north, z)) // north = smaller y
    const y1 = Math.min(max, lat2tile(b.south, z))
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y })
  }
  return out
}

function fillTemplate(tpl: string, z: number, x: number, y: number): string {
  return tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

export interface PredownloadResult {
  fetched: number
  total: number
  capped: boolean
}

export interface PredownloadOpts {
  templates: string[] // base-layer tile URL template(s); cycled per tile to spread hosts
  bounds: LngLatBounds
  minZoom?: number
  maxZoom?: number
  cap?: number // hard tile-count limit (avoid runaway downloads)
  warmUrls?: string[] // extra same-origin URLs (plans, symbols, geojson)
  onProgress?: (done: number, total: number) => void
  concurrency?: number
}

/** Warm the SW caches for an area + a set of extra resources. */
export async function predownloadArea(opts: PredownloadOpts): Promise<PredownloadResult> {
  const minZ = opts.minZoom ?? 14
  // Default to z17 (building-level): z18 roughly QUADRUPLES the tile count of the whole stack,
  // and pushing that many through the SW into Cache Storage OOMs an iPad. z17 keeps the scene
  // legible at a fraction of the bytes.
  const maxZ = opts.maxZoom ?? 17
  const cap = opts.cap ?? 1500
  const tiles = tilesForBounds(opts.bounds, minZ, maxZ)
  const capped = tiles.length > cap
  const use = capped ? tiles.slice(0, cap) : tiles

  const tileUrls = use.map((t, i) => fillTemplate(opts.templates[i % opts.templates.length], t.z, t.x, t.y))
  const warm = opts.warmUrls ?? []
  // Weight each warm item so the bar reflects real time: tiles (many, fast) fill ~70% and the
  // slow SEQUENTIAL warm phase (few, large) fills the rest — instead of snapping to ~97% on the
  // tiles then crawling through the warm tail (which read as "stuck at 99%").
  const warmW = warm.length && tileUrls.length ? Math.max(1, Math.round((tileUrls.length * 0.4) / warm.length)) : 1
  const total = tileUrls.length + warm.length * warmW
  let progressed = 0
  let tilesFetched = 0

  const fetchOne = async (url: string, weight: number, isTile: boolean) => {
    try {
      // CORS-ONLY: opaque (no-cors) responses are padded to several MB EACH in iOS Cache
      // Storage, so caching hundreds of cross-origin tiles that way reloads the tab (the OOM).
      // We never fall back to no-cors — a tile that lacks CORS is simply skipped (it still
      // loads online). Carto/swisstopo/OSM/Esri all send CORS headers. Don't read the body:
      // the SW caches it independently; reading would pull big GeoJSON/PDFs into page memory.
      await fetch(url, { mode: 'cors' })
      if (isTile) tilesFetched++
    } catch {
      /* offline / no CORS / blocked — skip; SW caches whatever succeeds */
    } finally {
      progressed += weight
      opts.onProgress?.(progressed, total)
    }
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  // Run a URL list with bounded concurrency. `pauseMs` (used for the heavy warm pass) inserts a
  // real gap after each fetch so the SW can flush a large body to DISK and free it before the
  // next — a 0ms micro-yield isn't enough time for a multi-MB GeoJSON/PDF to commit.
  const runPool = async (urls: string[], conc: number, weight: number, isTile: boolean, pauseMs = 0) => {
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(conc, urls.length) }, async () => {
        while (cursor < urls.length) {
          const idx = cursor++
          await fetchOne(urls[idx], weight, isTile)
          if (pauseMs) await sleep(pauseMs)
          else if ((idx & 15) === 15) await sleep(0) // yield every 16 tiles
        }
      }),
    )
  }

  // Tiles: many but small → modest concurrency. Warm resources (plan PDFs, GeoJSON) are few but
  // can be large → SEQUENTIAL with a real pause after each, so only one big body is ever in
  // flight and it's flushed to disk before the next starts.
  await runPool(tileUrls, opts.concurrency ?? 3, 1, true)
  await runPool(warm, 1, warmW, false, 150)

  return { fetched: tilesFetched, total: tileUrls.length + warm.length, capped }
}
