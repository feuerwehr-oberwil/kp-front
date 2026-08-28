// 24h wheel picker — the app's own time/date entry (decided 2026-07-14): native pickers
// render AM/PM on English-language devices and can't be themed, so this popover gives the
// iOS-style scroll wheels with a GUARANTEED 24h clock on every device. Columns are
// scroll-snap lists (hour/minute, optionally day/month/year); the value is whatever rests
// under the center band. «Jetzt» is the fast path (stamp current clock and close), «OK»
// commits a scrolled selection. Portalled to <body> so no card/accordion can clip it.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { appConfig } from '../config/appConfig'
import { fmtDayShort } from '../lib/zeitplanFormat'
import { scrollBehavior } from '../lib/reducedMotion'
import w from './WheelPicker.module.css'

const ITEM_H = 44 // px, one wheel row — a full ≥44px tap target; must match .wheel-item/.wheel-pad/.wheelpop-band in app.css

/**
 * How many copies of the list a LOOPING wheel holds, and which one the finger is kept in.
 *
 * A clock has no first and no last minute, and the wheels behaved as if it did: at 23:59 the
 * only way to 00:05 was to drag the whole column back down through twenty-three hours. Seven
 * bands is what makes the loop invisible — the middle one leaves three bands of runway in each
 * direction (hours ≈ 3100px, minutes ≈ 7900px), which is further than a hard fling carries, so
 * the silent re-centre almost always happens while the wheel is already still.
 */
const LOOPS = 7
const MID_BAND = 3

