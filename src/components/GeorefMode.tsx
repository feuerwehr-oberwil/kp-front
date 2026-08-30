/** The PLAN half of «Karte verknüpfen» — crosses, tap capture, loupe, popover and mode panel.
 *
 *  The map half lives in GeorefMapLayer (inside MapView); the state both sides share lives in
 *  lib/georefMode. Nothing here owns state that has to survive: on a phone this whole component
 *  is unmounted between the plan tap and the map tap.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { confirmDialog, toast } from '../lib/ui'
import { beginTap, georefDispatch, georefLamp, georefOpenHint, georefPairIndex, georefPhoneTargetPoint, peekGeorefPhoneTarget, georefOpenCount, georefPlacing, georefSideCount, GEOREF_TAP_SLOP_PX, isPlacingTap, placeGeorefPhoneTarget, registerGeorefPhoneTarget, trackTap, useGeorefEscape, useGeorefMode, type GeorefModeState, type GeorefSide, type TapGesture } from '../lib/georefMode'
import { fitSimilarity, residualClaim } from '../lib/georef'
import { useIsPhone } from '../lib/useIsPhone'
import type { GeorefPair, PlanPt } from '../lib/georef'
import s from './GeorefMode.module.css'

/** The loupe's magnification over the plan as it is currently displayed. */
const LOUPE_MUL = 4

/** The bits of the board's view the mode has to drive: where a client point lands on the sheet,
 *  and how to pan/zoom it (both sides stay normally operable while the mode runs). */
export interface PlanViewApi {
  toNorm: (clientX: number, clientY: number) => [number, number] | null
  applyView: (scale: number, pos: { x: number; y: number }) => void
  zoomTo: (factor: number, cx: number, cy: number) => void
  scaleRef: React.MutableRefObject<number>
  posRef: React.MutableRefObject<{ x: number; y: number }>
  /** the canvas whose coordinate system is used for pinch zoom */
  canvasEl: HTMLDivElement | null
  /** the board itself, as a REF — where the plan's baked bitmap lives, for the loupe's crop.
   *  A ref rather than the element, so nothing reads `.current` during render. */
  boardRef: React.RefObject<HTMLDivElement | null>
}

/** Where the aim currently is on the plan bitmap. */
interface Aim { pt: PlanPt }

const crossSvg = (
  <svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
    <circle cx="13" cy="13" r="7.5" />
    <path d="M13 0v6M13 20v6M0 13h6M20 13h6" />
    <circle cx="13" cy="13" r="1.7" fill="currentColor" stroke="none" />
  </svg>
)

/**
 * Everything the mode draws ON the sheet, mounted INSIDE `.wb-board` so the crosses pan and zoom
 * with the plan exactly like an annotation. The loupe is portalled up into the canvas — it must
 * stay pinned to a screen corner while the board underneath it moves.
 *
 * Rendered whenever there is something to show: armed (crosses + capture) or merely linked with
 * the chip open (crosses only, so a reference can be found again months later).
 */
