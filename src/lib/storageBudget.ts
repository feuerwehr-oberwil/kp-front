// How much room this device still has, and whether a planned offline download will fit.
//
// Everything the app caches for offline use — map tiles, plan PDFs, reference geodata, queued
// media, incident workspaces — competes for ONE origin quota. Until now nothing in the field app
// looked at it (only /admin did), so «Alles für offline laden» would happily push a 3 km area
// into a nearly-full bucket and the first casualty was whatever got written next.

/** Bytes a single raster map tile costs in Cache Storage. Measured from the basemap providers we
 *  use (Carto/swisstopo/OSM 256px PNG/JPEG land in the 15–40 KB band); 30 KB is a deliberately
 *  middling figure, and the pre-flight rounds AGAINST the operator by adding headroom below. */
export const TILE_BYTES = 30 * 1024

/** Fraction of the remaining budget we are willing to spend on one prefetch. Leaves room for the
 *  incident record itself, which must never be the thing that fails to write. */
export const PREFETCH_BUDGET_SHARE = 0.7

/** Rough cost of one "warm" item (a plan PDF, the symbol library, a cropped GeoJSON overlay).
 *  These vary wildly — a Modul PDF can be several MB, a bbox-cropped hydrant layer a few KB — so
 *  this is a single conservative figure used only to size the pre-flight estimate, which is
 *  presented to the operator as approximate («≈»). Erring high is the safe direction: it makes us
 *  offer the reduced download slightly sooner than strictly necessary. */
export const WARM_BYTES = 1.5 * 1024 * 1024

export interface StorageBudget {
  usage: number
  quota: number
  /** bytes still available, floored at 0 */
  free: number
}

/** Read the origin's storage budget, or null when the browser won't say (older WebKit). Callers
 *  must treat null as "unknown" and NOT as "no room" — refusing to cache because we couldn't
 *  measure would be worse than trying. */
export async function estimateStorage(): Promise<StorageBudget | null> {
  try {
    const s = navigator.storage
    if (!s?.estimate) return null
    const { usage, quota } = await s.estimate()
    if (typeof usage !== 'number' || typeof quota !== 'number' || quota <= 0) return null
    return { usage, quota, free: Math.max(0, quota - usage) }
  } catch {
    return null
  }
}

export interface PrefetchFit {
  /** predicted cost of the download in bytes */
  needBytes: number
  /** what we're allowed to spend (share of free space), or null when the budget is unknown */
  allowBytes: number | null
  /** false only when we KNOW it won't fit — unknown budgets are permitted through */
  fits: boolean
}

/**
 * Will `tileCount` tiles (plus `extraBytes` of plans/geodata) fit in what's left?
 *
 * Pure so the decision is testable without a browser. An unknown budget resolves to `fits: true`:
 * the operator asked for this, and a device that won't report its quota is not evidence of a full
 * one. The share keeps a prefetch from consuming every last byte and starving the workspace.
 */
export function prefetchFit(budget: StorageBudget | null, tileCount: number, extraBytes = 0): PrefetchFit {
  const needBytes = tileCount * TILE_BYTES + extraBytes
  if (!budget) return { needBytes, allowBytes: null, fits: true }
  const allowBytes = Math.floor(budget.free * PREFETCH_BUDGET_SHARE)
  return { needBytes, allowBytes, fits: needBytes <= allowBytes }
}

/**
 * The largest tile count that still fits, for the "load it reduced" path.
 *
 * Capping the tile list degrades in exactly the right direction: `tilesForBounds` walks zoom
 * levels from coarse to fine, so dropping the tail sacrifices DETAIL and keeps the whole area
 * covered. An operator who asked for a 1.2 km box gets the full box at lower zoom rather than a
 * fraction of it at full zoom — much better for orientation at 3am.
 *
 * Returns 0 when even the warm payload can't fit, and `hardCap` when the budget is unknown.
 */
export function fittedTileCap(budget: StorageBudget | null, hardCap: number, extraBytes = 0): number {
  if (!budget) return hardCap
  const allow = Math.floor(budget.free * PREFETCH_BUDGET_SHARE) - extraBytes
  if (allow <= 0) return 0
  return Math.max(0, Math.min(hardCap, Math.floor(allow / TILE_BYTES)))
}

/** Compact human size for operator-facing copy: 940 KB, 12 MB, 1.4 GB. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–'
  if (n < 1024) return `${Math.round(n)} B`
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  const gb = mb / 1024
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`
}
