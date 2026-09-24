// The phone tool bar (18.09.2026) — which tools leave the bar for the «+» sheet, and what the «+»
// tile wears. Pure, so the rules are node-testable: ToolRail owns the bar, Palette owns the sheet.
//
// Why: a 360px bar holds five comfortable tiles and the Karte had ten things to put on it, so the
// lane scrolled and its only cue was a fade — «Fläche» dissolving into nothing, which read as a
// rendering glitch and not as «four more tools live here». The answer is the question the
// operator is actually asking: everything that PUTS SOMETHING ON THE SURFACE comes out of one
// door, «+ Hinzufügen», which was already the door to every symbol and Form. Linie · Fläche ·
// Absperrkreis · Notiz · Trupp become the first section of that sheet (components/Palette), with
// their words, without scrolling. What stays on the bar is what adds nothing: Auswahl (the state,
// the way out, and Mehrfach), Messen, and the surface's own view controls.
//
//   Karte:  Auswahl · + Hinzufügen · Messen · Ansichten · Ebenen
//   Plan:   Auswahl · + Hinzufügen · Messen · Einpassen
//
// ⚠️ «+» ALWAYS opens the sheet. It never re-arms a remembered tool: a tile that sometimes opens
// a list and sometimes draws a line has to be remembered, and this bar is for the operator who
// remembers nothing. Two earlier shapes of this were built and thrown out the same day — a
// «Zeichnen» tile with a flyout, then the same tile opening the nav bar's GroupChooser with a
// last-used member behind the first tap — each one idiom more than the sheet that already existed.
// The vertical rail (tablet, desktop) has room for every tool and is unchanged.

/** the tools that live in the «+» sheet on a phone, in sheet order.
 *  ⚠️ Both spellings: the Karte says `note` / `team`, a Plan says `text` / `resource`. */
// `grundgeruest` (the Karte's Lage-Grundgerüst card) is not a tool but belongs behind the same
// door: every row of that card puts something on the Karte, and the bar has no sixth tile.
export const ADD_TOOLS: readonly string[] = ['line', 'area', 'circle', 'note', 'text', 'team', 'resource', 'grundgeruest']

interface ToolLike { id: string; sep?: boolean; slot?: boolean }

/** the members of the «+» sheet's tool section, in the order the rail lists them */
export function addTools<T extends ToolLike>(tools: readonly T[]): T[] {
  return tools.filter((t) => ADD_TOOLS.includes(t.id))
}

/**
 * What the phone BAR keeps: everything that is not in the sheet — and no dividers. With four
 * tools left there is no cluster for a hairline to separate, and each one costs 9px of a bar
 * whose whole point is wide targets.
 */
export function barTools<T extends ToolLike>(tools: readonly T[]): T[] {
  return tools.filter((t) => !t.sep && !ADD_TOOLS.includes(t.id))
}

/**
 * The armed tool the «+» tile wears, or null when nothing out of the sheet is armed.
 *
 * While «Fläche» is armed the tile is lit and shows Fläche's glyph and word — the way «Pläne»
 * wears the loaded plan — so «was macht mein nächster Tipp» is answered on the bar, where the eye
 * already is. A tap on it still opens the sheet.
 */
export function addFace<T extends ToolLike>(tools: readonly T[], active: string): T | null {
  return addTools(tools).find((t) => t.id === active) ?? null
}
