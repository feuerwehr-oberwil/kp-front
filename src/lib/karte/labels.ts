// «Karte & Objekte» — which station objects carry their NAME TAG on the map, and which stay a dot
// (owner, 17.10.2026: ~156 tags at town zoom were one unreadable pile, and tags still covered
// each other street by street).
//
//   · below `LABEL_MIN_ZOOM` every object is a small dot — no text at all;
//   · from it on, a tag only where it FITS: one greedy pass in screen space after the map has
//     settled, the most important object first (`tagRank`: selected › Einsatzobjekt › more plans
//     › the rest). A tag that would overlap a tag already placed or the chrome (top
//     bar, bottom bar, an open panel or sheet) stays a dot — it is still there and still tappable.
//   · the SELECTED object always carries its tag, at any zoom and wherever it lands.
//   · ⚠️ a tag sits ON its object's point, centred (owner, review round 3, 17.10.2026: «do not
//     move the location of the marker»): the pass decides only WHETHER it shows, and slides it
//     sideways only at the map's edge (`TAG_KEEP_OVER_ANCHOR`). Round 2 hung a tag inside its own
//     building when the street below was another object's — the point and its name then sat
//     apart, and that is what the owner read as a moved marker.
//   · a tag carries the NAME only — never a plan count (owner, round 3: «we just care that there
//     are plans»; the colour category, or the default look's rim, says that).
//
// Pure: positions and sizes come in, the set of tagged ids goes out. The surface measures the
// chrome and the text (components/karte/KarteApp); this file never touches the DOM.

/** Below this zoom the map shows dots only (z16 ≈ a few streets on a phone). */
export const LABEL_MIN_ZOOM = 16

export interface Rect { left: number; top: number; right: number; bottom: number }

export interface TagCandidate {
  id: string
  /** the object's point on screen (px, map container coordinates) — the tag's centre */
  x: number
  y: number
  w: number
  h: number
  /** higher goes first (`tagRank`) */
  rank: number
}

/** The screen box a tag takes, `dx` px slid sideways. */
export function tagRect(c: TagCandidate, dx = 0): Rect {
  const left = c.x + dx - c.w / 2
  const top = c.y - c.h / 2
  return { left, top, right: left + c.w, bottom: top + c.h }
}

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap
}

/** The order tags are placed in: the selected object first, then Einsatzobjekte, then by how
 *  many plans the object has (an order only — no count is ever drawn); ties broken by what was tagged a moment ago (no flicker when a
 *  pan settles), then by name for a stable answer. */
export function tagRank(o: { kind: string; plans: number; selected: boolean; wasShown: boolean }): number {
  if (o.selected) return Number.MAX_SAFE_INTEGER
  return (o.kind === 'einsatzobjekt' ? 1_000_000 : 0) + Math.min(o.plans, 999) * 1000 + (o.wasShown ? 1 : 0)
}

/** How far a tag may slide sideways to stay on the map: it keeps this much of itself over its
 *  anchor, so it still reads as hanging off that building. */
export const TAG_KEEP_OVER_ANCHOR = 16

/**
 * The ids that carry their tag, each with how far it slides sideways (px; 0 = centred on its
 * anchor). `occupied` are screen boxes no tag may cover (the chrome); `width`/`height`
 * the map's own size — a tag near a side edge slides inward rather than being cut off (never so
 * far that it leaves its anchor), one that would still run off the map is not placed. `always` is
 * placed whatever it covers (the selected object).
 */
export function placeTags(
  cands: readonly TagCandidate[],
  view: { width: number; height: number; occupied?: readonly Rect[]; gap?: number; always?: string | null; margin?: number },
): Map<string, number> {
  const gap = view.gap ?? 4
  const margin = view.margin ?? 4
  const placed: Rect[] = []
  const out = new Map<string, number>()
  const order = [...cands].sort((a, b) => (a.id === view.always ? -1 : b.id === view.always ? 1 : b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
  for (const c of order) {
    const base = tagRect(c)
    const reach = Math.max(0, c.w / 2 - TAG_KEEP_OVER_ANCHOR)
    const want = base.left < margin ? margin - base.left : base.right > view.width - margin ? view.width - margin - base.right : 0
    const dx = Math.max(-reach, Math.min(reach, want))
    const r = tagRect(c, dx)
    if (c.id !== view.always) {
      if (r.left < 0 || r.top < 0 || r.right > view.width || r.bottom > view.height) continue
      if (view.occupied?.some((o) => overlaps(r, o))) continue
      if (placed.some((p) => overlaps(r, p, gap))) continue
    }
    placed.push(r)
    out.set(c.id, c.id === view.always ? 0 : Math.round(dx))
  }
  return out
}

/** A tag's size without a DOM: the name's measured width (or ~7 px a character) plus the tag's
 *  padding and border (Karte.module.css · .tagMk). */
export function tagSize(textWidth: number): { w: number; h: number } {
  return { w: Math.ceil(textWidth + 16 + 3), h: 26 }
}

export function samePlacement(a: ReadonlyMap<string, number> | null, b: ReadonlyMap<string, number> | null): boolean {
  if (a === b) return true
  if (!a || !b || a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}
