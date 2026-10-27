// The phone's floating chip row (`.wb-botleft`: the Karte's Gebäude chip + radar pill, the plan's
// Objekt / Massstab chips) stands on the LOWEST free line, measured — not one bar higher whenever
// a tool's option dock is out.
//
// Owner, sweep 27.10.2026 #9 (screenshot): the Gebäude ⓘ floated a whole row above the bars with
// Mehrfach armed, though the dock under it ([ⓘ | ✕], centred, 120px wide) left the left end of
// its line empty. The CSS reserve (15-mobile · --float-base) has to assume the worst: the dock is
// as wide as the screen. Here the row's floor is the bars alone (`--float-floor`) and it rises
// only past what actually stands in its way — the dock, the armed tool's pill — by the measured
// overlap (`--row-lift`), so it sits beside a short dock and above a long one.
//
// Mounted ONCE per workspace (IncidentWorkspace, phone only) and it places every row on screen —
// the Karte's and the plan's — so no surface wires a ref of its own. Until it has measured, a
// row keeps the CSS reserve (`--float-bottom`), which is never too low.

import { useLayoutEffect } from 'react'

/** A box in viewport px, as `getBoundingClientRect` reports it. */
export interface Box { left: number; right: number; top: number; bottom: number }

/** The gap the floating family keeps from everything (01-tokens · --float-gap). */
const GAP = 8
const ROW_SEL = '.wb-botleft'
/** what stands on the row's floor on a phone: the tool's option dock, the armed tool's readout */
const OBSTACLE_SEL = '.phone-tools .wb-dock, .phone-tools .armed-pill-row'

/**
 * How far a row standing at `row` (its floor position) has to rise so that no obstacle comes
 * within `gap` of it. Only an obstacle that overlaps the row SIDEWAYS can push it; each one it
 * meets puts the row `gap` above that obstacle's top, and the pass repeats until nothing is hit,
 * so a pill stacked over the dock lifts it past both. 0 when the floor is free.
 */
export function rowLift(row: Box, obstacles: readonly Box[], gap = GAP): number {
  let lift = 0
  for (let moved = true; moved;) {
    moved = false
    for (const o of obstacles) {
      const sideways = o.left < row.right + gap && o.right > row.left - gap
      const upright = o.top < row.bottom - lift + gap && o.bottom > row.top - lift - gap
      if (sideways && upright) { lift = row.bottom - o.top + gap; moved = true }
    }
  }
  return lift
}

const box = (r: DOMRect): Box => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })

/** The row's own content (its box spans to the FAB's edge; the chips hug its left end), at its
 *  floor: the lift it currently wears is taken back out. Null while it shows nothing. */
function contentAtFloor(row: HTMLElement): Box | null {
  const lift = parseFloat(row.style.getPropertyValue('--row-lift')) || 0
  let out: Box | null = null
  for (const child of row.children) {
    const r = child.getBoundingClientRect()
    if (!r.width || !r.height) continue
    out = out
      ? { left: Math.min(out.left, r.left), right: Math.max(out.right, r.right), top: Math.min(out.top, r.top), bottom: Math.max(out.bottom, r.bottom) }
      : box(r)
  }
  return out && { ...out, top: out.top + lift, bottom: out.bottom + lift }
}

/** Place every floating row on screen and keep placing them while `on` (a phone). */
export function useFloatRowPlacement(on: boolean) {
  useLayoutEffect(() => {
    if (!on) return
    const place = () => {
      const obstacles = [...document.querySelectorAll<HTMLElement>(OBSTACLE_SEL)]
        .map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height).map(box)
      for (const row of document.querySelectorAll<HTMLElement>(ROW_SEL)) {
        // the floor first (09-whiteboard · [data-float-placed]), then measure from it
        row.dataset.floatPlaced = ''
        const content = contentAtFloor(row)
        const lift = content ? rowLift(content, obstacles) : 0
        row.style.setProperty('--row-lift', `${lift}px`)
      }
    }
    place()
    // A dock or pill comes and goes with a tool, and a dock changes width with its options: all
    // of it is DOM coming and going, which a childList observer hears before the frame is
    // painted. Attributes are deliberately NOT observed — the map moves its markers by style on
    // every frame of a pan, and this writes a style itself.
    const mo = new MutationObserver(place)
    mo.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', place)
    return () => {
      mo.disconnect()
      window.removeEventListener('resize', place)
      for (const row of document.querySelectorAll<HTMLElement>(ROW_SEL)) {
        delete row.dataset.floatPlaced
        row.style.removeProperty('--row-lift')
      }
    }
  }, [on])
}
