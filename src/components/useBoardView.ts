import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import type { BuildingDoc, PlanDocument } from '../types'
import type { PlanScale } from '../lib/planScale'
import { TOP_INSET } from '../lib/whiteboard'

/**
 * The Whiteboard's zoom/pan view state. Zoom is by LAYOUT (board pixel size = fit ×
 * scale), not a CSS transform, so the PDF + symbols + text re-rasterize crisply at the
 * actual zoom. Mirrors scale/pos into refs so wheel/pinch/button math reads current
 * values synchronously (StrictMode-safe). Owns the focal-point wheel-zoom listener.
 */
/** Zoom bounds. 1 is «eingepasst» (the board exactly fills the canvas), NOT a real-world
 *  scale — so the floor below it buys margin AROUND the plan: room to drag a symbol to an
 *  edge, and a whole Gebäude floor-stack in one view. Below fit the board stays centred
 *  (see zoomTo), because panning a board smaller than its canvas only loses it. */
export const MIN_SCALE = 0.6
export const MAX_SCALE = 6

/** A board view as it is remembered: the layout zoom, the pan offset in canvas px, and the
 *  `sig` the plan had when it was put away (see boardViewSignature). */
export interface BoardView { scale: number; x: number; y: number; sig: string }
/** planId → last view. Held by the CALLER, like the plan undo stacks (see Whiteboard · hist):
 *  the Whiteboard unmounts on every surface switch, so a memory kept in its own state would be
 *  thrown away by the very act it exists to survive. */
export type BoardViews = Record<string, BoardView>

/** «eingepasst» — the board exactly fills the canvas, centred. What a first visit opens at. */
export const FIT_VIEW = { scale: 1, x: 0, y: 0 } as const

/**
 * The view a board opens at — the Plan twin of the map's `resumeViewState` (lib/mapView):
 * the operator's own framing when we have one, else the default.
 *
 * Remembered only while the plan still LOOKS the way it did: a zoom into the top-left corner of
 * a plan whose image, floor stack or calibration has since changed frames something else now, so
 * a stale `sig` falls back to fit instead of dropping the operator somewhere arbitrary.
 */
export const resumeBoardView = (saved: BoardView | undefined, sig: string) =>
  (saved && saved.sig === sig ? { scale: saved.scale, x: saved.x, y: saved.y } : FIT_VIEW)

/**
 * What must still hold for a remembered view to mean the same thing. Deliberately NOT derived
 * from anything that settles DURING a visit (the aspect an image reports on load, the canvas
 * size): those change under the operator's hands and would throw away the view they just set.
 */
export const boardViewSignature = (
  plan: Pick<PlanDocument, 'imageUrl' | 'orientation' | 'osm' | 'floorStack'> | undefined,
  building: BuildingDoc | null | undefined,
  scale: PlanScale | undefined,
): string => [
  plan?.imageUrl ?? '',
  plan?.orientation ?? '',
  plan?.osm ? `${plan.osm.center.join(',')}@${plan.osm.radiusM}` : '',
  // the floor stack is drawn from the building — a storey added or the footprint re-oriented
  // redraws the whole sheet under the saved pan
  plan?.floorStack && building ? `${[...building.floors].sort((a, b) => a - b).join('/')}@${(building.orientDeg ?? 0).toFixed(1)}${building.northUp ? 'N' : ''}` : '',
  scale ? `${scale.mPerU}:${scale.ar}` : '',
].join('|')

export function useBoardView(
  canvasRef: RefObject<HTMLDivElement | null>,
  /** the canvas element as state — re-attaches the wheel listener when the canvas
   *  (re)mounts, e.g. after the Whiteboard first rendered a viewer-only doc without it */
  canvasEl?: HTMLDivElement | null,
  /** per-plan view memory. Omitted (tests, standalone use) ⇒ every plan opens fitted, as before.
   *  Scope mirrors the Lage map's `viewRef`: device-local and incident-scoped, never the synced
   *  workspace — a viewer's zoom is nobody else's business, and it does not survive a reload. */
  memory?: { views: MutableRefObject<BoardViews>; planId: string; signature: string },
) {
  const initial = memory ? resumeBoardView(memory.views.current[memory.planId], memory.signature) : FIT_VIEW
  const [scale, setScale] = useState(initial.scale)
  const [pos, setPos] = useState({ x: initial.x, y: initial.y })
  // refs mirror scale/pos so wheel/zoom math reads current values synchronously
  // (StrictMode-safe: no impure state updaters)
  const scaleRef = useRef(initial.scale)
  const posRef = useRef({ x: initial.x, y: initial.y })
  const applyView = (s: number, p: { x: number; y: number }) => {
    scaleRef.current = s; posRef.current = p; setScale(s); setPos(p)
    // write THROUGH to the memory rather than saving on teardown: an unmount cleanup would have
    // to close over the plan that was showing, and the surface switch that unmounts us also
    // re-renders with the next one. Every pan/zoom already funnels through here.
    if (memory) memory.views.current[memory.planId] = { scale: s, x: p.x, y: p.y, sig: memory.signature }
  }
  // Restore on the way IN. The initial state above already framed the plan this hook mounted on,
  // so `restored` starts there and this only fires on a switch BETWEEN plans.
  const restored = useRef(memory?.planId)
  useEffect(() => {
    if (!memory || restored.current === memory.planId) return
    restored.current = memory.planId
    const v = resumeBoardView(memory.views.current[memory.planId], memory.signature)
    applyView(v.scale, { x: v.x, y: v.y })
    // keyed on the plan ONLY: a signature that changes mid-visit (a calibration saved while you
    // work) must not yank the view you are looking at — it is compared on the way back in.
  }, [memory?.planId]) // eslint-disable-line react-hooks/exhaustive-deps

  const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
  // zoom keeping a focal point fixed — cursor for the wheel, centre for the buttons
  const zoomTo = (factor: number, mx?: number, my?: number) => {
    const el = canvasRef.current; if (!el) return
    const s = scaleRef.current, p = posRef.current
    const n = clamp(s * factor); if (n === s) return
    // at or below fit the board is no larger than the canvas, so there is nothing to pan to:
    // it snaps back to dead centre. That also makes zooming out THROUGH fit land on the
    // familiar eingepasst view instead of an off-centre one.
    if (n <= 1) { applyView(n, { x: 0, y: 0 }); return }
    const k = n / s
    // board is rendered centred + TOP_INSET/2 lower (see the board transform), so
    // the y focal centre is the canvas centre shifted down by the same amount
    const cx = el.clientWidth / 2, cy = el.clientHeight / 2 + TOP_INSET / 2
    const fx = mx ?? cx, fy = my ?? cy
    applyView(n, { x: (fx - cx) * (1 - k) + k * p.x, y: (fy - cy) * (1 - k) + k * p.y })
  }
  const zoom = (f: number) => zoomTo(f)
  useEffect(() => {
    const el = canvasEl ?? canvasRef.current; if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomTo(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [canvasEl]) // eslint-disable-line react-hooks/exhaustive-deps

  return { scale, pos, scaleRef, posRef, applyView, zoomTo, zoom, clamp }
}
