/** The PLAN half of «Karte verknüpfen» — crosses, tap capture, loupe, prompt and action bar.
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
import { beginTap, georefDispatch, georefLamp, georefPhoneTargetPoint, georefPlacing, georefPointNo, georefQueueNo, GEOREF_TAP_SLOP_PX, isPlacingTap, placeGeorefPhoneTarget, registerGeorefPhoneTarget, trackTap, useGeorefEscape, useGeorefMode, type GeorefModeState, type TapGesture } from '../lib/georefMode'
import { fitSimilarity } from '../lib/georef'
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
  /** the crosses to draw: the LIVE pairs while armed, the stored ones when merely showing them */
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
  // dragging an existing cross: idx + whether it has passed the tap threshold yet
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
    ptrs.current.delete(e.pointerId)
    if (ptrs.current.size < 2) pinch.current = null
    if (ptrs.current.size === 0) setPanning(false)
    const st = tap.current; if (!st || st.id !== e.pointerId) return
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

  // --- an existing cross: drag = fine-tune with a live refit, tap = pick this half up ---
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
    // a cross that was tapped, not dragged, hands THIS half back to be re-placed
    if (!d.moved && e.type === 'pointerup') georefDispatch({ type: 'pick', idx: d.idx, side: 'plan' })
  }

  return (
    <>
      {showCapture && (
        <div className={`${s.capture} ${panning ? s.capturePan : ''}`}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      )}
      {pairs.map((p, i) => {
        const label = fillTemplate(appConfig.copy.whiteboard.georef.crossTitle, { n: String(i + 1) })
        const cls = `${s.cross} ${mode.edit?.idx === i && mode.edit.side === 'plan' ? s.picked : ''}`
        // ⚠️ A cross is only a CONTROL while the mode is armed and no placement is mid-flight.
        // Otherwise it is a mark: a plain, inert span. It is a 26px glyph with a 44px touch pad
        // above every annotation, so a «button» here swallows taps meant for the symbol
        // underneath it — which is exactly what opening the Passung on a linked plan did before
        // 26.08., leaving the plan's own symbols dead anywhere near a reference.
        if (!armed || placing) {
          return (
            <span key={i} className={`${cls} ${s.inert}`} style={{ left: p.plan.x * sW, top: p.plan.y * sH }} aria-hidden>
              {crossSvg}
              <span className={s.badge}>{i + 1}</span>
            </span>
          )
        }
        return (
          <button
            key={i}
            type="button"
            className={cls}
            style={{ left: p.plan.x * sW, top: p.plan.y * sH }}
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
      {/* the OPEN points — plan halves with no counterpart yet. Amber, in the order they will be
          matched on the map, each carrying the number it WILL get. There can be several: the
          mode no longer forces a hop to the map after every tap (lib/georefMode · the queue). */}
      {mode.queue.map((pt, i) => {
        const number = georefQueueNo(mode, i)
        const cls = `${s.cross} ${s.pending} ${mode.edit?.pending && mode.edit.side === 'plan' && mode.edit.idx === i ? s.picked : ''}`
        if (placing) return (
          <span key={`open${i}`} className={`${cls} ${s.inert}`} style={{ left: pt.x * sW, top: pt.y * sH }} aria-hidden>
            {crossSvg}<span className={s.badge}>{number}</span>
          </span>
        )
        const label = fillTemplate(appConfig.copy.whiteboard.georef.pendingCrossTitle, { n: String(number) })
        return (
          <button key={`open${i}`} type="button" className={cls}
            style={{ left: pt.x * sW, top: pt.y * sH }} title={label} aria-label={label}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); georefDispatch({ type: 'pickPending', idx: i, side: 'plan' }) }}>
            {crossSvg}<span className={s.badge}>{number}</span>
          </button>
        )
      })}
      {armed && mode.want === 'plan' && aim && !panning && !isPhone && createPortal(
        <PlanLoupe aim={aim} sW={sW} sH={sH} boardRef={view.boardRef} />, document.body,
      )}
    </>
  )
}

/**
 * The plan-side magnifier: a crop of the plan's own baked bitmap, blown up around the aim.
 *
 * It reads the bitmap PdfViewport already painted rather than rendering the PDF again — the
 * cheapest possible magnifier, and the one that cannot disagree with what is on screen. Deep
 * zoom makes it soft (the bake is sized for the viewport, not for ×4), which is the honest
 * trade: a soft magnifier that always matches beats a sharp one that lags.
 */
