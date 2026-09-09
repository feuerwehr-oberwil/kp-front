import { useState } from 'react'
import type { LngLat, ShapeKind } from '../types'

/** Session-only tactical editing state for the Lage map surface: the active tool, the
 *  in-progress place gesture (pending symbol / shape / place-lock / Team coord), and what's
 *  selected (a single entity or drawing, or a lasso'd group spanning both). None of it is
 *  persisted or synced — it's cleared on replay entry (enterReplay) and threaded into
 *  useMapDrawing (which owns the draft + draw-style state), so the handlers behave identically
 *  to their former inline selves. */
export function useTacticalSelection() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tool, setTool] = useState('select')
  // map Team tool: the tapped coord awaiting the «Welcher Trupp?» choice (mirrors the plan)
  const [teamPick, setTeamPick] = useState<LngLat | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [pendingShape, setPendingShape] = useState<ShapeKind | null>(null)
  // when on, placing a symbol/shape keeps place-mode active for rapid multi-placement
  const [placeLock, setPlaceLock] = useState(false)
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null)
  // marquee group selection — mutually exclusive with single-edit selection. The lasso boxes
  // drawings AND placed entities (symbols/shapes/notes), so the group spans both sets.
  const [selectedDrawIds, setSelectedDrawIds] = useState<string[]>([])
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([])
  return {
    selectedId, setSelectedId,
    tool, setTool,
    teamPick, setTeamPick,
    pending, setPending,
    pendingShape, setPendingShape,
    placeLock, setPlaceLock,
    selectedDrawingId, setSelectedDrawingId,
    selectedDrawIds, setSelectedDrawIds,
    selectedEntityIds, setSelectedEntityIds,
  }
}
