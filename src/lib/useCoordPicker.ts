import { useEffect, useState } from 'react'
import type { LngLat } from '../types'

// Coordinate picker, extracted from App's god component. Ephemeral state (never saved):
// a one-shot crosshair that reads out LV95/WGS84 for a point on the map.

export type CoordMode = 'off' | 'aim' | 'set'

export interface CoordPicker {
  mode: CoordMode
  setMode: (m: CoordMode) => void
  aim: LngLat | null
  setAim: (c: LngLat | null) => void
  picked: LngLat | null
  setPicked: (c: LngLat | null) => void
  /** the toolbar button: off→aim, aim→off (cancel), set→aim (re-pick) */
  cycle: () => void
  /** point to show in the readout: the locked pick (set), or the live crosshair / map
   *  centre (aim), or nothing (off) */
  readout: LngLat | null
}

/**
 * One-shot coordinate crosshair: `off` (hidden) → `aim` (follows cursor) → `set` (locked
 * on click). When the create-incident form requests a location, `createPickActive` drops
 * straight into aim. `viewCenter` is the live map centre used as the aim fallback before
 * the cursor has moved.
 */
export function useCoordPicker(createPickActive: boolean, viewCenter: LngLat): CoordPicker {
  const [mode, setMode] = useState<CoordMode>('off')
  const [aim, setAim] = useState<LngLat | null>(null)
  const [picked, setPicked] = useState<LngLat | null>(null)

  // when the create form requests a map location, drop into the aim tool; the caller's
  // onPick reports the coordinate back up and the form reopens with it
  useEffect(() => {
    if (createPickActive) { setMode('aim'); setAim(null); setPicked(null) }
  }, [createPickActive])

  const cycle = () => {
    setAim(null); setPicked(null)
    setMode((m) => (m === 'aim' ? 'off' : 'aim'))
  }
  const readout = mode === 'set' ? picked : mode === 'aim' ? (aim ?? viewCenter) : null

  return { mode, setMode, aim, setAim, picked, setPicked, cycle, readout }
}
