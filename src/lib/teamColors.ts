// One place that decides what colour a Trupp gets on the Lage map or a plan board.
//
// There used to be two, both indexing the same 10-colour palette from different counters: an
// Atemschutz Trupp took `teamColors[its index in the Trupp list]`, a marker dropped via «Neuer
// Trupp» took `teamColors[number of team markers already placed]`. Neither knew about the
// other, so the second Trupp on the board and the second loose marker were both `teamColors[1]`
// — two identically-coloured Trupps on one Lage, which is precisely the thing the colour is
// there to prevent. Deleting one and placing another shifted the counters and did it again.
//
// The rule now: take the colour you would have had if it is still free, otherwise the first
// free one. Only when all ten are out does it wrap — at which point the Lage has ten Trupps and
// a repeat is unavoidable (and honest).

import { appConfig } from '../config/appConfig'

/** The hues the palette wore until 13.11.2026 that are STATE colours (red, green, amber) or sit
 *  beside them (lime, brown) – M4, owner's pick A. A marker or plan chip placed before then keeps
 *  the colour it stored (synced state is never rewritten); it is SHOWN in a stand-in. The three
 *  common ones (the 2nd–4th Trupp) get the three hues the old palette did not have, so an old
 *  Einsatz gains no duplicate; lime and brown (a 8th / 9th Trupp) share theirs. */
const RETIRED: Readonly<Record<string, string>> = {
  '#e8392b': '#c42fd8', '#1f9d57': '#6366f1', '#e2920a': '#0284c7', '#65a30d': '#6366f1', '#b45309': '#0284c7',
}

/** The colour a Trupp's ring, dot, chip or trail is DRAWN in: its stored colour, a retired hue
 *  mapped to its stand-in, and the palette's first one when nothing is stored. Every place that
 *  paints a Trupp colour reads it here, so the board and the Lage never disagree. */
export function shownTeamColor(color: string | null | undefined): string {
  if (!color) return appConfig.drawing.teamColors[0]
  return RETIRED[color.toLowerCase()] ?? color
}

/**
 * Pick a distinct team colour.
 *
 * @param preferred the colour this Trupp would normally get (its palette slot); `undefined` for
 *   a loose marker, which has no claim to any particular one
 * @param used every colour currently taken by a placed marker, a plan chip or a known Trupp
 */
export function pickTeamColor(preferred: string | undefined, used: Iterable<string | undefined>): string {
  const palette = appConfig.drawing.teamColors
  const taken = new Set<string>()
  // a stored retired hue is worn as its stand-in (shownTeamColor): that stand-in is what is taken
  for (const c of used) if (c) taken.add(shownTeamColor(c).toLowerCase())
  if (preferred && !taken.has(preferred.toLowerCase())) return preferred
  const free = palette.find((c) => !taken.has(c.toLowerCase()))
  if (free) return free
  // every colour is in use — fall back to the palette slot the caller wanted, or cycle by how
  // many are taken, so the repeat is at least spread out rather than always landing on the first
  return preferred ?? palette[taken.size % palette.length]
}
