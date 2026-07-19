// Pure helpers extracted from Whiteboard: plan URL resolution, floor labelling, and
// the floor-stack ↔ board-normalized coordinate maths. No React — safe to unit-test.

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'

const BASE = import.meta.env.BASE_URL
// plan PDFs may live under /public (relative) OR be served by the backend per-object
// (absolute, e.g. /api/reference/plan:<obj>:modul1) — don't BASE-prefix absolute URLs.
export const planUrl = (u: string) => (/^(https?:)?\/\//.test(u) || u.startsWith('/') ? u : `${BASE}${u}`)

export const TILE_AR = 0.72 // each floor tile's height/width in the stack
// the canvas is full-bleed (content can pan up behind the floating top bar), but
// the default "fit" view is sized + vertically centred into the region BELOW the
// bar. Must match the top-bar clearance used in CSS.
export const TOP_INSET = 80
// in the floor-stack (Gebäude) view the +OG / −UG pills straddle the top and bottom
// edges of the stack (CSS top/bottom: -17px). The default "fit" reserves this much
// extra room above AND below so both pills stay fully on-screen instead of clipping.
export const STACK_VPAD = 36
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
export const floorLabel = (f: number) => {
  const c = appConfig.copy.floor
  return f === 0 ? c.eg : f > 0 ? fillTemplate(c.og, { n: f }) : fillTemplate(c.ug, { n: -f })
}

/**
 * Floor-stack coordinate maps for the current document. In stack mode the board is a
 * vertical stack of N storey tiles (top = highest); single-sheet docs are one tile
 * [0,1] → identity. `mapY` lifts a tile-local y into whole-board normalized space,
 * `localY` does the inverse for a given storey, and `floorAt` resolves which storey a
 * board-normalized y falls into.
 */
export function floorGeometry(stack: boolean, floorsTTB: number[], N: number) {
  // tile-local y (0..1 within a storey) → whole-board normalized y. x is unchanged
  // (tiles span the full width); single-sheet docs are one tile [0,1] → identity.
  const mapY = (floor: number | undefined, ly: number) => {
    if (!stack) return ly
    const idx = floorsTTB.indexOf(floor ?? 0)
    return idx < 0 ? ly : (idx + ly) / N
  }
  // board-normalized y → tile-local y for a given storey
  const localY = (ny: number, floor: number) => {
    if (!stack) return ny
    return clamp01(ny * N - floorsTTB.indexOf(floor))
  }
  // which storey a board-normalized y falls into
  const floorAt = (ny: number) => floorsTTB[Math.min(N - 1, Math.max(0, Math.floor(ny * N)))]
  return { mapY, localY, floorAt }
}
