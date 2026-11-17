// The phone's floating row – its tiles (`.wb-botleft`: the Karte's Gebäude tiles + radar pill, the
// plan's Objekt / Massstab tiles) and the Eintrag FAB (`.fab-entry`) – stands on the LOWEST free
// line, measured — not one bar higher whenever a tool's option dock is out.
//
// Owner, sweep 27.10.2026 #9 (screenshot): the Gebäude ⓘ floated a whole row above the bars with
// Mehrfach armed, though the dock under it ([ⓘ | ✕], centred, 120px wide) left the left end of
// its line empty. The CSS reserve (15-mobile · --float-base) has to assume the worst: the dock is
// as wide as the screen. Here the row's floor is the bars alone (`--float-floor`) and it rises
// only past what actually stands in its way — the dock, the ✥ ⟳ bar, Messen's panel — by the
// measured overlap (`--row-lift`), so it sits beside a short dock and above a long one.
//
// B+ (owner picks 13 + 14, button round 17.11.2026): a short bar – the symbol's [Unfall · Mehrere ·
// Abbrechen], the ✥ ⟳ bar – shares its line with the row's tiles on the left and the Eintrag FAB on
// the right, and a piece standing on a bar's line takes the BAR's height (`data-float-beside`,
// 15-mobile: `--float-h` becomes `--rail-h`), so the line reads as one height on one baseline. A
// long bar (Linie, Form) leaves them a line above, as before. Measured, not a tile count: whether
// it fits is asked at the bar's height – the tiles grow with it – so a piece never flips between
// the two lines.
//
// The FAB stays out while a tool is out since then (it yielded to the dock until 17.11.2026,
// when the full-width dock stood in its corner); a dock that hugs its tiles leaves it room.
//
// Mounted ONCE per workspace (IncidentWorkspace, phone only) and it places every row on screen —
// the Karte's and the plan's — so no surface wires a ref of its own. Until it has measured, a
// row keeps the CSS reserve (`--float-bottom`), which is never too low.
//
// …and while a tool is out it also says where THE message lane starts (`--stack-lane` on <html>,
// 15-mobile · --msg-lane-bottom): one --float-gap above the highest thing in the stack, measured
// (sweep 30.10.2026 #7, owner's iPhone with Linie armed: the tip stood 16px over the pill because
// the CSS reserve counted a chip row that sat beside the dock, and the Gebäude card stood in the
// same spot). Without a tool the CSS reserve is exact and the property is removed.

import { useLayoutEffect } from 'react'

/** A box in viewport px, as `getBoundingClientRect` reports it. */
export interface Box { left: number; right: number; top: number; bottom: number }

/** The gap the floating family keeps from everything (01-tokens · --float-gap). */
const GAP = 8
/** the pieces of the floating row this places, each on its own: the tiles, and the FAB */
const ROW_SEL = '.wb-botleft, .fab-entry'
/** the BARS a piece can share its line with: the tool's option dock (led by the armed tool's
 *  readout tile, ToolDock · armed) and the ✥ ⟳ bar */
const BAR_SEL = '.phone-tools .wb-dock, .phone-tools .sel-bar'
/** what stands on the row's floor on a phone: the bars, Messen's results panel (MeasurePanel ·
 *  `data-float-stack`, a hashed module class), and the Präsentationsmodus pill
 *  (components/Presentation – it stands bottom centre, the chips rise past it; owner's iPhone
 *  06.11.2026) */
const OBSTACLE_SEL = `${BAR_SEL}, .phone-tools [data-float-stack], .phone-tools .present-pill, .phone-tools .present-again`

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

/**
 * Where one piece of the row stands. `bar` is the bar on the piece's floor line (null when none
 * stands there): the piece shares that line only AT the bar's height (`beside`) – asked grown by
 * `grow`, what taking the bar's height adds (`w` on each side, `h` on top; 0 while it already
 * wears it) – and a piece that fits only at its own height rises past the bar instead of standing
 * beside it a size smaller. Without a bar, the lowest line `rowLift` finds.
 */
export function placePiece(content: Box, obstacles: readonly Box[], bar: Box | null, grow = { w: 0, h: 0 }, gap = GAP): { lift: number; beside: boolean } {
  if (!bar) return { lift: rowLift(content, obstacles, gap), beside: false }
  const tall = { left: content.left - grow.w, right: content.right + grow.w, top: content.top - grow.h, bottom: content.bottom }
  const lift = rowLift(tall, obstacles, gap)
  return { lift, beside: lift === 0 }
}

/**
 * Where the message lane starts, in px above the viewport's bottom edge: `gap` above the highest
 * top among `boxes` (viewport px, `viewportH` tall). Null when nothing stands in the stack.
 */
export function stackLane(boxes: readonly Box[], viewportH: number, gap = GAP): number | null {
  if (!boxes.length) return null
  return Math.max(...boxes.map((b) => viewportH - b.top)) + gap
}

const box = (r: DOMRect): Box => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })

/** A piece's own content (the tile row's box spans to the FAB's edge – its tiles hug its left
 *  end; the FAB is its own box), at its floor: the lift it currently wears is taken back out.
 *  Null while it shows nothing. */
function contentAtFloor(row: HTMLElement): Box | null {
  const lift = parseFloat(row.style.getPropertyValue('--row-lift')) || 0
  let out: Box | null = null
  for (const child of row.classList.contains('fab-entry') ? [row] : row.children) {
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
      const measure = (sel: string) => [...document.querySelectorAll(sel)]
        .map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height).map(box)
      const obstacles = measure(OBSTACLE_SEL)
      const bars = measure(BAR_SEL)
      const placed: Box[] = []
      for (const row of document.querySelectorAll<HTMLElement>(ROW_SEL)) {
        // the floor first (09-whiteboard · .wb-botleft, 15-mobile · .fab-entry [data-float-placed]),
        // then measure from it
        row.dataset.floatPlaced = ''
        const content = contentAtFloor(row)
        const bar = content && bars.find((b) => b.top < content.bottom && b.bottom > content.top)
        let at = { lift: 0, beside: false }
        if (content) {
          // what the bar's height would add – each tile as much wider as taller (at most: a tile
          // wider than tall keeps its width), so the question is asked at the size the answer brings
          const h = bar && row.dataset.floatBeside === undefined ? Math.max(0, (bar.bottom - bar.top) - (content.bottom - content.top)) : 0
          const tiles = row.classList.contains('fab-entry') ? 1 : Math.max(1, row.querySelectorAll('button').length)
          at = placePiece(content, obstacles, bar ?? null, { w: tiles * h, h })
        }
        row.style.setProperty('--row-lift', `${at.lift}px`)
        if (at.beside) row.dataset.floatBeside = ''
        else delete row.dataset.floatBeside
        if (content) placed.push({ ...content, top: content.top - at.lift, bottom: content.bottom - at.lift })
      }
      // the lane: only while a tool is out — at rest the CSS reserve already is the measurement
      const lane = obstacles.length ? stackLane([...obstacles, ...placed], window.innerHeight) : null
      const root = document.documentElement
      if (lane === null) { delete root.dataset.stackLane; root.style.removeProperty('--stack-lane') }
      else { root.dataset.stackLane = ''; root.style.setProperty('--stack-lane', `${lane}px`) }
    }
    place()
    // A dock or a bar comes and goes with a tool, and a dock changes width with its options: all
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
        delete row.dataset.floatBeside
        row.style.removeProperty('--row-lift')
      }
      delete document.documentElement.dataset.stackLane
      document.documentElement.style.removeProperty('--stack-lane')
    }
  }, [on])
}
