import { Fragment, useEffect, useRef, useState } from 'react'
import { Icon, PrinterFeedIcon } from './icons'
import { appConfig } from '../config/appConfig'
import { ConfirmCard } from './overlays/ConfirmCard'
import { Overlay } from './overlays'

// Lightweight app-wide toast + confirm host. Replaces native alert()/confirm()
// so transient feedback and destructive confirmations stay inside the glass
// design language. Imperative API (toast / confirmDialog) backed by a tiny
// module store; mount <Overlays/> once at the app root.

type Tone = 'default' | 'warn' | 'success'
/** How a tone is shown. `fill` paints the whole pill — right for a one-shot message that has to
 * be noticed once («Sync-Fehler»). `edge` keeps the neutral ink pill every other status shares
 * and puts the colour on the leading edge and the icons — right for a LIVE status that stands on
 * screen for as long as a job takes: a print sitting in a queue is not an alarm, and a saturated
 * red pill for a minute and a half says it is. Same idea as the Meldeleiste's `.ml-row.t-*`. */
type ToneStyle = 'fill' | 'edge'
export interface ToastAction { label: string; onClick: () => void }
/** One stage of a multi-step toast (the live print job). `icon` omitted = an unreached step,
 * drawn as a dim pip; `printer` is the animated «paper coming out» glyph. */
export interface ToastStep {
  label: string
  state: 'done' | 'now' | 'future' | 'fail'
  icon?: 'check' | 'warn' | 'printer'
}
interface Toast { id: number; text: string; icon?: string; tone: Tone; toneStyle: ToneStyle; action?: ToastAction; steps?: ToastStep[]; leaving?: boolean }
interface ConfirmReq {
  id: number
  title?: string
  message: string
  /** the open points, as a LIST. «Noch offen: Zeiten, Mittel, Einsatzleiter, Kurzbericht,
   *  Rückmeldung ELZ. Trotzdem abschliessen? …» is a paragraph nobody reads to the end — and
   *  it is the one part of the sentence somebody has to act on, item by item. */
  items?: string[]
  /** the sentence AFTER the list — what happens if you go ahead anyway */
  note?: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  resolve: (v: boolean) => void
}

/** The picture currently being looked at full-size (see openPhoto). */
interface PhotoReq { url: string; filename: string; caption?: string; download?: boolean }

let toasts: Toast[] = []
let confirmReq: ConfirmReq | null = null
let photoReq: PhotoReq | null = null
const listeners = new Set<() => void>()
let seq = 1
const emit = () => listeners.forEach((l) => l())

// Pending auto-dismiss timers, keyed by toast id, so updateToast can reset a toast's clock
// and dismissToast can cancel it (a live status toast is sticky until it reaches done/failed).
const timers = new Map<number, ReturnType<typeof setTimeout>>()
/** Keep brief feedback brief, but leave long operational/API messages on screen long enough to
 * read. Explicit caller durations still win; action toasts retain the six-second undo floor. */
function defaultToastDuration(text: string, hasAction: boolean) {
  const floor = hasAction ? 6000 : 2800
  return Math.min(10_000, Math.max(floor, 1800 + Array.from(text).length * 45))
}
function scheduleDismiss(id: number, ms: number) {
  const prev = timers.get(id)
  if (prev) clearTimeout(prev)
  timers.set(id, setTimeout(() => { dismissToast(id) }, ms))
}

export function dismissToast(id: number) {
  const t = toasts.find((x) => x.id === id)
  if (!t || t.leaving) return
  const prev = timers.get(id)
  if (prev) { clearTimeout(prev); timers.delete(id) }
  // leave the way it came in: `.toast.out` plays (.14s, shorter than the entrance), then the
  // node goes. The removal timer stays out of `timers` — nothing may cancel the second half.
  toasts = toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x))
  emit()
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== id); emit() }, 160)
}

export function toast(text: string, opts?: { icon?: string; tone?: Tone; toneStyle?: ToneStyle; duration?: number; action?: ToastAction; sticky?: boolean; steps?: ToastStep[] }): number {
  const id = seq++
  toasts = [...toasts, { id, text, icon: opts?.icon, tone: opts?.tone ?? 'default', toneStyle: opts?.toneStyle ?? 'fill', action: opts?.action, steps: opts?.steps }]
  emit()
  // sticky toasts stay until updateToast/dismissToast decides (live status). Otherwise an
  // action (e.g. confirm-with-undo) needs time to be seen and tapped.
  if (!opts?.sticky) scheduleDismiss(id, opts?.duration ?? defaultToastDuration(text, !!opts?.action))
  return id
}

/** Patch a live toast in place (text/icon/tone/action). Pass `duration` to auto-dismiss it
 * (e.g. once the job reaches done/failed); omit to keep it sticky. Unknown id = no-op. */