function PlanLoupe({ aim, sW, sH, boardRef }: { aim: Aim; sW: number; sH: number; boardRef: React.RefObject<HTMLDivElement | null> }) {
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
    <div className={s.loupe} aria-hidden>
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
 */
export function GeorefSplitSeam() {
  return <div className={s.seam} />
}

/** What the mode is asking for right now, in words — the one derivation both form factors use.
 *  It is also the mode's ONLY teaching: no tutorial, and deliberately no «first use» variant, so
 *  the instruction reads the same on the fiftieth Einsatz as on the first. */
/**
 * The Ampel, drawn. One line that is always there: how good the reference is, and — the sentence
 * that used to be a tap away in the Passung — what the next point changes about it.
 */
function GeorefLampRow({ mode }: { mode: GeorefModeState }) {
  // solved here rather than passed in: both bars want it, and it is a closed-form fit over a
  // handful of points (the same call the Whiteboard already makes every render)
  const lamp = georefLamp(fitSimilarity(mode.pairs, mode.aspect), mode)
  return (
    <div className={`${s.lamp} ${s[`lamp_${lamp.tone}`]}`} role="status">
      <span className={s.lampDot} />
      <span className={s.lampText}><b>{lamp.head}</b><i>{lamp.body}</i></span>
    </div>
  )
}

/** «Markanter Punkt» is a phrase nobody reads twice. These two 52×40 thumbnails say which
 *  corner is meant — the corner, not the wall — in the one place the question comes up.
 *  Deliberately drawn, not photographed: a photo of one station's house teaches that house. */
function GeorefExample({ side }: { side: 'plan' | 'map' }) {
  const C = appConfig.copy.whiteboard.georef
  return side === 'plan' ? (
    <svg className={s.example} viewBox="0 0 52 40" role="img" aria-label={C.exampleAltPlan}>
      <rect width="52" height="40" className={s.exPaper} />
      <path d="M8 34 V14 H36" className={s.exWall} />
      <g className={s.exMark}><circle cx="8" cy="14" r="5" /><path d="M8 6v4M8 18v4M0 14h4M12 14h4" /></g>
    </svg>
  ) : (
    <svg className={s.example} viewBox="0 0 52 40" role="img" aria-label={C.exampleAltMap}>
      <rect width="52" height="40" className={s.exGround} />
      <path d="M4 26h44" className={s.exRoad} />
      <rect x="14" y="6" width="20" height="12" className={s.exHouse} />
      <g className={s.exMark}><circle cx="34" cy="18" r="5" /><path d="M34 10v4M34 22v4M26 18h4M38 18h4" /></g>
    </svg>
  )
}

function georefPrompt(mode: GeorefModeState) {
  const C = appConfig.copy.whiteboard.georef
  const n = georefPointNo(mode)
  const onMap = mode.want === 'map'
  if (mode.check) return { n, title: C.checkFit, hint: undefined, status: '' }
  return {
    n,
    title: mode.edit
      ? fillTemplate(mode.edit.side === 'plan' ? C.promptRePlan : C.promptReMap, { n: String(n) })
      // ⚠️ On the map the NUMBER matters as soon as more than one point is open — «denselben
      // Punkt» is a lie when three are waiting. With exactly one it is the better sentence, so
      // both survive and the queue length picks.
      : onMap ? fillTemplate(C.promptMapNo, { n: String(n) })
      : fillTemplate(C.promptPlanNo, { n: String(n) }),
    // The examples teach the first two pairs; by point eight they are repeated prose between
    // the operator and the buttons. Once the gesture is established, keep only destination +
    // progress in the mode bar.
    hint: mode.edit ? undefined : onMap ? C.promptMapHint : mode.pairs.length < 2 ? C.promptPlanHint : undefined,
    // …and the one line under it that says what happens NEXT. The prompt says where to tap; a
    // first-timer's actual question is «and then?», which used to have no answer anywhere.
    sub: mode.edit ? C.subRe : onMap ? C.subMap : C.subPlan,
    // «3 Paare gesetzt · 2 offen» — what stands, and what is still waiting to be matched
    status: [
      mode.pairs.length === 0 ? C.barNone
        : mode.pairs.length === 1 ? C.barOne
        : fillTemplate(C.barMany, { n: String(mode.pairs.length) }),
      ...(mode.queue.length + mode.mapQueue.length ? [fillTemplate(C.barOpen, { n: String(mode.queue.length + mode.mapQueue.length) })] : []),
    ].join(' · '),
  }
}

/** «Abbrechen», and «Fertig» once there is something finished to keep. Before the second pair
 *  those two would be the same button wearing two different words, so only one is offered.
 *
 *  Two more appear where they mean something, and nowhere else:
 *   • «Punkt löschen» ONLY while a cross is picked up — that is the one moment there is a
 *     «this point» to talk about. A landmark can turn out to be the mistake itself, and
 *     re-placing it somewhere else only moves the error.
 *   • «Zurücksetzen» once at least one pair stands. It clears them and STAYS armed:
 *     «start over», not «leave» — «Abbrechen» beside it is the one that keeps what stands. */
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
  return (
    <>
      {mode.edit
        ? (
          <button className={`btn warn ${s.resetAction}`} onClick={() => georefDispatch(mode.edit!.pending
            ? { type: 'removePending', idx: mode.edit!.idx, side: mode.edit!.side }
            : { type: 'removePair', idx: mode.edit!.idx })}>
            <Icon id="trash" />{C.removePoint}
          </button>
        )
        : mode.pairs.length > 0 && <button className={`btn warn ${s.resetAction}`} onClick={() => void clearGeorefPoints()}><Icon id="trash" />{C.clearPoints}</button>}
      {/* «Auf der Karte zuordnen» — on a phone the ONLY way across now that a plan tap no longer
          hops by itself; on the split there is nothing to travel to, but pressing it still turns
          the instruction round («Punkt 4 auf der Karte antippen»), which is the same request in
          the one place the operator is already reading. */}
      {/* «Deckung prüfen» — the sheet's own outline, laid on the map. The check belongs HERE
          because this is the one screen where both pictures are up at once. */}
      {!mode.edit && mode.pairs.length >= 2 && (
        <>
          <button className={`btn link ${s.checkAction}${mode.check ? ' on' : ''}`} aria-pressed={mode.check}
            onClick={() => georefDispatch({ type: 'check', on: !mode.check })}><Icon id="eye" />{C.checkFit}</button>
        </>
      )}
      {/* One way out, with the word matching what it does. Once a usable fit stands this keeps
          it («Fertig»); before that, or while unmatched plan points are open, it abandons the
          unfinished step («Abbrechen»). Two adjacent exit buttons used to do the same thing. */}
      <button className={`btn ${s.finishAction} ${mode.pairs.length >= 2 && !mode.queue.length && !mode.mapQueue.length ? 'primary' : ''}`}
        onClick={() => georefDispatch({ type: 'end' })}>
        <Icon id={mode.pairs.length >= 2 && !mode.queue.length && !mode.mapQueue.length ? 'check' : 'close'} />
        {mode.pairs.length >= 2 && !mode.queue.length && !mode.mapQueue.length ? C.done : C.cancel}
      </button>
    </>
  )
}

