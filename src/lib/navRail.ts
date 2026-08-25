import type { PlanDocument } from '../types'

// Pure rail geometry + glyph helpers — no DOM/React, so the snap math and the
// per-document monogram/icon mapping are node-testable in isolation (the live
// drag wiring in NavRail.tsx just calls these).

/** clamp a live drag width into the rail's [min,max] travel */
export function clampRailWidth(w: number, min = 60, max = 216): number {
  return Math.max(min, Math.min(max, w))
}

/** on release, snap to expanded iff the rail was pulled past the snap point */
export function snapExpanded(width: number, snap = 138): boolean {
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
