// «Karte & Objekte» — what the pointer is about to open (docs/karte-objekte.md · «Die Häuser»):
// the mouse's hover and the finger's hold, one highlight with two ways in. Both listen on the
// map's canvas container, added once when the map has settled (`watchHover`, `watchPress`), and
// call the handler of the latest render.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import { LONG_PRESS_MOVE_TOL_PX, LONG_PRESS_MS } from '../../lib/useLongPress'
import { buzz } from '../../lib/haptics'
import type { NamedPoint } from '../../lib/karte/places'
import { sameHover, type Hover } from '../../lib/karte/selection'
import type { LngLat } from '../../types'

/** how close (px) the mouse must come to a hydrant on the map to name it */
const HYDRANT_HOVER_PX = 14

/** The hydrant within HYDRANT_HOVER_PX of the mouse (`at`, canvas px; `c`, its lng/lat) */
function hydrantUnder(map: MapRef, at: { x: number; y: number }, c: LngLat, hydrants: readonly NamedPoint[]): string | null {
  // only the hydrants within the hover reach (degrees, with room for a turned map) are projected
  const edge = map.unproject([at.x + HYDRANT_HOVER_PX, at.y + HYDRANT_HOVER_PX])
  const reach = Math.max(Math.abs(edge.lng - c[0]), Math.abs(edge.lat - c[1])) * 1.5
  let best: string | null = null
  let bestPx: number = HYDRANT_HOVER_PX
  for (const h of hydrants) {
    if (Math.abs(h.coord[0] - c[0]) > reach || Math.abs(h.coord[1] - c[1]) > reach) continue
    const q = map.project(h.coord)
    const d = Math.hypot(q.x - at.x, q.y - at.y)
    if (d < bestPx) { bestPx = d; best = h.id }
  }
  return best
}

/**
 * The mouse and the trackpad only (owner, Karte Haus round 1). Touch never shows a hover state:
 * only `pointerType === 'mouse'` moves are read (a finger's tap also sends compat mouse events,
 * which never reach here). The pointer cursor stands over whatever a click opens — an object's
 * building, a plain building (`buildingAt`; a tag has its own) — and the normal one elsewhere and
 * while a tool takes the taps. Over a hydrant (`hydrants`: only while their layer is on) the label
 * says how far and which way it lies from the selected place — and it stays not clickable.
 * `shownHover` is the target (state: it changes rarely, and goes at once when a tool is armed
 * under a still mouse); the label (`tipRef`) follows the pointer by its style, inside `rootRef`,
 * so a mouse move re-renders nothing.
 */
export function useMapHover(p: {
  mapRef: RefObject<MapRef | null>
  rootRef: RefObject<HTMLDivElement | null>
  takesTaps: boolean
  hydrants: readonly NamedPoint[]
  buildingAt: (c: LngLat) => Hover | null
}) {
  const { mapRef, rootRef, takesTaps, hydrants, buildingAt } = p
  const [hover, setHover] = useState<Hover | null>(null)
  const hoverNow = useRef<Hover | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const placeTip = useCallback(() => {
    const el = tipRef.current, pt = pointer.current, root = rootRef.current
    if (!el || !pt || !root) return
    const r = root.getBoundingClientRect()
    const x = pt.x - r.left, y = pt.y - r.top
    const left = x + 16 + el.offsetWidth > r.width - 8 ? x - el.offsetWidth - 12 : x + 16
    const top = y + 18 + el.offsetHeight > r.height - 8 ? y - el.offsetHeight - 12 : y + 18
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }, [rootRef])
  const onHoverMove = (e: PointerEvent | null) => {
    const map = mapRef.current
    const canvas = map && typeof map.getCanvas === 'function' ? map.getCanvas() : null
    let next: Hover | null = null
    pointer.current = e ? { x: e.clientX, y: e.clientY } : null
    // over the canvas itself, no button held (a pan), no tool taking the taps
    if (map && canvas && e && e.target === canvas && !e.buttons && !takesTaps) {
      const r = canvas.getBoundingClientRect()
      const at = { x: e.clientX - r.left, y: e.clientY - r.top }
      const ll = map.unproject([at.x, at.y])
      const c: LngLat = [ll.lng, ll.lat]
      const hy = hydrants.length ? hydrantUnder(map, at, c, hydrants) : null
      next = hy ? { kind: 'hydrant', id: hy } : buildingAt(c)
    }
    if (canvas) canvas.style.cursor = next && next.kind !== 'hydrant' ? 'pointer' : 'default'
    if (!sameHover(hoverNow.current, next)) { hoverNow.current = next; setHover(next) }
    placeTip()
  }
  const hoverMove = useRef(onHoverMove)
  useEffect(() => { hoverMove.current = onHoverMove })
  const watchingHover = useRef(false)
  const watchHover = useCallback(() => {
    const map = mapRef.current?.getMap?.()
    if (!map || typeof map.getCanvasContainer !== 'function' || watchingHover.current) return
    watchingHover.current = true
    const box = map.getCanvasContainer()
    let frame = 0
    let last: PointerEvent | null = null
    box.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return
      last = e
      frame ||= requestAnimationFrame(() => { frame = 0; hoverMove.current(last) })
    })
    box.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hoverMove.current(null) })
  }, [mapRef])
  // a tool armed under a still mouse: the hover goes at once, not on the next move
  const shownHover = takesTaps ? null : hover
  // the label's place, after the render that changed what it says (it is only mounted with a text)
  useLayoutEffect(() => { placeTip() }, [shownHover, placeTip])
  return { shownHover, tipRef, watchHover }
}

