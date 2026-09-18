import type { PlanDocument } from '../types'

// Pure rail geometry + glyph helpers — no DOM/React, so the snap math and the
// per-document monogram/icon mapping are node-testable in isolation (the live
// drag wiring in lib/useRail.ts just calls these).

/** The travel BOTH rails share — the left NavRail and the right ToolRail are one mechanic in two
 *  mirror images (lib/useRail), so their widths live in one place and cannot drift apart.
 *
 *  ⚠️ They have to be numbers here as well as widths in CSS: everything that sits beside a rail
 *  (the map controls, the docks) is positioned off the published `--rail-w` / `--vrail-w`, so a
 *  rail that got wider only in the stylesheet would be overlapped by them.
 *
 *  RAIL_COMPACT — the icon-only width.
 *  RAIL_LABELLED — ⚠️ the compact width with room for a word UNDER the glyph («Wort unter dem
 *    Zeichen», lib/prefs · railLabels): «Anwesenheit» measures 76px in the app's own Sora at
 *    10.5px, so 88 is what fits with the rail's padding.
 *  RAIL_WIDE — the committed expanded width. */
export const RAIL_COMPACT = 60
export const RAIL_LABELLED = 88
export const RAIL_WIDE = 216

/** clamp a live drag width into the rail's [min,max] travel */
export function clampRailWidth(w: number, min = RAIL_COMPACT, max = RAIL_WIDE): number {
  return Math.max(min, Math.min(max, w))
}

/** on release, snap to expanded iff the rail was pulled past the snap point (the midpoint of the
 *  compact→wide travel, which is where both rails have always put it) */
export function snapExpanded(width: number, snap = (RAIL_COMPACT + RAIL_WIDE) / 2): boolean {
  return width > snap
}

/** The SHORT label a synthesized module tile carries in the rail.
 *
 *  Modul 4 and the Modul-5 sub-sheets have no fixed tile in the catalog, so their label has to
 *  come from the data. A station whose PDFs are named after the sub-sheet ("Wasser.pdf") hands
 *  us the right word; Oberwil's carry the object name and the raw module key
 *  ("Migros – modul5-rwa"), which is neither short nor a name — and the rail is 216px wide, so
 *  that label ran straight off its edge.
 *
 *  So the dataset title is used only when it LOOKS like a sub-sheet name; otherwise the sub-slot
 *  key out of the id, which is the structural part and always clean:
 *  "modul5-rwa" → "RWA" (an acronym stays upper), "modul5-wasser" → "Wasser".
 *
 *  An object can hold SEVERAL sheets of one kind — «Modul 5 - Wasser 1» and «… Wasser 2» are two
 *  waterplans, and each gets its own tile. The trailing number is part of the sub-slot
 *  ("modul5-wasser2") and has to survive into the label, or the two tiles read the same word:
 *  "modul5-wasser2" → "Wasser 2", "modul5-pv15" → "PV 15". */
export function moduleTileLabel(id: string, title?: string): string {
  const sub = /^modul\d+-([a-z0-9]+)/i.exec(id)?.[1]
  if (!sub) return `Modul ${/^modul(\d+)/i.exec(id)?.[1] ?? '?'}`
  const label = (title ?? '').trim()
  // Short, and not just the module key echoed back at us.
  if (label && label.length <= 16 && !/modul/i.test(label)) return label
  const parts = /^([a-z]+)(\d*)$/i.exec(sub)
  const word = parts?.[1] ?? sub
  const num = parts?.[2] ?? ''
  const cased = word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()
  return num ? `${cased} ${num}` : cased
}

/** the glyph a plan item renders: a monogram (1…/2/3) for modules + the floor-stack,
 *  otherwise an icon (the doc's own, falling back to pen for the blank Tafel / doc). */
export function planGlyph(doc: PlanDocument): { mono: string } | { icon: string } {
  // a combined sheet (e.g. id "modul2-3" / "modul23" from a "Modul 2-3.pdf") shows the
  // fractional "2/3" monogram; a single module shows the bare number ("2" — the M prefix
  // added nothing and crowded the narrow phone bar items).
  const range = /^modul(\d+)[-_/](\d+)/i.exec(doc.id)
  if (range) return { mono: `${range[1]}/${range[2]}` }
  // a Modul-5-style sub-slot ("modul5-pv", "modul5-wasser"): show the short code (e.g. "PV") or
  // the sub-slot name's first letters — NOT the bare "5" the digit rule below would give, so the
  // sub-sheets stay distinguishable in the rail.
  // A numbered sibling ("modul5-wasser2") keeps its number in the monogram — WAS1/WAS2, not two
  // identical WAS chips — so the collapsed rail still tells the two waterplans apart.
  const sub = /^modul\d+-([a-z]*)(\d*)/i.exec(doc.id)
  if (sub) {
    const word = sub[1] ?? ''
    const num = sub[2] ?? ''
    const code = (doc.code ?? '').trim()
    if (code && code.length <= 4 && !/^modul/i.test(code)) return { mono: code.toUpperCase() }
    return { mono: `${word.slice(0, num ? Math.max(1, 4 - num.length) : 3)}${num}`.toUpperCase() }
  }
  const m = /^modul(\d+)/i.exec(doc.id)
  if (m) return { mono: m[1] }
  // The merged «Gebäude» tile (outline picker ⇄ floor stack) carries its glyph as DATA — the
  // storey icon once a stack exists, the footprint while it does not, which is how the rail says
  // whether there is a stack without being opened. See lib/useObjectPlans · railPlanTiles.
  if (doc.floorStack) return { icon: doc.icon ?? 'floors' } // Gebäude floor-stack: stacked-floors icon, not a bare "G"
  if (doc.id === 'tafel') return { icon: doc.icon ?? 'pen' }
  return { icon: doc.icon ?? 'doc' }
}

