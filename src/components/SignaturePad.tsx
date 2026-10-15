import { useCallback, useRef, useState } from 'react'
import { rdpIndices } from '../lib/lineStyle'
import { isBlank, strokesPath, type SignatureStrokes } from '../lib/reportSignature'
import { Button } from './Button'
import s from './SignaturePad.module.css'

// The pad a signature is drawn on (Rapport · Unterschriften). A finger, a pen or a mouse draws on
// it; what is kept is the SHAPE of each stroke, thinned and rounded into a fixed box — no timing, no
// pressure (that would be biometric data). It looks like the line on the paper form: «×», a rule,
// the role under it on the left and «Ort, Datum» on the right.

/** the stored box is this wide; its height follows the pad's aspect at the first stroke */
const BOX_W = 1000
/** how far a thinned stroke may stray from the drawn one, in screen px */
const SIMPLIFY_PX = 1.2

export function SignaturePad({ value, onChange, caption, placeDate, clearLabel, hint, ariaLabel }: {
  value: SignatureStrokes | null
  onChange: (next: SignatureStrokes | null) => void
  /** under the rule, left — «Unterschrift Einsatzleiter» */
  caption: string
  /** under the rule, right — «Oberwil, 15.10.2026» */
  placeDate: string
  clearLabel: string
  /** the empty pad's invitation */
  hint: string
  ariaLabel: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  // the stroke being drawn, in screen px relative to the pad — kept out of state until it ends so
  // a fast hand does not re-render the sheet per pointer event
  const live = useRef<{ id: number; pts: [number, number][] } | null>(null)
  const [livePath, setLivePath] = useState('')

  const scale = useCallback(() => {
    const r = boxRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return null
    const h = value?.h ?? Math.round((BOX_W * r.height) / r.width)
    return { r, k: BOX_W / r.width, h }
  }, [value])

  const toBox = (pts: [number, number][], k: number) => pts.flatMap(([x, y]) => [Math.round(x * k), Math.round(y * k)])

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (live.current) return // a second finger does not start a second stroke
    const sc = scale()
    if (!sc) return
    e.currentTarget.setPointerCapture(e.pointerId)
    live.current = { id: e.pointerId, pts: [[e.clientX - sc.r.left, e.clientY - sc.r.top]] }
    setLivePath('')
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const cur = live.current
    if (!cur || cur.id !== e.pointerId) return
    const sc = scale()
    if (!sc) return
    // coalesced events: a pen on an iPad reports far more points than one per frame
    const evs = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]
    for (const ev of evs.length ? evs : [e.nativeEvent]) cur.pts.push([ev.clientX - sc.r.left, ev.clientY - sc.r.top])
    setLivePath(strokesPath({ w: BOX_W, h: sc.h, d: [toBox(cur.pts, sc.k)] }))
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const cur = live.current
    if (!cur || cur.id !== e.pointerId) return
    live.current = null
    setLivePath('')
    const sc = scale()
    if (!sc) return
    const keep = rdpIndices(cur.pts, SIMPLIFY_PX)
    const d = toBox(keep.map((i) => cur.pts[i]), sc.k)
    onChange({ w: BOX_W, h: sc.h, d: [...(value?.d ?? []), d] })
  }

  const blank = isBlank(value)
  const h = value?.h ?? 300
  return (
    <div className={s.pad}>
      <div
        ref={boxRef}
        className={s.surface}
        role="img"
        aria-label={ariaLabel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {blank && !livePath && <span className={s.hint}>{hint}</span>}
        <span className={s.cross} aria-hidden>×</span>
        <span className={s.rule} aria-hidden />
        <svg className={s.ink} viewBox={`0 0 ${BOX_W} ${h}`} preserveAspectRatio="xMinYMin meet" aria-hidden>
          {value && <path d={strokesPath(value)} />}
          {livePath && <path d={livePath} />}
        </svg>
      </div>
      <div className={s.caption} aria-hidden>
        <span>{caption}</span>
        <span>{placeDate}</span>
      </div>
      {!blank && (
        <Button className={s.clear} onClick={() => onChange(null)}>{clearLabel}</Button>
      )}
    </div>
  )
}

/** a stored signature, read-only (the card's rows, the history) */
export function SignatureImage({ strokes, className }: { strokes: SignatureStrokes; className?: string }) {
  return (
    <svg className={className ?? s.thumb} viewBox={`0 0 ${strokes.w} ${strokes.h}`} preserveAspectRatio="xMinYMid meet" aria-hidden>
      <path d={strokesPath(strokes)} className={s.thumbInk} />
    </svg>
  )
}
