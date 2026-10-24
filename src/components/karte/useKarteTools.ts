// «Karte & Objekte» — the reference tools: Punkt setzen, Messen, Gefahrgut, and Ebenen as a tool
// of its own (docs/karte-objekte.md · «The viewer»). Nothing they make is ever saved.

import { useState } from 'react'
import { primeKeyboard } from '../../lib/keyboardPrime'
import { useMeasure } from '../../lib/useMeasure'
import { DEFAULT_ERG_RING_MODE } from '../../lib/ergRings'
import type { ErgState } from '../../lib/karte/overlays'
import type { LngLat } from '../../types'

export type Tool = null | 'pin' | 'measure' | 'erg' | 'layers'

/** The armed tool (`initial`: the one the session kept — only WHICH one, lib/karte/session; never
 *  the pin mode), Messen's path, Gefahrgut's number, mode and centre, and whether the compass menu
 *  is open (an armed tool closes it). What the rest of the surface does about a tool (a phone's
 *  tool leaves the plan and the search) is the surface's, around `toggleTool`. */
export function useKarteTools(initial: Tool) {
  const [tool, setToolState] = useState<Tool>(initial)
  const measure = useMeasure(tool === 'measure')
  const [erg, setErg] = useState<ErgState>(() => ({ un: '', mode: DEFAULT_ERG_RING_MODE, center: null, at: new Date() }))
  const [viewsOpen, setViewsOpen] = useState(false)
  // the phone's Gefahrgut opened by a TAP with no UN number yet: the number pad comes up at once
  // (owner, review round 3); with a number set it opens on the result, no keyboard. Only a tap may
  // raise it (iOS), so a Gefahrgut restored with the session never takes the caret.
  const [ergKeys, setErgKeys] = useState(false)
  /** the phone's bar tapped `t`: decide the number pad — inside the tap, as iOS raises the keyboard
   *  only for a focus made in it (lib/keyboardPrime) */
  const keysFor = (t: Tool) => {
    const keys = t === 'erg' && tool !== 'erg' && !erg.un
    if (keys) primeKeyboard()
    setErgKeys(keys)
  }
  /** arm `t`, or disarm it when it is the armed one; Gefahrgut without a centre yet takes `at()` */
  const toggleTool = (t: Tool, at: () => LngLat) => {
    setToolState((cur) => {
      const next = cur === t ? null : t
      if (cur === 'measure' && next !== 'measure') measure.reset()
      return next
    })
    setViewsOpen(false)
    if (t === 'erg' && !erg.center) setErg((e) => ({ ...e, center: at(), at: new Date() }))
  }
  return { tool, setToolState, toggleTool, measure, erg, setErg, viewsOpen, setViewsOpen, ergKeys, keysFor }
}
