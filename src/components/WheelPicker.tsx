// 24h wheel picker — the app's own time/date entry (decided 2026-07-14): native pickers
// render AM/PM on English-language devices and can't be themed, so this popover gives the
// iOS-style scroll wheels with a GUARANTEED 24h clock on every device. Columns are
// scroll-snap lists (hour/minute, optionally day/month/year); the value is whatever rests
// under the center band. «Jetzt» is the fast path (stamp current clock and close), «OK»
// commits a scrolled selection. Portalled to <body> so no card/accordion can clip it.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'

const ITEM_H = 44 // px, one wheel row — a full ≥44px tap target; must match .wheel-item/.wheel-pad/.wheelpop-band in app.css

function Wheel({ items, index, onIndex, ariaLabel }: {
  items: string[]
  index: number
  onIndex: (i: number) => void
  ariaLabel: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const settle = useRef(0)
  // position on mount / external change (e.g. «Jetzt») without fighting the user's scroll
  useEffect(() => {
    const el = ref.current
    if (el && Math.round(el.scrollTop / ITEM_H) !== index) el.scrollTop = index * ITEM_H
  }, [index])
  const onScroll = () => {
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      const el = ref.current
      if (!el) return
      const i = Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / ITEM_H)))
      if (i !== index) onIndex(i)
    }, 90)
  }
  return (
    <div className="wheel" ref={ref} onScroll={onScroll} role="listbox" aria-label={ariaLabel} tabIndex={0}>
      <div className="wheel-pad" aria-hidden />
      {items.map((it, i) => (
        <button
          key={i} type="button" role="option" aria-selected={i === index}
          className={`wheel-item${i === index ? ' on' : ''}`}
          onClick={() => { onIndex(i); const el = ref.current; if (el) el.scrollTo({ top: i * ITEM_H, behavior: 'smooth' }) }}
        >{it}</button>
      ))}
      <div className="wheel-pad" aria-hidden />
    </div>
  )
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const HOURS = Array.from({ length: 24 }, (_, i) => pad2(i))
const MINUTES = Array.from({ length: 60 }, (_, i) => pad2(i))

export interface WheelValue { y: number; mo: number; d: number; h: number; mi: number }

/** The popover itself. `withDate` adds day/month/year wheels (year: prev/this/next). */
export function WheelPopover({ anchor, initial, withDate, onCommit, onClose, onClear }: {
  anchor: DOMRect
  initial: Date
  withDate?: boolean
  onCommit: (v: WheelValue) => void
  onClose: () => void
  /** offered as «Löschen» when set (clears the underlying value) */
  onClear?: () => void
}) {
  const C = appConfig.copy.wheel
  const [v, setV] = useState<WheelValue>({
    y: initial.getFullYear(), mo: initial.getMonth() + 1, d: initial.getDate(),
    h: initial.getHours(), mi: initial.getMinutes(),
  })
  const years = useMemo(() => {
    const base = new Date().getFullYear()
    return [base - 1, base, base + 1]
  }, [])
  const daysInMonth = new Date(v.y, v.mo, 0).getDate()
  const days = Array.from({ length: daysInMonth }, (_, i) => pad2(i + 1))
  const months = Array.from({ length: 12 }, (_, i) => pad2(i + 1))

  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // An outside tap may ONLY dismiss the wheel — it must never also activate what sits
    // underneath (e.g. the capture view's status button flipping someone to «gegangen»
    // while they just wanted to finish the time entry, feedback 2026-07-18). Capture-phase
    // pointerdown swallows the gesture and a one-shot click-capture eats the synthesized
    // click that follows.
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        e.preventDefault()
        e.stopPropagation()
        const swallow = (ce: Event) => { ce.stopPropagation(); ce.preventDefault() }
        document.addEventListener('click', swallow, { capture: true, once: true })
        window.setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 400)
        onClose()
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDoc, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const stampNow = () => {
    const n = new Date()
    onCommit({ y: n.getFullYear(), mo: n.getMonth() + 1, d: n.getDate(), h: n.getHours(), mi: n.getMinutes() })
  }

  // below the anchor when there's room, else above; clamped into the viewport laterally
  const height = 300 // ≈ padding + 5×44px wheel + actions row (keep in sync with app.css)
  const up = window.innerHeight - anchor.bottom < height + 16
  const width = withDate ? 316 : 196
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))
  const style: React.CSSProperties = {
    position: 'fixed', left, width,
    ...(up ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
  }

  return createPortal(
    <div className="wheelpop" style={style} ref={ref} role="dialog" aria-modal="true">
      <div className="wheelpop-cols">
        {withDate && (
          <>
            <Wheel ariaLabel={C.day} items={days} index={Math.min(v.d, daysInMonth) - 1}
              onIndex={(i) => setV((p) => ({ ...p, d: i + 1 }))} />
            <Wheel ariaLabel={C.month} items={months} index={v.mo - 1}
              onIndex={(i) => setV((p) => ({ ...p, mo: i + 1, d: Math.min(p.d, new Date(p.y, i + 1, 0).getDate()) }))} />
            <Wheel ariaLabel={C.year} items={years.map(String)} index={Math.max(0, years.indexOf(v.y))}
              onIndex={(i) => setV((p) => ({ ...p, y: years[i] }))} />
            <span className="wheelpop-sep" aria-hidden />
          </>
        )}
        <Wheel ariaLabel={C.hour} items={HOURS} index={v.h} onIndex={(i) => setV((p) => ({ ...p, h: i }))} />
        <Wheel ariaLabel={C.minute} items={MINUTES} index={v.mi} onIndex={(i) => setV((p) => ({ ...p, mi: i }))} />
        <div className="wheelpop-band" aria-hidden />
      </div>
      <div className="wheelpop-actions">
        {onClear && (
          <button type="button" className="wheelpop-btn clear" onClick={onClear} title={C.clear} aria-label={C.clear}>
            <Icon id="trash" />
          </button>
        )}
        <button type="button" className="wheelpop-btn" onClick={stampNow}>{C.now}</button>
        <button type="button" className="wheelpop-btn primary" onClick={() => onCommit(v)}>{C.ok}</button>
      </div>
    </div>,
    document.body,
  )
}