export function updateToast(id: number, text: string, opts?: { icon?: string; tone?: Tone; toneStyle?: ToneStyle; duration?: number; action?: ToastAction | null; steps?: ToastStep[] | null }) {
  const cur = toasts.find((t) => t.id === id)
  if (!cur || cur.leaving) return
  toasts = toasts.map((t) => t.id === id
    ? { ...t, text, icon: opts?.icon, tone: opts?.tone ?? 'default', toneStyle: opts?.toneStyle ?? 'fill', action: opts?.action ?? undefined, steps: opts?.steps ?? undefined }
    : t)
  emit()
  if (opts?.duration) scheduleDismiss(id, opts.duration)
}

export function confirmDialog(opts: {
  title?: string
  message: string
  items?: string[]
  note?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    // a fresh request supersedes any pending one (resolve the old as cancelled)
    confirmReq?.resolve(false)
    confirmReq = {
      id: seq++,
      title: opts.title,
      message: opts.message,
      items: opts.items,
      note: opts.note,
      confirmLabel: opts.confirmLabel ?? appConfig.copy.confirm.ok,
      cancelLabel: opts.cancelLabel ?? appConfig.copy.confirm.cancel,
      danger: opts.danger,
      resolve,
    }
    emit()
  })
}

/**
 * Show one picture full-size, in the app.
 *
 * A photo used to open with `target="_blank"`. In a browser tab that is merely untidy; in the
 * INSTALLED app it leaves the app — iOS hands the picture to Safari and the operator has to find
 * their way back to a running Einsatz. So it opens here, over the surface, with the one thing the
 * new tab was actually good for: a download.
 *
 * Imperative like toast()/confirmDialog(), so a thumbnail anywhere can call it without every
 * surface in between having to carry a viewer prop.
 */
/** Caret to the end on focus. A seeded editor (transcript, correction, a rename) opens to
 *  CONTINUE the text; the browser's default caret at position 0 invites typing in front of it.
 *  Attach as `onFocus` — autoFocus fires it exactly once. */
export function caretToEnd(ev: { currentTarget: HTMLTextAreaElement | HTMLInputElement }) {
  const el = ev.currentTarget
  const n = el.value.length
  try { el.setSelectionRange(n, n) } catch { /* input types without selection (number) — keep the default */ }
}

export function openPhoto(
  url: string,
  /** `download: false` for pictures that are REFERENCE rather than incident media — a
   *  Kommandoakten diagram belongs to the BGV and is one tap from the source anyway, so
   *  offering «herunterladen» there only invites a stray copy that ages out of date. Incident
   *  media (Verlauf, Beilagen, Objektfoto) keeps it: getting a photo out is the point. */
  opts?: { filename?: string; caption?: string; download?: boolean },
) {
  photoReq = { url, filename: opts?.filename || 'foto.jpg', caption: opts?.caption, download: opts?.download !== false }
  emit()
}