/**
 * The finger's hold (owner, review round 7, points 7 + 11). A touch has no hover, so until the
 * finger lifted nothing on screen said WHAT it was about to open («highlight the building outlines
 * on hold so we know what we're pressing before we let go»). Now the press itself answers
 * (`pressed`), with the mouse's own outline:
 *  · on a building or an object (`buildingAt`): it lights up while the finger is down, and the
 *    release opens it exactly as a tap always did. NOT a pin — a hold there is a question, not a place.
 *  · on free map: past the long press (lib/useLongPress · LONG_PRESS_MS, the one beat every still
 *    hold in the app answers on) a pin drops where the finger is (`dropPin`), as «Punkt setzen» + tap.
 * The owner settled that split himself (grilling, 20.10.2026), so it is not widened here: no pin
 * over a building, no highlight while a tool takes the taps (`takesTaps` — round 3 killed the old
 * hold because it fired everywhere: «I can't delete nodes when measuring because it wants to
 * create a point»; holding a measure node is how Messen removes it, MapView · vertexPress). Any
 * movement past the drag tolerance is a pan and cancels both — the map must stay a map.
 *
 * `swallowClick()` is the map's click handler's first question: maplibre still fires its `click`
 * on the release after a hold that dropped a pin, and that click — a tap on free map — would
 * deselect the pin the hold just set.
 */
export function useMapPress(p: {
  mapRef: RefObject<MapRef | null>
  takesTaps: boolean
  buildingAt: (c: LngLat) => Hover | null
  dropPin: (c: LngLat) => void
}) {
  const { mapRef, takesTaps, buildingAt, dropPin } = p
  const [pressed, setPressed] = useState<Hover | null>(null)
  /** set while the hold has already answered this press */
  const heldClick = useRef(false)
  /** What this press means, decided the moment the finger lands. `null` = not ours (a mouse, a
   *  marker, an armed tool); `pin` = free map, so the hold is a gesture and gets the timer. */
  const onPressDown = (e: PointerEvent): { pin: (() => void) | null } | null => {
    const map = mapRef.current
    const canvas = map && typeof map.getCanvas === 'function' ? map.getCanvas() : null
    // touch/pen only (a mouse has the hover), on the canvas itself (a marker, a handle and the
    // measure nodes own their own press), and never under a tool that takes the map's taps
    if (!map || !canvas || e.target !== canvas || takesTaps) return null
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return null
    const r = canvas.getBoundingClientRect()
    const ll = map.unproject([e.clientX - r.left, e.clientY - r.top])
    const c: LngLat = [ll.lng, ll.lat]
    const hit = buildingAt(c)
    if (hit) { setPressed(hit); return { pin: null } }
    // free map: the hold is the gesture, and the release that follows it is not a tap any more
    return { pin: () => { heldClick.current = true; dropPin(c); buzz() } }
  }
  const pressDown = useRef(onPressDown)
  useEffect(() => { pressDown.current = onPressDown })
  const watchingPress = useRef(false)
  const watchPress = useCallback(() => {
    const map = mapRef.current?.getMap?.()
    if (!map || typeof map.getCanvasContainer !== 'function' || watchingPress.current) return
    watchingPress.current = true
    const box = map.getCanvasContainer()
    let live: { x: number; y: number; timer: number } | null = null
    const end = () => {
      if (live) { clearTimeout(live.timer); live = null }
      setPressed((v) => (v ? null : v))
    }
    box.addEventListener('pointerdown', (e) => {
      end()
      const press = pressDown.current(e)
      if (!press) return
      const timer = press.pin ? window.setTimeout(() => { live = null; press.pin?.() }, LONG_PRESS_MS) : 0
      live = { x: e.clientX, y: e.clientY, timer }
    })
    // past the tolerance the finger is panning, not pressing: the pin disarms and the lit
    // outline goes out, or the map would answer a drag with a selection
    box.addEventListener('pointermove', (e) => {
      if (live && Math.hypot(e.clientX - live.x, e.clientY - live.y) > LONG_PRESS_MOVE_TOL_PX) end()
    })
    box.addEventListener('pointerup', end)
    box.addEventListener('pointercancel', end)
    // Android answers a long press with its own context menu — ours is the pin (lib/holdTooltip
    // does the same for the buttons it explains)
    box.addEventListener('contextmenu', (e) => { if (live || heldClick.current) e.preventDefault() })
  }, [mapRef])
  const swallowClick = () => {
    if (!heldClick.current) return false
    heldClick.current = false
    return true
  }
  return { pressed, watchPress, swallowClick }
}
