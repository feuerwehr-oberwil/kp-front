// The armed tool's READOUT – the plain first tile of its dock (components/ToolDock · `armed`) while a
// tool is armed on the Karte, a Plan or the Tafel: the tool's glyph over its short name, one word
// («Linie», «Absperrkreis», «Unfall»), never a sentence, never a button (owner 23.10.2026: «a small
// little info thing … that now you're placing symbol XYZ and that's it»). It was a pill of its own
// at the bottom centre until the button round (owner picks 14 + 15, 17.11.2026): every bottom row
// is one bar now, on the phone and in the tablet's column alike.
//
// ONE builder for both surfaces (MapToolDocks, Whiteboard), so the Lage and the Plan name an armed
// tool the same way by construction. A symbol wears its own drawing and name (format ·
// formatSymbolName), a Form its preview and name, every other tool its rail tile's glyph and word.
// The input mode (Freihand / Punkte / Wand) is NOT in the name: the lit toggle beside it says it.
import type { ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import type { BoardTool, MapTool, ShapeKind } from '../types'
import { formatSymbolName } from './format'
import { Icon } from './icons'
import { sanitizeSvg } from './sanitizeSvg'
import { SHAPE_DEFS, ShapeGlyph } from './shapes'

/** The armed tool as its dock's first tile names it: a glyph and one word. */
export interface ArmedReadout { glyph: ReactNode; name: string }

type ToolEntry = { id: string; icon: string; label: string; alt?: { id: string; icon: string; label: string } }

/** the tool's rail entry – its own, or the tile whose second state it is (Mehrfach on Auswahl) */
const entryFor = (tool: MapTool | BoardTool, tools: readonly ToolEntry[]) => {
  for (const t of tools) {
    if (t.alt?.id === tool) return t.alt
    if (t.id === tool) return t
  }
  return null
}

/**
 * The readout's word for `tool`, read from the surface's tool list (`mapTools` on the Karte,
 * `planTools` on a Plan) – so it always says what the rail tile says, in the deployment's
 * language. An unknown id answers null.
 */
export function armedToolName(tool: MapTool | BoardTool, tools: readonly ToolEntry[]): string | null {
  return entryFor(tool, tools)?.label ?? null
}

/** the readout's glyph for `tool`: the rail tile's icon id (lib/icons) */
export function armedToolIcon(tool: MapTool | BoardTool, tools: readonly ToolEntry[]): string | null {
  return entryFor(tool, tools)?.icon ?? null
}

/**
 * The readout for the armed `tool`, or null where there is nothing to name yet (the symbol tool
 * before a symbol is picked, the Form tool before a Form is). `symbol` is the picked symbol's name
 * and `svg` its drawing; `shape` the Form being placed. The caller decides where a readout belongs
 * – Messen has none (its results panel names it).
 */
export function armedReadout(tool: MapTool | BoardTool, tools: readonly ToolEntry[], picked: { symbol?: string | null; label?: string; svg?: string; shape?: ShapeKind | null }): ArmedReadout | null {
  // a symbol's own SVG – ⚠️ SEC-01, sanitised at this sink: the markup can be an editor-supplied
  // `symbolSvg` (components/Palette · Cell has the same note)
  // an own vehicle armed by its Bezeichnung («TLF», components/Palette · VehicleTile) says that name
  if (tool === 'symbol') return picked.symbol ? { glyph: <span className="wb-dock-sym" dangerouslySetInnerHTML={{ __html: sanitizeSvg(picked.svg ?? '') }} />, name: picked.label || formatSymbolName(picked.symbol) || picked.symbol } : null
  if (tool === 'shape') {
    const kind = picked.shape
    return kind ? { glyph: <ShapeGlyph kind={kind} color="currentColor" aspect={SHAPE_DEFS[kind].defaultAspect} fit />, name: appConfig.copy.shapes.names[kind] ?? appConfig.copy.shapes.kindLabel } : null
  }
  const name = armedToolName(tool, tools)
  const icon = armedToolIcon(tool, tools)
  return name && icon ? { glyph: <Icon id={icon} />, name } : null
}