/** the digit(s) that address this plan doc from the keyboard — the numbers in its rail glyph.
 *  A single module ("2") → [2]; a combined sheet ("2/3") → [2, 3] (either digit opens it); a
 *  sub-slot ("PV"), the Tafel and the merged Gebäude tile carry no number → [] (reach them by
 *  stepping the nav with Cmd+[ / Cmd+]). Keeps the digit→module map in lockstep with planGlyph. */
export function moduleNumbers(doc: PlanDocument): number[] {
  // A sub-slot answers to no digit — and a NUMBERED one ("modul5-wasser2") must not answer to
  // its sheet number either: that 2 is the second waterplan, not Modul 2.
  if (/^modul\d+-\D/i.test(doc.id)) return []
  const g = planGlyph(doc)
  if (!('mono' in g)) return []
  const nums = g.mono.match(/\d+/g)
  return nums ? nums.map(Number) : []
}

/** What the phone bar's ONE folded «Pläne» tile stands for (18.09.2026).
 *
 *  A phone bar has room for a handful of tiles, and a station with four modules plus a Gebäude
 *  had eleven — so the bar scrolled, and the destinations past the fade could not be recognised
 *  at all. The plan documents fold into one tile that WEARS the loaded document's own glyph (the
 *  mono chip «1»/«RWA», the floor stack, the Tafel's pencil) and is worded «Pläne»: the glyph
 *  carries the recognition, the word carries the destination.
 *
 *  ⚠️ No sub-label. It used to stack chip + «Pläne» + the document code into a 46px tile, three
 *  lines of type where every other tile has one glyph and one word (field report 18.09.). The
 *  code survives in the tile's aria-label, which is where a reader who cannot see the glyph
 *  needs it. */
export interface FoldedPlans {
  /** the document a first tap opens — the active/last-used one, else the first in the list.
   *  It is also the tile's GLYPH, so `target.code` is all a label ever needs from it. */
  target: PlanDocument
  /** more than one document, so there is something for a chooser to choose BETWEEN. With one
   *  document a second tap and a hold do nothing: a list of one answers no question. */
  many: boolean
}

/** Fold every plan document into the single phone tile. `null` = no documents at all, which is
 *  the rail's existing empty state: no tile and no separator, rather than a tile that opens
 *  nothing. */
export function foldPlanTiles(docs: PlanDocument[], activeId: string): FoldedPlans | null {
  if (docs.length === 0) return null
  // `activeId` is the plan the workspace already tracks, and it survives a trip to the Karte —
  // so «last used» needs no store of its own. An id that no longer resolves (the object was
  // switched) falls back to the first document instead of showing a code for nothing.
  const target = docs.find((d) => d.id === activeId) ?? docs[0]
  return { target, many: docs.length > 1 }
}

/**
 * One stop of ⌘[ / ⌘] — the flat order the rail is read in, top to bottom.
 *
 * It is the RAIL's list, not the catalogue: the step lands on tiles, so a stop with no tile is
 * a chevron that lands nowhere. That cuts both ways, and both ways are load-bearing —
 *  · the Rapport is a tile everywhere, so it is a stop; leaving it out made the phone's
 *    Anwesenheit/Material redirect a dead end (the step arrived on a mode the list did not
 *    know, and the next press had nowhere to go from);
 *  · Anwesenheit and Material lose their tiles the moment the phone bar folds them into that
 *    Rapport (18.09.2026, NavRail · `fold`), so while it is folded they stop being stops.
 */
export type NavStop =
  | { mode: 'plans'; planId: string }
  | { mode: 'map' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel' | 'rapport' }

export function navStops(planIds: string[], phoneFold: boolean): NavStop[] {
  return [
    { mode: 'map' },
    ...planIds.map((planId): NavStop => ({ mode: 'plans', planId })),
    { mode: 'checklists' },
    { mode: 'atemschutz' },
    ...(phoneFold ? [] : [{ mode: 'anwesenheit' } as NavStop, { mode: 'mittel' } as NavStop]),
    { mode: 'rapport' },
  ]
}
