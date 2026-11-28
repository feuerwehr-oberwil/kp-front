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
// Abbrechen] – shares its line with the row's tiles on the left and the Eintrag FAB on the right; a
// long bar (Linie, Form) leaves them a line above, as before. Measured, not a tile count. Every
// piece already wears the bar's height (01-tokens · --line-h, owner pick 21), so the line reads as
// one height on one baseline and the question is asked at the size the piece has – it never grows
// or shrinks with the answer.
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
//
// …and it never rises onto an ALERT (owner, 26.11.2026: «no map control may cover an alert»). An
// open Messen panel ends one --float-gap under the Meldeleiste (15-mobile · --under-alert), so a
// row lifted above it landed on the strip's last row. Its ceiling is the strip's foot + a gap; a
// piece whose lift crosses it YIELDS (`data-float-yield`, hidden in 15-mobile) until the panel
// folds or the strip goes. Not a shorter panel: the band that would free is the row under the
// bar's (Standort left, the wind right), where Info and Eintrag would land on those instead.

import { useLayoutEffect } from 'react'

/** A box in viewport px, as `getBoundingClientRect` reports it. */
export interface Box { left: number; right: number; top: number; bottom: number }

/** The gap the floating family keeps from everything (01-tokens · --float-gap). */
const GAP = 8
/** the pieces of the floating row this places, each on its own: the tiles, and the FAB */
const ROW_SEL = '.wb-botleft, .fab-entry'
/** what stands on the row's floor on a phone: the tool's option dock (led by the armed tool's
 *  readout tile, ToolDock · armed), the ✥ ⟳ bar (in the tool bar's slot since owner pick 21, so
 *  below the floor – it only counts for the message lane), Messen's results panel (MeasurePanel ·
 *  `data-float-stack`, a hashed module class), and the Präsentationsmodus pill
 *  (components/Presentation – it stands bottom centre, the chips rise past it; owner's iPhone
 *  06.11.2026) */
const OBSTACLES = ['.wb-dock', '.sel-bar', '[data-float-stack]', '.present-pill', '.present-again']
const OBSTACLE_SEL = OBSTACLES.map((s) => `.phone-tools ${s}`).join(', ')
/** the Meldeleiste: the ceiling no piece rises past */
const STRIP_SEL = '.ml'
/** what moves a row, an obstacle or the strip's foot by being there, through a `:has()` rule
 *  (15-mobile, 08-toasts): a detail sheet (hides the FAB, raises the ✥ ⟳ bar, caps the strip),
 *  the georef dock (hides the FAB), a docked Trupp card (hides the tile row), a Tafel page and the
 *  Rapport's tab strip (move the bars' end, the floor), and what caps the strip's height – the
 *  layers card, the Atemschutz-Tafel, the row under the top bar (Standort, GPS, wind).
 *  ⚠️ A new `:has()` that moves a piece, an obstacle or the strip names its subject here, or the
 *  row is not re-placed when that subject comes or goes. */
const MOVED_BY = ['.ctx', '.wb-georef-dock', '.wb-pill-card', '.wb-tafel-page', '.rp-tabs',
  '.layers-card', '.az-tafel', '.tb-share', '.tb-gps', '.phone-wx']
/** DOM that can move a row: a piece, an obstacle or the strip (and what lies inside one), what
 *  moves one by CSS, or a phone root that brings them. Bare classes: a node that was just removed
 *  has no ancestors. */
const MOVES_SEL = [ROW_SEL, ...OBSTACLES, STRIP_SEL, ...MOVED_BY, '.phone-tools'].join(', ')
/** the same, for the parent whose children changed – `.phone-tools` is the whole app, so not it;
 *  `.tb-share` caps the strip once it holds a piece (15-mobile · `.tb-share > *`) */
const INSIDE_SEL = [ROW_SEL, ...OBSTACLES, STRIP_SEL, '.tb-share'].join(', ')

/** Whether a node that came or went is, or holds, something `place` measures. */
const moves = (n: Node) => n instanceof Element && (n.matches(MOVES_SEL) || n.querySelector(MOVES_SEL) !== null)

/** Whether a batch of childList records can move a row: its parent lies in a piece, obstacle or
 *  strip (a dock's options, the strip's rows), or a node it adds or removes is or holds one. */
const canMoveRow = (records: readonly MutationRecord[]) => records.some((r) =>
  (r.target instanceof Element && r.target.closest(INSIDE_SEL) !== null)
  || [...r.addedNodes].some(moves) || [...r.removedNodes].some(moves))

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
 * Where the message lane starts, in px above the viewport's bottom edge: `gap` above the highest
 * top among `boxes` (viewport px, `viewportH` tall). Null when nothing stands in the stack.
 */