function Wheel({ items, index, onIndex, ariaLabel, loop = false }: {
  items: string[]
  index: number
  onIndex: (i: number) => void
  ariaLabel: string
  /** wrap around — for the values that genuinely have no ends (hour, minute). A bounded list
   *  (the incident's days, a month, a year) must NOT loop: running off the end of those means
   *  the value does not exist, and a wheel that silently returns to January says it does. */
  loop?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const settle = useRef(0)
  const n = items.length
  // the same list, several times over — identical content, so a jump between copies is invisible
  const rows = loop ? Array.from({ length: n * LOOPS }, (_, i) => items[i % n]) : items
  const base = loop ? MID_BAND * n : 0
  const top = (i: number) => (base + i) * ITEM_H

  // position on mount / external change (e.g. «Jetzt») without fighting the user's scroll
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const at = Math.round(el.scrollTop / ITEM_H)
    if (!loop) { if (at !== index) el.scrollTop = index * ITEM_H; return }
    // already showing this value in SOME band → leave it alone, or every settle would yank the
    // column back to the middle under the finger
    if (((at % n) + n) % n !== index) el.scrollTop = top(index)
  }, [index, loop, n]) // eslint-disable-line react-hooks/exhaustive-deps -- `top` is derived from these

  const onScroll = () => {
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      const el = ref.current
      if (!el) return
      const at = Math.round(el.scrollTop / ITEM_H)
      if (!loop) {
        const i = Math.max(0, Math.min(n - 1, at))
        if (i !== index) onIndex(i)
        return
      }
      const i = ((at % n) + n) % n
      // back to the middle band, on the SAME value — the row under the band is identical, so
      // nothing moves on screen. Only when it is actually needed: assigning scrollTop cancels
      // iOS momentum, and doing it after every flick would make the wheel feel sticky.
      if (at < n || at >= (LOOPS - 1) * n) el.scrollTop = top(i)
      if (i !== index) onIndex(i)
    }, 90)
  }
  return (
    <div className="wheel" ref={ref} onScroll={onScroll} role="listbox" aria-label={ariaLabel} tabIndex={0}>
      <div className="wheel-pad" aria-hidden />
      {rows.map((it, i) => {
        const value = loop ? i % n : i
        // ⚠️ the selected ROW, not every row holding the selected value: with seven copies on
        // the strip, marking them all would put `.on` on seven rows and read out seven
        // «selected» options. The one in the middle band is the one the picker commits.
        const on = value === index && (!loop || Math.floor(i / n) === MID_BAND)
        return (
          <button
            key={i} type="button" role="option" aria-selected={on}
            className={`wheel-item${on ? ' on' : ''}`}
            onClick={() => { onIndex(value); const el = ref.current; if (el) el.scrollTo({ top: i * ITEM_H, behavior: scrollBehavior() }) }}
          >{it}</button>
        )
      })}
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
export function WheelPopover({ anchor, initial, withDate, onCommit, onClose, onClear, shortcut, clearLabel, clearActive, days }: {
  anchor: DOMRect
  initial: Date
  withDate?: boolean
  onCommit: (v: WheelValue) => void
  onClose: () => void
  /** offered as «Löschen» when set (clears the underlying value) */
  onClear?: () => void
  /** A one-tap answer above the wheels — «ab Einsatzbeginn 07:29». It belongs here rather than
   *  beside the field because it answers the question the picker asks. */
  shortcut?: { label: string; value?: string; tone?: 'blue' | 'green'; active?: boolean; onPick: () => void }
  /** names the clear action instead of showing a bin — «noch da», which is what emptying a «bis»
   *  actually means. A bin glyph said «destroy» for an action that records presence. */
  clearLabel?: string
  /** the «noch da» tab is the CURRENT state — drawn as pressed, so the field says what it is even
   *  while the wheels are being scrolled past it */
  clearActive?: boolean
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
  const height = 18 + (coarse ? 220 : withDate ? 96 : 52) + 48 + (shortcut || (onClear && clearLabel) ? 48 : 0)
  const up = window.innerHeight - anchor.bottom < height + 16
  // a shortcut or a named clear needs its sentence on one line; the bare wheels do not
  const dayWheel = dayList.length > 1 ? 76 : 0
  const width = withDate ? (coarse ? 316 : 288) : (shortcut || clearLabel ? 236 : 196) + dayWheel
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))
  // Always positioned by `top`, so one clamp covers both directions: a popover that would hang off
  // either edge slides back in rather than putting its actions out of reach.
  const wanted = up ? anchor.top - 6 - height : anchor.bottom + 6
  const top = Math.max(8, Math.min(wanted, window.innerHeight - height - 8))
  const style: React.CSSProperties = { position: 'fixed', left, width, top }

  // ⚠️ `role="dialog"` WITHOUT `aria-modal`. It claimed to be modal until 27.08. and never was:
  // there is no backdrop, no focus trap and no focus restore, so Tab walks straight out into the
  // page behind while a screen reader is told the rest of it is inert. It is a popover — an
  // outside tap and Esc close it (see the effect above) — and that is the honest contract.
  // Making it a real modal would mean routing it through overlays/Popover, which does not do the
  // outside-tap swallow this one needs.
  return createPortal(
    <div className="wheelpop" style={style} ref={ref} role="dialog">
      {/* KEYBOARD ENTRY, wherever there is a keyboard. The wheels used to be replaced wholesale by
          a bare text input on a fine pointer — which is why every feature added to this popover
          (day wheel, ab Start, noch da) simply did not exist at a desk. Now the popover is the one
          surface everywhere, and typing is an extra way INTO it rather than a second version of
          it. Partial input stays local until it parses, so «1» on the way to «14» is not rejected. */}

      {/* THE TABS: answers that are not a clock reading. «ab Start» and «noch da» replace the time
          rather than set one, so they stand apart from the wheels and from OK. */}
      {(shortcut || (onClear && clearLabel)) && (
        <div className={w.tabs}>
          {shortcut && (
            <button type="button" aria-pressed={!!shortcut.active}
              className={`${w.tab}${shortcut.tone === 'green' ? ` ${w.green}` : ''}${shortcut.active ? ` ${w.tabOn}` : ''}`}
              onClick={shortcut.onPick}>
              {shortcut.label}
              {shortcut.value && <span className={w.value}>{shortcut.value}</span>}
            </button>
          )}
          {onClear && clearLabel && (
            <button type="button" aria-pressed={!!clearActive}
              className={`${w.tab} ${w.green}${clearActive ? ` ${w.tabOn}` : ''}`}
              onClick={onClear}>{clearLabel}</button>
          )}
        </div>
      )}
      <div className="wheelpop-cols">
        {withDate && coarse && (
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
        {dayList.length > 1 && coarse && (
          <Wheel ariaLabel={C.day} items={dayList.map(fmtDayShort)} index={Math.max(0, dayIndex)}
            onIndex={(i) => {
              const d = dayList[i]
              if (d) setV((p) => ({ ...p, y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() }))
            }} />
        )}
        {/* ONE input, not two. A keyboard gets a field and a day list; a finger gets the wheels.
            Showing both at once meant the same value had two controls sitting on top of each
            other, and it was never clear which one the popover would actually commit. */}
        {coarse ? (
          <>
            {/* the two that loop: a clock has no first and no last minute, so 23:59 → 00:05 is
                one flick down rather than a drag back through the whole day */}
            <Wheel loop ariaLabel={C.hour} items={HOURS} index={v.h} onIndex={(i) => setV((p) => ({ ...p, h: i }))} />
            <Wheel loop ariaLabel={C.minute} items={MINUTES} index={v.mi} onIndex={(i) => setV((p) => ({ ...p, mi: i }))} />
            <div className="wheelpop-band" aria-hidden />
          </>
        ) : (
          <div className={w.typedRow}>
            <input
              className={w.typed} value={typed} inputMode="numeric" enterKeyHint="done" autoFocus
              aria-label={`${C.hour} / ${C.minute}`} placeholder="--:--"
              onChange={(e) => {
                setTyped(e.target.value)
                const hhmm = parseTyped(e.target.value)
                if (hhmm) setV((p) => ({ ...p, h: hhmm[0], mi: hhmm[1] }))
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') onCommit(v) }}
            />
            {/* ⚠️ With a keyboard the date needs its OWN controls: the day/month/year wheels are
                a touch affordance, and rendering them here left a tall empty box with nothing in
                it but the clock. Three selects — the same choice the wheels offer, in the shape a
                mouse can use. Native selects follow the day-list precedent right below. */}
            {withDate && (
              <span className={w.dateRow}>
                <select className={w.daySel} aria-label={C.day} value={Math.min(v.d, daysInMonth)}
                  onChange={(e) => setV((p) => ({ ...p, d: Number(e.target.value) }))}>
                  {monthDays.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
                </select>
                <select className={w.daySel} aria-label={C.month} value={v.mo}
                  onChange={(e) => setV((p) => {
                    const mo = Number(e.target.value)
                    return { ...p, mo, d: Math.min(p.d, new Date(p.y, mo, 0).getDate()) }
                  })}>
                  {months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select className={w.daySel} aria-label={C.year} value={v.y}
                  onChange={(e) => setV((p) => ({ ...p, y: Number(e.target.value) }))}>
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </span>
            )}
            {dayList.length > 1 && !withDate && (
              <select className={w.daySel} aria-label={C.day} value={Math.max(0, dayIndex)}
                onChange={(e) => {
                  const d = dayList[Number(e.target.value)]
                  if (d) setV((p) => ({ ...p, y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() }))
                }}>
                {dayList.map((d, i) => <option key={i} value={i}>{fmtDayShort(d)}</option>)}
              </select>
            )}
          </div>
        )}
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