export function GeorefBoardLayer({ pairs, mode, armed, sW, sH, view }: {
  /** the STORED pairs, drawn when the layer only shows a finished reference (Passung open).
   *  While armed the layer draws `mode.slots` instead — pairs and open halves alike. */
  pairs: GeorefPair[]
  mode: GeorefModeState
  /** the mode is armed on THIS plan — only then is anything placeable */
  armed: boolean
  sW: number
  sH: number
  view: PlanViewApi
}) {
  const isPhone = useIsPhone()
  const [aim, setAim] = useState<Aim | null>(null)
  const targetCanvasEl = view.canvasEl
  const targetToNorm = view.toNorm
  // the current gesture is moving the sheet, not aiming at it — the loupe steps aside for it and
  // the cursor says so (a magnifier over a sliding plan magnifies nothing but the slide)
  const [panning, setPanning] = useState(false)
  // Pointer bookkeeping for the capture overlay. ⚠️ The layer takes the taps and NOTHING else:
  // a drag pans the sheet exactly as it does with no mode running, a second finger pinches, and
  // only a gesture that never left the tap radius places a point. `moved` is sticky, so a pan of
  // half a screen that happens to end where it began still places nothing.
  const tap = useRef<(TapGesture & { id: number; px: number; py: number }) | null>(null)
  const ptrs = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinch = useRef<number | null>(null)
  // dragging an existing cross: slot index + whether it has passed the tap threshold yet
  const drag = useRef<{ id: number; idx: number; x: number; y: number; moved: boolean } | null>(null)

  const placing = georefPlacing(mode)
  // the mode owns every tap on the sheet while it is armed — leaving the create tools live
  // underneath would mean a mis-aimed reference tap silently drops a symbol on the plan
  const showCapture = armed

  const pinchPts = () => {
    const [a, b] = [...ptrs.current.values()]
    if (!a || !b) return null
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
  }

  // ⚠️ The mode owns the WHOLE gesture, not just its first event. `down` alone used to stop
  // propagation, so every move and every up still bubbled to `.wb-canvas` and ran `stageMove` /
  // `stageUp` in parallel with the handlers below: a pinch was zoomed twice per frame (once here,
  // once by the stage's own pinch, which the capture-phase `trackDown` had armed), and lifting to
  // one finger left the stage panning from a different origin than this layer — two pans fighting
  // over the same sheet. That is what «unusable for moving/dragging» was.
  const own = (e: React.PointerEvent) => e.stopPropagation()
  /** Where the loupe opens before anything has been pointed at: the middle of the sheet. */
  const centreAim = (): Aim | null => {
    const r = view.boardRef.current?.getBoundingClientRect()
    if (!r || !r.width) return null
    return { pt: { x: 0.5, y: 0.5 } }
  }
  /** Aim at a client point, if it is over the sheet at all. */
  const aimAt = (x: number, y: number) => {
    const n = view.toNorm(x, y)
    if (n) setAim({ pt: { x: n[0], y: n[1] } })
  }
  // ⚠️ The loupe is up for the whole armed mode, not only while something is pressed. A touch
  // screen has no hover, so a magnifier that waited for a pointer was never seen at all: you
  // placed the point and only then found out what you had been aiming at. It opens on the middle
  // of the sheet, follows every move (hover or press), keeps the last aim after a release, and
  // steps aside only for a pan.
  useEffect(() => {
    if (!armed) { setAim(null); setPanning(false); return }
    setAim((cur) => cur ?? centreAim())
  }, [armed]) // eslint-disable-line react-hooks/exhaustive-deps

  // Phone placement is deliberately two-step: move the sheet under one fixed reticle, then use
  // the explicit action in the mode card. The resolver reads the geometry only at commit time,
  // so panning stays frame-local and the crosshair can never drift away from the point saved.
  useEffect(() => {
    if (!isPhone || !armed || !targetCanvasEl) return
    return registerGeorefPhoneTarget('plan', () => {
      const surface = targetCanvasEl.getBoundingClientRect()
      if (!surface) return null
      const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom
      const bottom = document.querySelector<HTMLElement>('[data-georef-controls]')?.getBoundingClientRect().top
      const target = georefPhoneTargetPoint(surface, { top, bottom })
      if (!target) return null
      const n = targetToNorm(target.x, target.y)
      return n && n[0] >= 0 && n[0] <= 1 && n[1] >= 0 && n[1] <= 1
        ? { x: n[0], y: n[1] }
        : null
    })
  }, [armed, isPhone, targetCanvasEl, targetToNorm])

  const down = (e: React.PointerEvent) => {
    // ⚠️ The mode OWNS this pointer, exactly the way `.wb-ink` owns a placement pointer one file
    // over («placement owns this pointer — don't let the stage ALSO start a board pan»). Without
    // this the event bubbled on to `.wb-canvas`, whose `stageDown` → `panDown` calls
    // `setPointerCapture` on the CANVAS — which takes the capture away from this layer, so every
    // following move and the pointerUP were retargeted and this component's handlers never ran
    // again. The board panned, and not one reference point was ever placed. The capture-phase
    // bookkeeping (`trackDown`/`trackUp`) still sees every finger: it runs before this.
    e.stopPropagation()
    georefDispatch({ type: 'goPlan' })
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (ptrs.current.size >= 2) {
      // a second finger means pinch-zoom, never a placement — mark the gesture rather than
      // dropping it, so the first finger's release cannot still be read as a tap
      if (tap.current) tap.current.multi = true
      setPanning(true); pinch.current = pinchPts()?.dist ?? null; return
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    tap.current = { ...beginTap(e.clientX, e.clientY), id: e.pointerId, px: view.posRef.current.x, py: view.posRef.current.y }
    aimAt(e.clientX, e.clientY)
  }
  const move = (e: React.PointerEvent) => {
    own(e)
    if (ptrs.current.has(e.pointerId)) ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current != null) {
      const m = pinchPts(), el = view.canvasEl
      if (m && el && pinch.current > 0 && m.dist > 0) {
        const r = el.getBoundingClientRect(); view.zoomTo(m.dist / pinch.current, m.mx - r.left, m.my - r.top)
      }
      if (m) pinch.current = m.dist
      return
    }
    const st = tap.current
    // no gesture in flight — a mouse simply hovering. Track it: the loupe is what says which
    // pixel a tap would take, and it must say so BEFORE the tap.
    if (!st) { georefDispatch({ type: 'goPlan' }); aimAt(e.clientX, e.clientY); return }
    if (st.id !== e.pointerId) return
    const dx = e.clientX - st.x, dy = e.clientY - st.y
    const wasTap = !st.moved
    trackTap(st, e.clientX, e.clientY)
    if (wasTap && st.moved) setPanning(true) // it became a pan — the loupe steps out of the way
    // panning from the recorded origin, the same arithmetic `useBoardGestures` uses, so the
    // sheet moves under an armed mode exactly as it does under no mode at all
    if (st.moved) { view.applyView(view.scaleRef.current, { x: st.px + dx, y: st.py + dy }); return }
    aimAt(e.clientX, e.clientY)
  }
  const up = (e: React.PointerEvent) => {
    own(e)
    const wasPinch = pinch.current != null
    ptrs.current.delete(e.pointerId)
    if (ptrs.current.size < 2) pinch.current = null
    if (ptrs.current.size === 0) setPanning(false)
    const st = tap.current; if (!st) return
    // ⚠️ A pinch that ends while the FIRST finger stays down must re-baseline the gesture.
    // `down` snapshotted the board's position once, but the pinch has been moving the board via
    // `zoomTo` — so the continuing `move()` would pan from the stale pre-pinch origin, and the
    // sheet (crosses and all) snapped visibly on the first sample after the second finger lifted.
    // New origin: the surviving pointer where it stands, the view as the pinch left it.
    if (wasPinch && pinch.current == null && st.id !== e.pointerId) {
      const rest = ptrs.current.get(st.id)
      if (rest) {
        st.x = rest.x; st.y = rest.y
        st.px = view.posRef.current.x; st.py = view.posRef.current.y
      }
      return
    }
    if (st.id !== e.pointerId) return
    tap.current = null
    // the aim STAYS where the finger left it — the loupe is up for the whole mode, so the last
    // thing looked at is what it keeps showing until something else is pointed at
    aimAt(e.clientX, e.clientY)
    if (e.type !== 'pointerup' || !isPlacingTap(st) || isPhone) return // phone commits only through the fixed target action
    const n = view.toNorm(e.clientX, e.clientY)
    // Only points ON the sheet can be references — the grey around it is not part of the plan.
    if (!n || n[0] < 0 || n[0] > 1 || n[1] < 0 || n[1] > 1) return
    georefDispatch({ type: 'planTap', pt: { x: n[0], y: n[1] } })
  }

  // --- an existing cross: drag = fine-tune with a live refit, tap = select (halo + popover) ---
  const crossDown = (idx: number) => (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { id: e.pointerId, idx, x: e.clientX, y: e.clientY, moved: false }
    aimAt(e.clientX, e.clientY)
  }
  const crossMove = (e: React.PointerEvent) => {
    own(e) // the stage must not ALSO pan the sheet under a cross being fine-tuned
    const d = drag.current; if (!d || d.id !== e.pointerId) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= GEOREF_TAP_SLOP_PX) return
    d.moved = true
    const n = view.toNorm(e.clientX, e.clientY); if (!n) return
    setAim({ pt: { x: n[0], y: n[1] } })
    georefDispatch({ type: 'dragPlan', idx: d.idx, pt: { x: n[0], y: n[1] } })
  }
  const crossUp = (e: React.PointerEvent) => {
    own(e)
    const d = drag.current; if (!d || d.id !== e.pointerId) return
    drag.current = null
    aimAt(e.clientX, e.clientY)
    // a cross that was tapped, not dragged, gets the halo and its little popover
    if (!d.moved && e.type === 'pointerup') georefDispatch({ type: 'select', idx: d.idx, side: 'plan' })
  }

  const C = appConfig.copy.whiteboard.georef
  return (
    <>
      {showCapture && (
        <div className={`${s.capture} ${panning ? s.capturePan : ''}`}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      )}
      {/* NOT armed: the stored reference, as plain marks. ⚠️ A cross is only a CONTROL while the
          mode is armed — it is a 26px glyph with a 44px touch pad above every annotation, so a
          «button» here swallows taps meant for the symbol underneath it, which is exactly what
          opening the Passung on a linked plan did before 26.08. */}
      {!armed && pairs.map((p, i) => (
        <span key={i} className={`${s.cross} ${s.inert}`} style={{ left: p.plan.x * sW, top: p.plan.y * sH }} aria-hidden>
          {crossSvg}
          <span className={s.badge}>{i + 1}</span>
        </span>
      ))}
      {/* ARMED: every slot's plan half — paired ones blue, open halves amber, the numbers shared
          with the map so a mispairing is something the eye catches. Selection halo and the
          stepped-back «being re-placed» look ride on top; only an armed re-place of a PLAN half
          makes the crosses inert, because that landing tap belongs to the sheet beneath them. */}
      {armed && mode.slots.map((sl, i) => {
        if (!sl.plan) return null
        const open = !sl.map
        const isSel = mode.sel?.side === 'plan' && mode.sel.idx === i
        const isMove = mode.move?.side === 'plan' && mode.move.idx === i
        const cls = `${s.cross} ${open ? s.pending : ''} ${isMove ? s.picked : ''} ${isSel ? s.selHalo : ''}`
        if (placing) {
          return (
            <span key={i} className={`${cls} ${s.inert}`} style={{ left: sl.plan.x * sW, top: sl.plan.y * sH }}
              aria-hidden>
              {crossSvg}
              <span className={s.badge}>{i + 1}</span>
            </span>
          )
        }
        const label = fillTemplate(open ? C.pendingCrossTitle : C.crossTitle, { n: String(i + 1) })
        return (
          <button
            key={i}
            type="button"
            className={cls}
            style={{ left: sl.plan.x * sW, top: sl.plan.y * sH }}
            title={label}
            aria-label={label}
            onPointerDown={crossDown(i)}
            onPointerMove={crossMove}
            onPointerUp={crossUp}
            onPointerCancel={crossUp}
          >
            {crossSvg}
            <span className={s.badge}>{i + 1}</span>
          </button>
        )
      })}
      {/* the marker popover — Verschieben / Punkt löschen / Behalten, anchored over the selected
          cross. Portalled and rAF-followed: the board moves under it without a React render. */}
      {armed && mode.sel?.side === 'plan' && createPortal(
        <PlanMarkerPopover mode={mode} boardRef={view.boardRef} />, document.body,
      )}
      {armed && mode.want === 'plan' && aim && !panning && !isPhone && createPortal(
        <PlanLoupe aim={aim} sW={sW} sH={sH} boardRef={view.boardRef} />, document.body,
      )}
      {/* …and on a PHONE the same magnifier, aimed at the fixed reticle rather than at a pointer
          there is none of. It was dropped when the fixed-target workflow arrived, on the grounds
          that a centred loupe was a second, ambiguous drag surface — true of a loupe UNDER the
          finger, not of an inset in the corner. Without it the sheet is placed blind: at the
          zoom where a whole Modul fits a phone screen, a house corner is three pixels wide. */}
      {armed && mode.want === 'plan' && isPhone && createPortal(
        <PhonePlanLoupe sW={sW} sH={sH} boardRef={view.boardRef} />, document.body,
      )}
    </>
  )
}