function useForceUpdate() {
  const [, setN] = useState(0)
  useEffect(() => {
    const l = () => setN((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
}

/** The step chain of a live job: done steps keep their tick and step back, the running one
 * carries the label, the unreached ones stay visible as pips so «what still has to happen» is
 * readable at a glance. Below 520px the labels of everything but the running step drop away
 * (app.css) — the chain then still fits one line on a phone.
 * `text` is the plain sentence: it stays as the screen-reader announcement, because reading a
 * chain of three stage names out loud says nothing about which one is current. */
function ToastSteps({ steps, text }: { steps: ToastStep[]; text: string }) {
  return (
    <>
      <span className="sr-only">{text}</span>
      <span className="toast-steps" aria-hidden>
        {steps.map((s, i) => (
          <Fragment key={s.label}>
            {i > 0 && <span className="toast-chev"><Icon id="chevron" /></span>}
            <span className={`toast-step ${s.state}`}>
              {s.icon === 'printer' ? <PrinterFeedIcon /> : s.icon ? <Icon id={s.icon} /> : <span className="toast-pip" />}
              <span className="toast-step-label">{s.label}</span>
            </span>
          </Fragment>
        ))}
      </span>
    </>
  )
}

/** The success toast's tick, drawn in once (~250ms stroke draw, 08-toasts.css) instead of
 * popping on statically — the toast pill's small cousin of the sync glyph's closing tick
 * (components/SyncGlyph). Written out rather than `<Icon id="check"/>` because a CSS animation
 * on a path inside a `<use>` shadow tree is not reliably applied (same reason as
 * PrinterFeedIcon). Same geometry and box as the sprite's #check, so nothing shifts. */
function ToastCheck() {
  return (
    <svg className="i toast-check" viewBox="0 0 24 24" aria-hidden>
      <path d="M5 12.5 10 17 19 7" />
    </svg>
  )
}

/**
 * The action cluster of a confirm-with-undo toast — «Rückgängig», and the way to get rid of it.
 *
 * The bounded toast stack accepts vertical panning wherever a pill is visible, so an unusually
 * busy burst remains reachable instead of clipping. Mobile lane rules keep that region clear of
 * the FAB, tool bars and variable-height task panels; these controls remove the actionable pill
 * directly when the operator needs the map area back.
 *
 * Two ways out, because they suit different moments: the ✕ for «not now, move», and a flick in
 * either direction for the hand that is already on its way to whatever sits underneath.
 */
function ToastAction({ toast: t }: { toast: Toast }) {
  const [dx, setDx] = useState(0)
  const drag = useRef<{ id: number; x0: number } | null>(null)
  // …in CSS pixels of finger travel. Below this it springs back: the button is a target first and
  // a slider second, so a shaky press must not throw away the undo it was aimed at.
  const FLICK = 56
  const end = (e: React.PointerEvent) => {
    if (!drag.current) return
    const moved = e.clientX - drag.current.x0
    drag.current = null
    if (Math.abs(moved) >= FLICK) dismissToast(t.id)
    else setDx(0)
  }
  return (
    <span className="toast-actions" style={dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(.25, 1 - Math.abs(dx) / (FLICK * 2)) } : undefined}>
      <button
        className="btn toast-action"
        // ⚠️ optional call: pointer capture keeps the flick tracking once the finger leaves the
        // button, but it is not available everywhere (jsdom has no implementation, and neither did
        // older WebViews) — and an undo button that THROWS on touch is worse than one that only
        // follows the finger while it stays on the target.
        onPointerDown={(e) => { drag.current = { id: e.pointerId, x0: e.clientX }; e.currentTarget.setPointerCapture?.(e.pointerId) }}
        onPointerMove={(e) => { if (drag.current?.id === e.pointerId) setDx(e.clientX - drag.current.x0) }}
        onPointerUp={end}
        onPointerCancel={end}
        onClick={() => {
          // a flick ends on the same element as a tap, so the click that follows it must not also
          // fire the action — the toast is already gone, and undoing was not what was asked for
          if (Math.abs(dx) >= FLICK) return
          dismissToast(t.id)
          t.action!.onClick()
        }}
      >
        {t.action!.label}
      </button>
      <button
        className="toast-x"
        title={appConfig.copy.closeDialog}
        aria-label={appConfig.copy.closeDialog}
        onClick={() => dismissToast(t.id)}
      ><Icon id="close" /></button>
    </span>
  )
}

export function Overlays() {
  useForceUpdate()
  const req = confirmReq
  const photo = photoReq
  const closePhoto = () => { photoReq = null; emit() }

  const close = (v: boolean) => {
    const r = confirmReq
    confirmReq = null
    emit()
    r?.resolve(v)
  }

  return (
    <>
      {/* ⚠️ Rendered NEWEST-FIRST into a `column-reverse` stack (see .toaster in 08-toasts.css).
          Reversed flex lays the first DOM child at the baseline, so newest-first is what puts the
          latest message nearest the controls — and it is also what makes the browser anchor the
          scroll port at that end for free. Plain `column` with the natural order looks identical
          until the stack overflows its lane, and then starts the scroll at the OLDEST toast, so a
          burst hides the pill carrying «Rückgängig» below the fold with nothing saying so. */}
      <div className="toaster" aria-live="polite" aria-atomic="false">
        {[...toasts].reverse().map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.tone}${t.toneStyle === 'edge' ? ' toast-edge' : ''}${t.leaving ? ' out' : ''}${!t.action && !t.steps ? ' tap' : ''}`}
            // a pill with no action had NO way off the screen but waiting, while still eating
            // the taps aimed underneath it — plain toasts dismiss on a tap. Action pills keep
            // their own controls (button + flick), live step toasts stay until their job ends.
            onClick={!t.action && !t.steps ? () => dismissToast(t.id) : undefined}
          >
            {t.steps ? <ToastSteps steps={t.steps} text={t.text} /> : (
              <>
                {/* success + check gets the drawn-in tick; other icons (mic, map, …) stay the
                    sprite — their strokes can't be draw-animated through <use> anyway */}
                {t.icon && (t.tone === 'success' && t.icon === 'check' ? <ToastCheck /> : <Icon id={t.icon} />)}
                <span className="toast-message">{t.text}</span>
              </>
            )}
            {t.action && <ToastAction toast={t} />}
          </div>
        ))}
      </div>

      <ConfirmCard
        open={!!req}
        title={req?.title}
        message={req?.message ?? ''}
        items={req?.items}
        note={req?.note}
        confirmLabel={req?.confirmLabel ?? ''}
        cancelLabel={req?.cancelLabel ?? ''}
        danger={req?.danger}
        onResolve={close}
      />

      {/* full-size picture — see openPhoto */}
      {photo && (
        // ⚠️ Its own scrim, above every sheet: this opens FROM the Verlauf drawer, from the
        // Rapport's Beilagen, from the capture page — on the shared z-80 backdrop it landed
        // underneath whichever surface launched it and read as «the picture doesn't open».
        <Overlay
          open onClose={closePhoto} className="photo-view ui-dialog" backdropClassName="photo-scrim"
          ariaLabel={photo.caption || appConfig.copy.photoViewer.title}
        >
          <div className="photo-view-head">
            <span className="photo-view-cap">{photo.caption || appConfig.copy.photoViewer.title}</span>
            {/* same-origin /api/media URL, so `download` really downloads instead of navigating */}
            {photo.download && (
              <a className="ip-btn" href={photo.url} download={photo.filename}>
                <Icon id="download" />{appConfig.copy.photoViewer.download}
              </a>
            )}
            <button className="ctx-x" onClick={closePhoto} aria-label={appConfig.copy.closeDialog} title={appConfig.copy.closeDialog}>
              <Icon id="close" />
            </button>
          </div>
          <PhotoZoom url={photo.url} alt={photo.caption ?? ''} key={photo.url} />
        </Overlay>
      )}
    </>
  )
}

/**
 * Pinch/wheel zoom on the full-size picture. A document photo is often read for a detail —
 * a Kennzeichen, a Gefahrgutnummer, the small print on a Gasflasche — and «so gross wie der
 * Bildschirm» is not always big enough. Wheel or pinch scales around the pointer, dragging
 * pans while zoomed, double-tap toggles back to fit.
 */
function PhotoZoom({ url, alt }: { url: string; alt: string }) {
  const [z, setZ] = useState({ k: 1, x: 0, y: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  // live pointers: two down = pinch. Keyed by pointerId so a lifted finger can't strand the gesture.
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; k: number } | null>(null)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  /** did this gesture travel? a pan's release must not read as a click and undo the zoom */
  const moved = useRef(false)

  const clamp = (n: { k: number; x: number; y: number }) => {
    const k = Math.min(8, Math.max(1, n.k))
    const el = boxRef.current
    if (!el || k === 1) return { k, x: 0, y: 0 }
    // keep the picture over its own frame — panning it off-screen loses it with no way back
    const mx = (el.clientWidth * (k - 1)) / 2
    const my = (el.clientHeight * (k - 1)) / 2
    return { k, x: Math.min(mx, Math.max(-mx, n.x)), y: Math.min(my, Math.max(-my, n.y)) }
  }
  /** scale about a viewport point, so the detail under the finger stays under the finger */
  const zoomAt = (nk: number, cx: number, cy: number) => setZ((p) => {
    const el = boxRef.current
    if (!el) return p
    const r = el.getBoundingClientRect()
    const px = cx - (r.left + r.width / 2)
    const py = cy - (r.top + r.height / 2)
    const k = Math.min(8, Math.max(1, nk))
    return clamp({ k, x: px - ((px - p.x) * k) / p.k, y: py - ((py - p.y) * k) / p.k })
  })

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    zoomAt(z.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY)
  }
  const onDown = (e: React.PointerEvent) => {
    moved.current = false
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: z.k }
      drag.current = null
    } else if (z.k > 1) {
      drag.current = { x: e.clientX, y: e.clientY, ox: z.x, oy: z.y }
    }
  }
  const onMove = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      zoomAt((pinch.current.k * d) / pinch.current.dist, (a.x + b.x) / 2, (a.y + b.y) / 2)
      return
    }
    const d = drag.current
    if (d) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) moved.current = true
      setZ((p) => clamp({ k: p.k, x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }))
    }
  }
  const onUp = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId)
    if (pts.current.size < 2) pinch.current = null
    if (pts.current.size === 0) drag.current = null
  }
  /**
   * A SINGLE click zooms. The surface already shows a zoom cursor, so a click is what anyone
   * tries first — and it did nothing: the zoom sat behind a double-click, the wheel and a pinch,
   * none of which the picture advertises. Click in, click out; the other gestures still work.
   *
   * Guarded on movement, or the release that ends a PAN would zoom out from under the hand.
   */
  const clickZoom = (e: React.MouseEvent) => {
    if (moved.current) return
    if (z.k > 1) setZ({ k: 1, x: 0, y: 0 })
    else zoomAt(3, e.clientX, e.clientY)
  }

  return (
    <div
      ref={boxRef} className="photo-view-zoom" onWheel={onWheel}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onClick={clickZoom}
      data-zoomed={z.k > 1 || undefined}
    >
      <img
        className="photo-view-img" src={url} alt={alt} draggable={false}
        style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.k})` }}
      />
    </div>
  )
}
