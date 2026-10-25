import { useState } from 'react'
import type { LngLat, MapTool, ShapeKind } from '../types'

/** The armed tool and what it will place next — the pending symbol / shape and the place-lock —
 *  identical on both surfaces: the Lage map (through useTacticalSelection below) and the Plan
 *  board (Whiteboard), which differ only in their tool vocabulary and their rest tool
 *  (`'select'` / `'pan'`). Session-only, never persisted or synced. */
export function usePlacement<T extends string>(rest: T) {
  const [tool, setTool] = useState<T>(rest)
  const [pending, setPending] = useState<string | null>(null)
  const [pendingShape, setPendingShape] = useState<ShapeKind | null>(null)
  // when on, placing a symbol/shape keeps place-mode active for rapid multi-placement
  const [placeLock, setPlaceLock] = useState(false)
  return { tool, setTool, pending, setPending, pendingShape, setPendingShape, placeLock, setPlaceLock }
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