/**
 * The tapped cross's popover — the visible replacement for the old invisible «picked up» state,
 * whose only exits were Esc (invisible on touch), delete, or re-placing the point somewhere.
 * Three named ways out: «Verschieben» arms the re-place, «Punkt löschen» drops this ONE point,
 * «Behalten» (or a tap beside) changes nothing. Shared by both surfaces; each anchors it itself.
 */
export function GeorefPopoverCard({ mode, idx, side }: { mode: GeorefModeState; idx: number; side: GeorefSide }) {
  const C = appConfig.copy.whiteboard.georef
  const sl = mode.slots[idx]
  if (!sl) return null
  const open = side === 'plan' ? !sl.map : !sl.plan
  const fit = fitSimilarity(mode.pairs, mode.aspect)
  const pairIdx = georefPairIndex(mode, idx)
  // this point's own rest — only from three pairs on (georef · residualClaim's honesty rule)
  const r = !open && fit && fit.n >= 3 && pairIdx != null ? fit.residuals[pairIdx] : null
  const detail = open ? C.popOpen : r != null ? fillTemplate(C.popResidual, { m: r < 10 ? r.toFixed(1) : String(Math.round(r)) }) : null
  return (
    <div className={s.pop}>
      <div className={s.popHead}>
        {fillTemplate(C.pointN, { n: String(idx + 1) })}
        <i>· {side === 'plan' ? C.checkPlan : C.checkMap}{detail ? ` · ${detail}` : ''}</i>
      </div>
      <div className={s.popActs}>
        <button type="button" onClick={() => georefDispatch({ type: 'beginMove' })}>
          <Icon id="move" />{C.popMove}
        </button>
        <button type="button" className={s.popWarn} onClick={() => georefDispatch({ type: 'remove', idx })}>
          <Icon id="trash" />{C.removePoint}
        </button>
      </div>
      {/* an open half can be paired BY HAND: this popover plus a tap on its counterpart */}
      {open && <div className={s.popHint}>{C.popPairHint}</div>}
      <button type="button" className={s.popKeep} onClick={() => georefDispatch({ type: 'unpick' })}>{C.popKeep}</button>
    </div>
  )
}