/**
 * The armed mode ON A TABLET OR DESKTOP: one bar across the whole foot of the screen.
 *
 * ⚠️ ONE indicator, and it looks like the mode it is. This started life as a chip in the corner
 * PLUS an instruction bar across the top — two things saying «a mode is running», so the eye had
 * to pick one — and then as a single corner-sized pill, which read as one more read-out among
 * the read-outs rather than as a mode that has taken over both surfaces. It now spans the
 * plan half AND the borrowed map half (`.pill` is fixed; see the stylesheet), because that is
 * exactly the extent of what the mode currently owns.
 *
 * It is rendered INSIDE the plan's `.wb-botleft` row — the row the chip that armed it lives in,
 * which shows nothing else while the mode runs — and positioned out of it. The phone does the
 * mirror image in GeorefModeBars: same content, in the tool bar's lane.
 */
export function GeorefInstrument({ mode }: { mode: GeorefModeState }) {
  const C = appConfig.copy.whiteboard.georef
  const p = georefPrompt(mode)
  // ⚠️ The lamp REPLACES the pair count that used to sit here. «2 Paare» is a fact nobody can
  // have an opinion about; «2 Punkte – exakt, aber ungeprüft» is the same fact plus the reason
  // to place a third. The count is still in the lamp's own head, so nothing was lost.
  const lamp = georefLamp(fitSimilarity(mode.pairs, mode.aspect), mode)
  return (
    <div className={s.pill} role="status" aria-label={C.title}>
      <span className={`${s.dot} ${s[`dot_${lamp.tone}`]}`} />
      <span className={s.pillText}>
        <span className={s.promptText}>{p.title}</span>
        <span className={s.promptHint} title={lamp.body}>
          {p.hint ? `${p.hint} · ${lamp.head}` : lamp.head}
        </span>
      </span>
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
  useGeorefEscape(!!mode.planId, mode.check, !!mode.edit)
  const C = appConfig.copy.whiteboard.georef
  const shownSurface = mode.check ? 'map' : mode.want
  const barRef = useRef<HTMLDivElement | null>(null)
  const [fixedTarget, setFixedTarget] = useState<{ x: number; y: number } | null>(null)

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
  const p = georefPrompt(mode)
  const mapEnabled = !mode.edit || mode.edit.side === 'map'
  const planEnabled = !mode.edit || mode.edit.side === 'plan'
  const done = mode.pairs.length >= 2 && !mode.queue.length && !mode.mapQueue.length
  return (
    <>
    {!mode.check && fixedTarget && (
      <div className={s.fixedTarget} style={{ left: fixedTarget.x, top: fixedTarget.y }} aria-hidden>
        {crossSvg}
      </div>
    )}
    <div ref={barRef} data-georef-controls className={s.bar} role="status" aria-label={C.title}>
      {/* ── the reading ── always there, never a tap away (georefLamp) */}
      {!mode.check && <GeorefLampRow mode={mode} />}
      {/* ── the instruction ── a picture of what is meant, the sentence, and what comes next */}
      <div className={s.say}>
        {!mode.check && <GeorefExample side={shownSurface === 'map' ? 'map' : 'plan'} />}
        <span className={s.sayText}>
          <b>{p.title}</b>
          {p.hint && <i>{p.hint}</i>}
          {!mode.check && <i>{p.sub}</i>}
        </span>
      </div>
      {/* On a phone the two surfaces are part of this one task, so their switch belongs inside
          its card, immediately below the status that says which point is being worked on. */}
      {!mode.check && <div className={s.surfaceSwitch} role="group" aria-label={C.title}>
        <button type="button" className={shownSurface === 'map' ? s.surfaceOn : ''}
          aria-pressed={shownSurface === 'map'} disabled={!mapEnabled}
          onClick={() => georefDispatch({ type: 'goMap' })}>
          <Icon id="map" />{appConfig.copy.navRail.map}
        </button>
        <button type="button" className={shownSurface === 'plan' ? s.surfaceOn : ''}
          aria-pressed={shownSurface === 'plan'} disabled={!planEnabled}
          onClick={() => georefDispatch({ type: 'goPlan' })}>
          <Icon id="doc" />{planLabel ?? C.checkPlan}
        </button>
      </div>}
      {/* ── the one big action ── on its own row, and it NAMES the point it is about to set.
          ⚠️ Nothing that takes something away shares this row. «Zurücksetzen» used to sit a
          thumb's width from «Fertig», both the same size, one of them red: with a glove on, in
          the dark, that is a coin toss over half an alignment. Everything else is now the quiet
          row below, at text weight. */}
      {!mode.check && (
        <button type="button" className={`btn primary ${s.placeAction}`}
          onClick={() => {
            if (!placeGeorefPhoneTarget(shownSurface)) toast(C.targetOutside, { icon: 'warn', tone: 'warn' })
          }}>
          <Icon id="plus" />{fillTemplate(C.placePointNo, { n: String(p.n) })}
        </button>
      )}
      {mode.check
        ? <span className={s.acts}><GeorefActions mode={mode} /></span>
        : (
          <div className={s.quiet}>
            {/* left: harmless and frequent, plus the destructive one — deliberately NOT beside
                the exit on the right, which is the button somebody reaches for while finishing */}
            {!mode.edit && mode.pairs.length >= 2 && (
              <button type="button" className={`btn link ${s.quietBtn}`} aria-pressed={mode.check}
                onClick={() => georefDispatch({ type: 'check', on: true })}><Icon id="eye" />{C.checkFit}</button>
            )}
            {mode.edit
              ? (
                <button type="button" className={`btn link ${s.quietBtn} ${s.quietWarn}`}
                  onClick={() => georefDispatch(mode.edit!.pending
                    ? { type: 'removePending', idx: mode.edit!.idx, side: mode.edit!.side }
                    : { type: 'removePair', idx: mode.edit!.idx })}>
                  <Icon id="trash" />{C.removePoint}
                </button>
              )
              : mode.pairs.length > 0 && (
                <button type="button" className={`btn link ${s.quietBtn} ${s.quietWarn}`} onClick={() => void clearGeorefPoints()}>
                  <Icon id="trash" />{C.clearPoints}
                </button>
              )}
            <span className={s.quietGap} />
            {/* the way out, and the word matches what it does */}
            <button type="button" className={`btn link ${s.quietBtn} ${done ? s.quietDone : ''}`}
              onClick={() => georefDispatch({ type: 'end' })}>
              <Icon id={done ? 'check' : 'close'} />{done ? C.done : C.cancel}
            </button>
          </div>
        )}
    </div>
    </>
  )
}
