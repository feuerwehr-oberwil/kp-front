import type { LegacySpread, Spread } from '../types'

// FKS Entwicklung (spread) — reading and tidying the four arrows.
//
// ⚠️ This module exists because the stored shape CHANGED. Until 2026-08 a symbol carried one
// exclusive horizontal direction (`h: 'E' | 'W'`) with a single `hBounded`, and `up`/`down`
// shared one `vBounded`. Every incident written before that — live and archived — still holds
// it, and the workspace blob is never migrated in place. So the rule is: nothing reads
// `spread` fields directly, everything reads them through `normalizeSpread`.
//
// The same normalisation exists in `backend/app/kroki.py` (`_spread_dirs`), because the printed
// Kroki is rendered server-side from the same blob. If one side learns a new field and the
// other does not, paper stops matching the screen.

/** One arrow: its direction and whether its own Entwicklungsgrenze bar is set. */
export type SpreadDir = 'left' | 'right' | 'up' | 'down'

export const SPREAD_DIRS: readonly SpreadDir[] = ['left', 'right', 'up', 'down'] as const

/** `<dir>Bounded` for a direction — the one place that spelling is constructed. */
export const boundedKey = (d: SpreadDir) => `${d}Bounded` as const

/** Read a stored spread of EITHER shape into the current one.
 *
 *  Legacy mapping: `h: 'W'` → left, `h: 'E'` → right, and `hBounded` lands on whichever of the
 *  two that was — a bar could not exist without its arrow. `vBounded` was one flag for both
 *  vertical arrows, so it lands on each one that is actually set. */
export function normalizeSpread(raw: (Spread & LegacySpread) | null | undefined): Spread {
  if (!raw) return {}
  const n: Spread = {
    left: raw.left || raw.h === 'W' || undefined,
    right: raw.right || raw.h === 'E' || undefined,
    up: raw.up || undefined,
    down: raw.down || undefined,
  }
  n.leftBounded = (n.left && (raw.leftBounded || (raw.h === 'W' && raw.hBounded))) || undefined
  n.rightBounded = (n.right && (raw.rightBounded || (raw.h === 'E' && raw.hBounded))) || undefined
  n.upBounded = (n.up && (raw.upBounded ?? raw.vBounded)) || undefined
  n.downBounded = (n.down && (raw.downBounded ?? raw.vBounded)) || undefined
  return n
}

/** Drop every falsy key, and a bar whose arrow is gone. Returns null when nothing is left, so
 *  an entity that lost its last arrow drops the whole prop instead of keeping `{}` around. */
export function tidySpread(s: Spread): Spread | null {
  const out: Spread = {}
  for (const d of SPREAD_DIRS) {
    if (!s[d]) continue
    out[d] = true
    if (s[boundedKey(d)]) out[boundedKey(d)] = true
  }
  return SPREAD_DIRS.some((d) => out[d]) ? out : null
}

/** True when at least one arrow is set — the cheap "is there anything to draw" test. */
export const hasSpread = (s: Spread) => SPREAD_DIRS.some((d) => s[d])