/**
 * Anchors the popover over the selected PLAN cross, in screen space.
 *
 * ⚠️ Its own rAF, like the phone loupe: the board pans and zooms through direct style writes
 * (PlanViewApi · applyView), so nothing re-renders when the cross moves under the card. Only
 * this little anchor repaints, once per frame, while it is open.
 */
function PlanMarkerPopover({ mode, boardRef }: { mode: GeorefModeState; boardRef: React.RefObject<HTMLDivElement | null> }) {
  const sel = mode.sel
  const pt = sel ? mode.slots[sel.idx]?.plan : undefined
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const r = boardRef.current?.getBoundingClientRect()
      const next = pt && r && r.width ? { x: r.left + pt.x * r.width, y: r.top + pt.y * r.height } : null
      // same place ⇒ same object, so an idle board costs no re-render per frame
      setPos((prev) => (prev && next && prev.x === next.x && prev.y === next.y ? prev : next))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [boardRef, pt])
  if (!sel || !pos) return null
  const x = Math.min(Math.max(pos.x, 116), window.innerWidth - 116)
  // near the top edge the card flips below the cross instead of sliding off screen
  const below = pos.y < 170
  return (
    <div className={`${s.popAnchor} ${below ? s.popBelow : ''}`} style={{ left: x, top: pos.y }}>
      <GeorefPopoverCard mode={mode} idx={sel.idx} side="plan" />
    </div>
  )
}