export function stackLane(boxes: readonly Box[], viewportH: number, gap = GAP): number | null {
  if (!boxes.length) return null
  return Math.max(...boxes.map((b) => viewportH - b.top)) + gap
}

/**
 * Whether a piece at `row` (its floor position), lifted by `lift`, crosses `ceiling` (viewport px:
 * the highest line it may reach, null when nothing hangs above it) – then it yields.
 */
export function crossesCeiling(row: Box, lift: number, ceiling: number | null): boolean {
  return ceiling !== null && row.top - lift < ceiling
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
    // the strip whose size is watched (below): the one on screen at the last pass
    let watched: Element | null = null
    const place = () => {
      const stripEl = document.querySelector(STRIP_SEL)
      if (stripEl !== watched) {
        if (watched) ro?.unobserve(watched)
        if (stripEl) ro?.observe(stripEl)
        watched = stripEl
      }
      const measure = (sel: string) => [...document.querySelectorAll(sel)]
        .map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height).map(box)
      const obstacles = measure(OBSTACLE_SEL)
      // the ceiling: one gap under the Meldeleiste while one stands
      const strip = measure(STRIP_SEL)[0]
      const ceiling = strip ? strip.bottom + GAP : null
      const placed: Box[] = []
      // every write only when it changes something: an unchanged value still restyles the row
      const flag = (el: HTMLElement, key: 'floatPlaced' | 'floatYield' | 'stackLane', on: boolean) => {
        if (on && el.dataset[key] === undefined) el.dataset[key] = ''
        else if (!on && el.dataset[key] !== undefined) delete el.dataset[key]
      }
      const prop = (el: HTMLElement, name: string, value: string | null) => {
        const now = el.style.getPropertyValue(name)
        if (value === null) { if (now) el.style.removeProperty(name) }
        else if (now !== value) el.style.setProperty(name, value)
      }
      for (const row of document.querySelectorAll<HTMLElement>(ROW_SEL)) {
        // the floor first (09-whiteboard · .wb-botleft, 15-mobile · .fab-entry [data-float-placed]),
        // then measure from it
        flag(row, 'floatPlaced', true)
        const content = contentAtFloor(row)
        const lift = content ? rowLift(content, obstacles) : 0
        prop(row, '--row-lift', `${lift}px`)
        const yields = content !== null && crossesCeiling(content, lift, ceiling)
        flag(row, 'floatYield', yields)
        if (content && !yields) placed.push({ ...content, top: content.top - lift, bottom: content.bottom - lift })
      }
      // the lane: only while a tool is out — at rest the CSS reserve already is the measurement
      const lane = obstacles.length ? stackLane([...obstacles, ...placed], window.innerHeight) : null
      const root = document.documentElement
      flag(root, 'stackLane', lane !== null)
      prop(root, '--stack-lane', lane === null ? null : `${lane}px`)
    }
    // At mount at once (no frame shows an unplaced row), then at most once a frame: a frame
    // asked for from the observer runs before that frame is painted.
    let raf = 0
    const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place() }) }
    // …and when the strip changes SIZE with no DOM change: its cap follows the lane and the
    // reserves (08-toasts · .ml), and Messen's panel hangs under it (Meldeleiste · `--ml-h` →
    // 15-mobile · `--under-alert`). Armed under a strip taller than the cap, the panel grew 8px
    // after the pass and the row stood on it until the first tap. A size is reported after the
    // frame's own pass, so this one lands a frame later.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null
    place()
    // A dock or a bar comes and goes with a tool, and a dock changes width with its options: all
    // of it is DOM coming and going, which a childList observer hears before the frame is
    // painted. Everything else on the page (a keystroke, a list row, a toast) is skipped
    // (`canMoveRow`). Attributes are deliberately NOT observed — the map moves its markers by
    // style on every frame of a pan, and this writes a style itself.
    const mo = new MutationObserver((records) => { if (canMoveRow(records)) soon() })
    mo.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', soon)
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
      ro?.disconnect()
      window.removeEventListener('resize', soon)
      for (const row of document.querySelectorAll<HTMLElement>(ROW_SEL)) {
        delete row.dataset.floatPlaced
        delete row.dataset.floatYield
        row.style.removeProperty('--row-lift')
      }
      delete document.documentElement.dataset.stackLane
      document.documentElement.style.removeProperty('--stack-lane')
    }
  }, [on])
}
