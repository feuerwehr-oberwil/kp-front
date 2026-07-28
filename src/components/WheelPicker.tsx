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
import { fmtDayShort } from '../lib/zeitplanFormat'
import w from './WheelPicker.module.css'

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

const isCoarse = () =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

/** '9', '930', '9:30', '09.30' → [h, mi]; null while it is still being typed or out of range. */
function parseTyped(raw: string): [number, number] | null {
  const t = raw.trim().replace(/[.\s]/g, ':')
  const m = /^(\d{1,2}):?(\d{2})$/.exec(t)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  return h <= 23 && mi <= 59 ? [h, mi] : null
}

/** The popover itself. `withDate` adds day/month/year wheels (year: prev/this/next). */
export function WheelPopover({ anchor, initial, withDate, onCommit, onClose, onClear, shortcut, clearLabel, days }: {
  anchor: DOMRect
  initial: Date
  withDate?: boolean
  onCommit: (v: WheelValue) => void
  onClose: () => void
  /** offered as «Löschen» when set (clears the underlying value) */
  onClear?: () => void
  /** A one-tap answer above the wheels — «ab Einsatzbeginn 07:29». It belongs here rather than
   *  beside the field because it answers the question the picker asks. */
  shortcut?: { label: string; value?: string; tone?: 'blue' | 'green'; onPick: () => void }
  /** names the clear action instead of showing a bin — «noch da», which is what emptying a «bis»
   *  actually means. A bin glyph said «destroy» for an action that records presence. */
  clearLabel?: string
  /**
   * The days this value may fall on — the incident's own days, NOT a date picker.
   *
   * Times carry HH:MM only, and which day was meant used to be inferred from the old stamp. That
   * holds for one night and breaks past it: on a multi-day Einsatz there was no way to say «this
   * stretch belongs to the Wednesday» at all. A bounded wheel says it in one gesture and needs no
   * month or year — an incident touches a handful of days, and they are all known. Omitted or
   * single-day: no wheel appears, so the everyday case pays nothing.
   */
  days?: Date[]
}) {
  const C = appConfig.copy.wheel
  const coarse = isCoarse()
  const [v, setV] = useState<WheelValue>({
    y: initial.getFullYear(), mo: initial.getMonth() + 1, d: initial.getDate(),
    h: initial.getHours(), mi: initial.getMinutes(),
  })
  const years = useMemo(() => {
    const base = new Date().getFullYear()
    return [base - 1, base, base + 1]
  }, [])
  // the incident's days, de-duplicated to midnight so «same day» is a stable key
  const dayList = useMemo(() => {
    const seen = new Map<number, Date>()
    for (const d of days ?? []) {
      const k = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      if (Number.isFinite(k.getTime())) seen.set(k.getTime(), k)
    }
    return [...seen.values()].sort((a, b) => a.getTime() - b.getTime())
  }, [days])
  const dayIndex = dayList.findIndex((d) =>
    d.getFullYear() === v.y && d.getMonth() + 1 === v.mo && d.getDate() === v.d)
  const daysInMonth = new Date(v.y, v.mo, 0).getDate()
  const monthDays = Array.from({ length: daysInMonth }, (_, i) => pad2(i + 1))
  const months = Array.from({ length: 12 }, (_, i) => pad2(i + 1))

  // what the keyboard is holding right now; the wheels follow as soon as it parses
  const [typed, setTyped] = useState(() => `${pad2(initial.getHours())}:${pad2(initial.getMinutes())}`)

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

  // Below the anchor when there's room, else above — and then CLAMPED into the viewport either
  // way. The old estimate was a flat 300px and only chose a side; once the shortcut row was added
  // the popover grew past it, so «OK» ended up under the bottom edge of the screen with no way to
  // reach it. Measured: 9px padding ×2 + 5×44px of wheel + 40px actions + its 8px gap, plus the
  // shortcut row when there is one.
  const height = 18 + 220 + 48 + (shortcut || (onClear && clearLabel) ? 48 : 0) + (coarse ? 0 : 46)
  const up = window.innerHeight - anchor.bottom < height + 16
  // a shortcut or a named clear needs its sentence on one line; the bare wheels do not
  const dayWheel = dayList.length > 1 ? 76 : 0
  const width = withDate ? 316 : (shortcut || clearLabel ? 236 : 196) + dayWheel
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))
  // Always positioned by `top`, so one clamp covers both directions: a popover that would hang off
  // either edge slides back in rather than putting its actions out of reach.
  const wanted = up ? anchor.top - 6 - height : anchor.bottom + 6
  const top = Math.max(8, Math.min(wanted, window.innerHeight - height - 8))
  const style: React.CSSProperties = { position: 'fixed', left, width, top }

  return createPortal(
    <div className="wheelpop" style={style} ref={ref} role="dialog" aria-modal="true">
      {/* KEYBOARD ENTRY, wherever there is a keyboard. The wheels used to be replaced wholesale by
          a bare text input on a fine pointer — which is why every feature added to this popover
          (day wheel, ab Start, noch da) simply did not exist at a desk. Now the popover is the one
          surface everywhere, and typing is an extra way INTO it rather than a second version of
          it. Partial input stays local until it parses, so «1» on the way to «14» is not rejected. */}
      {!coarse && (
        <input
          className={w.typed} value={typed} inputMode="numeric" enterKeyHint="done"
          aria-label={`${C.hour} / ${C.minute}`} placeholder="--:--"
          onChange={(e) => {
            setTyped(e.target.value)
            const hhmm = parseTyped(e.target.value)
            if (hhmm) setV((p) => ({ ...p, h: hhmm[0], mi: hhmm[1] }))
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') onCommit(v) }}
        />
      )}
      {/* THE TABS: answers that are not a clock reading. «ab Start» and «noch da» replace the time
          rather than set one, so they stand apart from the wheels and from OK. */}
      {(shortcut || (onClear && clearLabel)) && (
        <div className={w.tabs}>
          {shortcut && (
            <button type="button" className={`${w.tab}${shortcut.tone === 'green' ? ` ${w.green}` : ''}`}
              onClick={shortcut.onPick}>
              {shortcut.label}
              {shortcut.value && <span className={w.value}>{shortcut.value}</span>}
            </button>
          )}
          {onClear && clearLabel && (
            <button type="button" className={`${w.tab} ${w.green}`} onClick={onClear}>{clearLabel}</button>
          )}
        </div>
      )}
      <div className="wheelpop-cols">
        {withDate && (
          <>
            <Wheel ariaLabel={C.day} items={monthDays} index={Math.min(v.d, daysInMonth) - 1}
              onIndex={(i) => setV((p) => ({ ...p, d: i + 1 }))} />
            <Wheel ariaLabel={C.month} items={months} index={v.mo - 1}
              onIndex={(i) => setV((p) => ({ ...p, mo: i + 1, d: Math.min(p.d, new Date(p.y, i + 1, 0).getDate()) }))} />
            <Wheel ariaLabel={C.year} items={years.map(String)} index={Math.max(0, years.indexOf(v.y))}
              onIndex={(i) => setV((p) => ({ ...p, y: years[i] }))} />
            <span className="wheelpop-sep" aria-hidden />
          </>
        )}
        {dayList.length > 1 && (
          <Wheel ariaLabel={C.day} items={dayList.map(fmtDayShort)} index={Math.max(0, dayIndex)}
            onIndex={(i) => {
              const d = dayList[i]
              if (d) setV((p) => ({ ...p, y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() }))
            }} />
        )}
        <Wheel ariaLabel={C.hour} items={HOURS} index={v.h} onIndex={(i) => setV((p) => ({ ...p, h: i }))} />
        <Wheel ariaLabel={C.minute} items={MINUTES} index={v.mi} onIndex={(i) => setV((p) => ({ ...p, mi: i }))} />
        <div className="wheelpop-band" aria-hidden />
      </div>
      <div className="wheelpop-actions">
        {/* «Jetzt» sits with OK because it, too, produces a clock reading — the tabs above produce
            something that is NOT a clock reading, which is the whole distinction. */}
        <button type="button" className="wheelpop-btn" onClick={stampNow}>{C.now}</button>
        <button type="button" className="wheelpop-btn primary" onClick={() => onCommit(v)}>{C.ok}</button>
      </div>
    </div>,
    document.body,
  )
}