/**
 * The phone's plan magnifier: the same crop, aimed at the fixed reticle.
 *
 * ⚠️ Its own rAF lives HERE, not in the parent. The aim moves with every pan frame, and driving
 * it from the surface that owns the sheet would re-render the whole plan tree once per frame —
 * the shape of the battery bug this app has already paid for once (see MapView · onView). Only
 * this 124px inset repaints.
 */
function PhonePlanLoupe({ sW, sH, boardRef }: { sW: number; sH: number; boardRef: React.RefObject<HTMLDivElement | null> }) {
  const [, tick] = useState(0)
  useEffect(() => {
    let raf = 0
    const loop = () => { tick((n) => n + 1); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  const pt = peekGeorefPhoneTarget('plan') as PlanPt | null
  // off the sheet ⇒ nothing to magnify, and an empty circle would read as «nothing is there»
  if (!pt) return null
  return <PlanLoupe aim={{ pt }} sW={sW} sH={sH} boardRef={boardRef} corner />
}

/**
 * The plan-side magnifier: a crop of the plan's own baked bitmap, blown up around the aim.
 *
 * It reads the bitmap PdfViewport already painted rather than rendering the PDF again — the
 * cheapest possible magnifier, and the one that cannot disagree with what is on screen. Deep
 * zoom makes it soft (the bake is sized for the viewport, not for ×4), which is the honest
 * trade: a soft magnifier that always matches beats a sharp one that lags.
 */
function PlanLoupe({ aim, sW, sH, boardRef, corner = false }: { aim: Aim; sW: number; sH: number; boardRef: React.RefObject<HTMLDivElement | null>; corner?: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const out = ref.current; if (!out) return
    const ctx = out.getContext('2d'); if (!ctx) return
    // PdfViewport paints the stitched plan into the FIRST canvas of the board (the base blit);
    // the refine canvas that follows it only covers the visible crop.
    const src = boardRef.current?.querySelector('canvas') as HTMLCanvasElement | null | undefined
    const w = out.clientWidth, h = out.clientHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    out.width = Math.round(w * dpr); out.height = Math.round(h * dpr)
    ctx.clearRect(0, 0, out.width, out.height)
    if (!src || !src.width || !src.height || !sW || !sH) return
    // crop side, in bitmap px, that fills the loupe at LOUPE_MUL× the on-screen plan scale
    const cw = (w * src.width) / (LOUPE_MUL * sW)
    const ch = (h * src.height) / (LOUPE_MUL * sH)
    try {
      ctx.drawImage(src, aim.pt.x * src.width - cw / 2, aim.pt.y * src.height - ch / 2, cw, ch, 0, 0, out.width, out.height)
    } catch { /* a torn-down canvas mid-gesture — the loupe simply stays empty */ }
  }, [aim, sW, sH, boardRef])

  return (
    <div className={`${s.loupe} ${corner ? s.loupeCorner : ''}`} aria-hidden>
      <canvas ref={ref} style={{ width: '100%', height: '100%' }} />
      <span className={s.xh} />
      <span className={s.ring} />
    </div>
  )
}

/**
 * The seam — and ONLY the seam. It marks the boundary the split created, so it belongs to the
 * plan half, whose right edge IS that boundary.
 *
 * ⚠️ No labels. It carried two until 26.08.: «KARTE VERKNÜPFEN» along its length and «Karte ·
 * geliehen» in the borrowed corner. The first repeated the instrument bar across the foot of
 * both halves — one mode, one indicator. The second explained the LAYOUT («this map is on
 * loan»), which is the app talking about its own design: nobody in an Einsatz parses it, and it
 * answers a question the operator never asked. The dashed line says «two surfaces, one job»
 * without a word, and the bar says what to tap.
 *
 * ⚠️ No cross-seam pair lines either. One day of them (29.08.) was enough: with 4–5 pairs the
 * dashed bridges turned the split into a cat's cradle. The numbered badges on the crosses ARE
 * the pairing statement — «just markers are enough» (field decision 30.08.).
 */
export function GeorefSplitSeam() {
  return <div className={s.seam} />
}

/** The status the panel leads with: the Ampel line, plus «Karte n · Modul m» and — because the
 *  amber cross saying so may be on the surface a phone is not even showing — WHICH half is still
 *  open, or what the armed «Verschieben» is waiting for. One derivation for both form factors. */
function georefStatus(mode: GeorefModeState) {
  const C = appConfig.copy.whiteboard.georef
  const fit = fitSimilarity(mode.pairs, mode.aspect)
  const lamp = georefLamp(fit, mode)
  const counts = fillTemplate(C.sideProgress, {
    map: String(georefSideCount(mode, 'map')),
    plan: String(georefSideCount(mode, 'plan')),
  })
  const sub = mode.move
    ? fillTemplate(mode.move.side === 'plan' ? C.movePlan : C.moveMap, { n: String(mode.move.idx + 1) })
    : (() => { const hint = georefOpenHint(mode); return hint ? `${counts} – ${hint}` : counts })()
  // the folded quality detail behind the (i): the pair count, the claimable ⌀, and the one
  // instruction-shaped sentence (georefLamp body — what the next point should do)
  const claim = residualClaim(fit)
  const foldValue = fit
    ? claim == null ? C.chipTwoPoints : fillTemplate(C.chipResidual, { m: claim.toFixed(1) })
    : null
  return { lamp, sub, foldPairs: `${mode.pairs.length} ${C.pairs}`, foldValue, foldBody: lamp.body }
}

/** «Alle Punkte zurücksetzen» — the one destructive action inside the running mode, behind the
 *  app's confirm. Shared by the desktop instrument and the phone bar, so the two cannot end up
 *  asking differently (or one of them not asking at all). */
async function clearGeorefPoints() {
  const C = appConfig.copy.whiteboard.georef
  const ok = await confirmDialog({
    title: C.clearTitle,
    message: C.clearBody,
    confirmLabel: C.clearPoints,
    cancelLabel: C.cancel,
    danger: true,
  })
  if (ok) georefDispatch({ type: 'clear' })
}

function GeorefActions({ mode }: { mode: GeorefModeState }) {
  const C = appConfig.copy.whiteboard.georef
  // Coverage is a full-screen visual comparison, not another point-placement step. Its bar is
  // intentionally one line: blend the two pictures, then return to the exact map/plan side the
  // operator came from. Finishing the alignment remains a separate, deliberate action.
  if (mode.check) {
    return (
      <>
        <label className={s.checkBlend}>
          <span>{C.checkMap}</span>
          <input
            type="range" min={0} max={100} step={5}
            value={Math.round(mode.checkOpacity * 100)}
            aria-label={C.checkOpacity}
            onChange={(e) => georefDispatch({ type: 'checkOpacity', opacity: Number(e.currentTarget.value) / 100 })}
          />
          <span>{C.checkPlan}</span>
        </label>
        <button className={`btn primary ${s.finishAction}`} onClick={() => georefDispatch({ type: 'finishCheck' })}>
          <Icon id="check" />{C.done}
        </button>
      </>
    )
  }
  const done = mode.pairs.length >= 2 && georefOpenCount(mode) === 0
  return (
    <>
      {/* «Verschieben» armed: the visible way to put the cross back down — Esc alone is not an
          exit on the tablet this mode was built for. Deleting the point stays in the popover. */}
      {mode.move
        ? (
          <button className={`btn ${s.resetAction}`} onClick={() => georefDispatch({ type: 'unpick' })}>
            <Icon id="close" />{C.popKeep}
          </button>
        )
        // …offered as soon as ANYTHING stands, open halves included. Gated on `pairs` alone,
        // a mode full of unmatched points (28.08.: nine of them, courtesy of the tap-double-fire
        // bug) had NO way to start over — only «Punkt löschen», one by one.
        : mode.slots.length > 0
          && <button className={`btn warn ${s.resetAction}`} onClick={() => void clearGeorefPoints()}><Icon id="trash" />{C.clearPoints}</button>}
      {/* «Deckung prüfen» — the sheet's own outline, laid on the map. The check belongs HERE
          because this is the one screen where both pictures are up at once. */}
      {!mode.move && mode.pairs.length >= 2 && (
        <button className={`btn link ${s.checkAction}${mode.check ? ' on' : ''}`} aria-pressed={mode.check}
          onClick={() => georefDispatch({ type: 'check', on: !mode.check })}><Icon id="eye" />{C.checkFit}</button>
      )}
      {/* One way out, with the word matching what it does. Once a usable fit stands it says so
          («Fertig»); before that it is «Schliessen».
          ⚠️ NOT «Abbrechen», which it said until 27.08. and never once did: pairs are saved as
          they are placed (georefMode · the debounced save), so leaving keeps every one of them.
          Somebody who pressed it to get rid of a crooked alignment found the plan georeferenced
          anyway. Throwing the points away is «Alle Punkte zurücksetzen», and that one asks. */}
      <button className={`btn ${s.finishAction} ${done ? 'primary' : ''}`}
        onClick={() => georefDispatch({ type: 'end' })}>
        <Icon id={done ? 'check' : 'close'} />
        {done ? C.done : C.closeMode}
      </button>
    </>
  )
}

/**
 * The armed mode ON A TABLET OR DESKTOP: one bar across the whole foot of the screen.
 *
 * ⚠️ ONE indicator, and it is a STATUS line first (the decided «minimal» panel, 29.08.): the
 * Ampel head with the per-surface counts and the one open half named, a single free-order
 * instruction, and the quality detail folded behind the (i) — the amber dot is what makes the
 * fold findable without being open. It spans the plan half AND the borrowed map half (`.pill`
 * is fixed; see the stylesheet), because that is exactly the extent of what the mode owns.
 *
 * It is rendered INSIDE the plan's `.wb-botleft` row — the row the chip that armed it lives in,
 * which shows nothing else while the mode runs — and positioned out of it. The phone does the
 * mirror image in GeorefModeBars: same content, in the tool bar's lane.
 */
export function GeorefInstrument({ mode }: { mode: GeorefModeState }) {
  const C = appConfig.copy.whiteboard.georef
  const [detail, setDetail] = useState(false)
  const st = georefStatus(mode)
  return (
    <div className={s.pill} role="status" aria-label={C.title}>
      <span className={`${s.dot} ${s[`dot_${st.lamp.tone}`]}`} />
      <span className={s.pillText}>
        {/* the one instruction. No per-point prompt: the free order means the app no longer
            knows better than the operator which surface is «next». */}
        <span className={s.promptText}>{mode.check ? C.checkFit : mode.move ? st.sub : C.freeOrderTap}</span>
        {!mode.check && (
          <span className={`${s.lampLine} ${s[`lampLine_${st.lamp.tone}`]}`}>
            <b>{st.lamp.head}</b>{!mode.move && <>{' · '}<i>{st.sub}</i></>}
          </span>
        )}
        {/* the quality detail + the (rewritten, instruction-shaped) warning live behind the (i) */}
        {!mode.check && detail && <span className={s.promptHint}>{st.foldBody}</span>}
      </span>
      {!mode.check && (
        <button
          type="button" className={`${s.infoBtn} ${detail ? s.infoOn : ''}`}
          aria-expanded={detail} title={C.detailsTitle} aria-label={C.detailsTitle}
          onClick={() => setDetail((v) => !v)}
        ><Icon id="info" /></button>
      )}
      <span className={s.acts}><GeorefActions mode={mode} /></span>
    </div>
  )
}

/**
 * The armed mode ON A PHONE: one bar, in the tool bar's lane.
 *
 * ⚠️ Rendered by the APP SHELL, not by either surface — the mode spans both, and on a phone the
 * plan is unmounted while the map takes the second half of every pair. A prompt that vanished at
 * exactly that moment would leave the operator on a map with no idea why it was showing.
 *
 * Renders nothing on a wider screen: there the chip IS the instrument (GeorefInstrument), and
 * two indicators at once is the thing this component exists NOT to be.
 */
export function GeorefModeBars({ planLabel }: { planLabel?: string }) {
  const mode = useGeorefMode()
  const isPhone = useIsPhone()
  // Esc lives here too, for the same reason: on the Karte surface the plan's own keyboard
  // handler is not mounted, and «the way out» must not depend on which half you are in.
  useGeorefEscape(!!mode.planId, mode.check, !!mode.move || !!mode.sel)
  const C = appConfig.copy.whiteboard.georef
  const shownSurface = mode.check ? 'map' : mode.want
  const barRef = useRef<HTMLDivElement | null>(null)
  const [fixedTarget, setFixedTarget] = useState<{ x: number; y: number } | null>(null)
  // The quality detail behind the (i). ⚠️ Sticky while open: whoever opened it is deciding
  // whether the fit can be trusted, and having it snap shut after every point would be the app
  // deciding they were done reading. It starts closed on every fresh arming.
  const [detail, setDetail] = useState(false)

  useEffect(() => {
    if (!mode.planId || !isPhone || mode.check) return
    let frame = 0
    const surfaceSelector = shownSurface === 'map' ? '.maplibregl-map' : '.wb-canvas'
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const surface = document.querySelector<HTMLElement>(surfaceSelector)?.getBoundingClientRect()
        const bar = barRef.current?.getBoundingClientRect()
        if (!surface || !bar) { setFixedTarget(null); return }
        const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom
        setFixedTarget(georefPhoneTargetPoint(surface, { top, bottom: bar.top }))
      })
    }
    measure()
    const observed = [document.querySelector<HTMLElement>(surfaceSelector), barRef.current].filter(Boolean) as HTMLElement[]
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observed.forEach((el) => ro?.observe(el))
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      ro?.disconnect()
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [isPhone, mode.check, mode.planId, shownSurface])

  if (!mode.planId || !isPhone) return null
  const st = georefStatus(mode)
  const done = mode.pairs.length >= 2 && georefOpenCount(mode) === 0
  // ⚠️ MEASURED and good, with nothing outstanding. Then the card stops asking for work: the big
  // row becomes «Fertig» and «Punkt setzen» drops to the quiet one. Placing another point stayed
  // the loud action all the way through a fit that was already green with a measured ⌀ — the app
  // pushing for a fifth point it has no reason to want, next to a «Fertig» in small text. A green
  // lamp is precisely the moment there is nothing left to ask for, so it is the moment to say so.
  const finished = done && !mode.move && !mode.check && st.lamp.tone === 'green'
  const place = () => {
    if (!placeGeorefPhoneTarget(shownSurface)) toast(C.targetOutside, { icon: 'warn', tone: 'warn' })
  }
  return (
    <>
    {!mode.check && fixedTarget && (
      <div className={s.fixedTarget} style={{ left: fixedTarget.x, top: fixedTarget.y }} aria-hidden>
        {crossSvg}
      </div>
    )}
    <div ref={barRef} data-georef-controls className={s.bar} role="status" aria-label={C.title}>
      {/* ── the status line ── Ampel + «Karte n · Modul m», and the one open half NAMED, because
          its amber cross may be standing on the surface this phone is not showing */}
      {!mode.check && (
        <div className={s.statusRow}>
          <span className={`${s.sdot} ${s[`sdot_${st.lamp.tone}`]}`} />
          <span className={s.stext}><b>{st.lamp.head}</b><i>{st.sub}</i></span>
          <button
            type="button" className={`${s.infoBtn} ${detail ? s.infoOn : ''}`}
            aria-expanded={detail} title={C.detailsTitle} aria-label={C.detailsTitle}
            onClick={() => setDetail((v) => !v)}
          ><Icon id="info" /></button>
        </div>
      )}
      {/* ── the quality detail, folded behind the (i): pair count, claimable ⌀, and the one
          instruction-shaped sentence about what the next point should fix */}
      {!mode.check && detail && (
        <div className={s.qfold}>
          {st.foldValue && <div className={s.qrow}><span>{st.foldPairs}</span><strong>{st.foldValue}</strong></div>}
          {st.foldBody}
        </div>
      )}
      {/* On a phone the two surfaces are part of this one task, so their switch belongs inside
          its card. Never disabled — free order means there is no wrong surface to be on. */}
      {!mode.check && <div className={s.surfaceSwitch} role="group" aria-label={C.title}>
        <button type="button" className={shownSurface === 'map' ? s.surfaceOn : ''}
          aria-label={appConfig.copy.navRail.map} aria-pressed={shownSurface === 'map'}
          onClick={() => georefDispatch({ type: 'goMap' })}>
          <Icon id="map" />{appConfig.copy.navRail.map}<span>{georefSideCount(mode, 'map')}</span>
        </button>
        <button type="button" className={shownSurface === 'plan' ? s.surfaceOn : ''}
          aria-label={planLabel ?? C.checkPlan} aria-pressed={shownSurface === 'plan'}
          onClick={() => georefDispatch({ type: 'goPlan' })}>
          <Icon id="doc" />{planLabel ?? C.checkPlan}<span>{georefSideCount(mode, 'plan')}</span>
        </button>
      </div>}
      {/* ── the one big action ── «Punkt setzen» places at the reticle on whichever surface is
          up — Karte or Modul, in any order; the pairing is the reducer's job, not the button's.
          ⚠️ Nothing that takes something away shares this row (the coin-toss note of 28.08.). */}
      {!mode.check && (
        finished
          ? (
            <button type="button" className={`btn primary ${s.placeAction}`} onClick={() => georefDispatch({ type: 'end' })}>
              <Icon id="check" />{C.done}
            </button>
          )
          : (
            <>
              <button type="button" className={`btn primary ${s.placeAction}`} onClick={place}>
                <Icon id="plus" />{C.placePoint}
              </button>
              {!mode.move && <div className={s.subline}>{C.freeOrderPlace}</div>}
            </>
          )
      )}
      {mode.check
        ? <span className={s.acts}><GeorefActions mode={mode} /></span>
        : (
          <div className={s.quiet}>
            {/* left: harmless and frequent, plus the destructive one — deliberately NOT beside
                the exit on the right, which is the button somebody reaches for while finishing */}
            {!mode.move && mode.pairs.length >= 2 && (
              <button type="button" className={`btn link ${s.quietBtn}`} aria-pressed={mode.check}
                onClick={() => georefDispatch({ type: 'check', on: true })}><Icon id="eye" />{C.checkFit}</button>
            )}
            {/* ⚠️ «Alle Punkte zurücksetzen» steps OUT once the fit is finished. Three actions is
                one too many for this row — and at a measured, green fit throwing every point away
                is the one thing nobody is reaching for. It is not lost: «Fertig» leads straight
                to the Passung, where «Zurücksetzen» is one of the two things on offer. */}
            {mode.move
              ? (
                // the visible way to put a picked-up cross back down — Esc must never be the
                // only exit, least of all on the touch devices this mode exists for
                <button type="button" className={`btn link ${s.quietBtn}`}
                  onClick={() => georefDispatch({ type: 'unpick' })}>
                  <Icon id="close" />{C.popKeep}
                </button>
              )
              : !finished && mode.slots.length > 0 && (
                // open halves count too — a card full of unmatched points must not strand the
                // operator without a «start over»
                <button type="button" className={`btn link ${s.quietBtn} ${s.quietWarn}`} onClick={() => void clearGeorefPoints()}>
                  <Icon id="trash" />{C.clearPoints}
                </button>
              )}
            <span className={s.quietGap} />
            {/* …and the two exchange places when the fit is finished: adding a point is still
                one tap away, it simply stops being the thing the card is asking for. */}
            {finished
              ? (
                <button type="button" className={`btn link ${s.quietBtn}`} onClick={place}>
                  <Icon id="plus" />{C.placePoint}
                </button>
              )
              : (
                /* the way out, and the word matches what it does — «Schliessen», never
                   «Abbrechen»: see the same button in GeorefActions for why. */
                <button type="button" className={`btn link ${s.quietBtn} ${done ? s.quietDone : ''}`}
                  onClick={() => georefDispatch({ type: 'end' })}>
                  <Icon id={done ? 'check' : 'close'} />{done ? C.done : C.closeMode}
                </button>
              )}
          </div>
        )}
    </div>
    </>
  )
}
