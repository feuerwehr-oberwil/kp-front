import { useCallback, useState } from 'react'
import type { LngLat, MapTool, ShapeKind } from '../types'

/** The armed tool and what it will place next — the pending symbol / shape and the place-lock —
 *  identical on both surfaces: the Lage map (through useTacticalSelection below) and the Plan
 *  board (Whiteboard), which differ only in their tool vocabulary and their rest tool
 *  (`'select'` / `'pan'`). Session-only, never persisted or synced.
 *  `pendingLabel` is the name the symbol is placed WITH – an own vehicle found by its Bezeichnung
 *  in the palette («TLF», lib/symbolSearch · vehicleHits) lands already named. Arming without
 *  one clears it, so no later Fahrzeug inherits it. */
export function usePlacement<T extends string>(rest: T) {
  const [tool, setTool] = useState<T>(rest)
  const [armed, setArmed] = useState<{ symbol: string; label?: string } | null>(null)
  const pending = armed?.symbol ?? null
  const pendingLabel = armed?.label
  const setPending = useCallback((symbol: string | null, label?: string) => setArmed(symbol ? { symbol, label } : null), [])
  const [pendingShape, setPendingShape] = useState<ShapeKind | null>(null)
  // when on, placing a symbol/shape keeps place-mode active for rapid multi-placement
  const [placeLock, setPlaceLock] = useState(false)
  return { tool, setTool, pending, pendingLabel, setPending, pendingShape, setPendingShape, placeLock, setPlaceLock }
}

/** Session-only tactical editing state for the Lage map surface: the placement state above,
 *  the Team coord awaiting its Trupp, and what's selected (a single entity or drawing, or a
 *  lasso'd group spanning both). None of it is persisted or synced — it's cleared on replay
 *  entry (enterReplay) and threaded into useMapDrawing (which owns the draft + draw-style state),
 *  so the handlers behave identically to their former inline selves. The Plan keeps its own
 *  selection (one id across every kind), so it shares only `usePlacement`. */
export function useTacticalSelection() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const placement = usePlacement<MapTool>('select')
  // map Team tool: the tapped coord awaiting the «Welcher Trupp?» choice (mirrors the plan)
  const [teamPick, setTeamPick] = useState<LngLat | null>(null)
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null)
  // marquee group selection — mutually exclusive with single-edit selection. The lasso boxes
  // drawings AND placed entities (symbols/shapes/notes), so the group spans both sets.
  const [selectedDrawIds, setSelectedDrawIds] = useState<string[]>([])
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([])
  return {
    ...placement,
    selectedId, setSelectedId,
    teamPick, setTeamPick,
    selectedDrawingId, setSelectedDrawingId,
    selectedDrawIds, setSelectedDrawIds,
    selectedEntityIds, setSelectedEntityIds,
  }
}
