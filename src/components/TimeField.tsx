// 24h time / date-time entry — hybrid by pointer type (decided 2026-07-14):
// - touch devices: trigger button opens the WheelPicker popover (snap wheels, always 24h);
// - desktop (fine pointer): plain text entry, normalised on commit — typing beats wheels
//   with a keyboard. Both guarantee a 24h clock regardless of the OS language (native
//   pickers render AM/PM on English devices, which is why they're not used).

import { useEffect, useRef, useState } from 'react'
import { WheelPopover, type WheelValue } from './WheelPicker'

const pad2 = (n: number) => String(n).padStart(2, '0')

const isCoarse = () =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

/** '0715' | '7:15' | '19.30' → 'HH:MM' (24h), or null when not parseable/empty. */
export function parseHHMM(raw: string): string | null {
  const s = raw.trim().replace(/[.\s]/g, ':')
  if (!s) return null
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return `${pad2(h)}:${pad2(min)}`
}

/** '14.7.2026 17:15' | '14.07.26 1715' → Date, or null. Year accepts 2 or 4 digits. */
export function parseDateTime(raw: string): Date | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})[,\s]+(\d{1,2})[:.]?(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const [d, mo, yRaw, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])]
  const y = yRaw < 100 ? 2000 + yRaw : yRaw
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const out = new Date(y, mo - 1, d, h, mi, 0, 0)
  return Number.isFinite(out.getTime()) && out.getDate() === d ? out : null
}

function TextCommitInput({ value, display, commit, disabled, ariaLabel, placeholder, wide }: {
  value: string
  display: string
  commit: (raw: string) => void
  disabled?: boolean
  ariaLabel: string
  placeholder: string
  wide?: boolean
}) {
  const [text, setText] = useState(display)
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setText(display) }, [display, focused])
  return (
    <input
      type="text" inputMode={wide ? 'text' : 'numeric'} placeholder={placeholder}
      className={`timefield-input${wide ? ' dt' : ''}`}
      value={text} disabled={disabled} aria-label={ariaLabel} enterKeyHint="done"
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => { setFocused(false); commit(e.target.value) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      data-value={value}
    />
  )
}

export function TimeField({ value, onCommit, disabled, ariaLabel, nowLabel, className }: {
  /** current value as 'HH:MM' ('' = unset) */
  value: string
  /** 'HH:MM' from wheels/typing/«Jetzt»; null when cleared */
  onCommit: (hhmm: string | null) => void
  disabled?: boolean
  ariaLabel: string
  /** render an inline «Jetzt» button with this label (fast path) */
  nowLabel?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const coarse = isCoarse()

  const initial = (() => {
    const m = /^(\d{2}):(\d{2})$/.exec(value)
    const d = new Date()
    if (m) d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    return d
  })()
  const stampNow = () => {
    const d = new Date()
    onCommit(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`)
  }

  return (
    <span className={`timefield${className ? ` ${className}` : ''}`}>
      {coarse ? (
        <button
          type="button" ref={btnRef} className={`timefield-trigger${value ? '' : ' empty'}`}
          disabled={disabled} aria-label={ariaLabel} onClick={() => setOpen(true)}
        >
          {value || '--:--'}
        </button>
      ) : (
        <TextCommitInput
          value={value} display={value} disabled={disabled} ariaLabel={ariaLabel} placeholder="--:--"
          commit={(raw) => {
            const hhmm = parseHHMM(raw)
            if (hhmm) onCommit(hhmm)
            else if (!raw.trim()) onCommit(null)
            // gibberish → TextCommitInput re-syncs to the last good display
          }}
        />
      )}
      {nowLabel && (
        <button type="button" className="timefield-now" disabled={disabled} onClick={stampNow}>{nowLabel}</button>
      )}
      {open && btnRef.current && (
        <WheelPopover
          anchor={btnRef.current.getBoundingClientRect()}
          initial={initial}
          onClose={() => setOpen(false)}
          onCommit={(v: WheelValue) => { setOpen(false); onCommit(`${pad2(v.h)}:${pad2(v.mi)}`) }}
          onClear={value ? () => { setOpen(false); onCommit(null) } : undefined}
        />
      )}
    </span>
  )
}

/** Date + time variant — wheels (incl. day/month/year) on touch, `TT.MM.JJJJ HH:MM` text
 *  entry on desktop. Emits ISO. */
export function DateTimeField({ value, onCommit, disabled, ariaLabel, className }: {
  /** ISO datetime ('' /undefined = unset) */
  value?: string
  onCommit: (iso: string | null) => void
  disabled?: boolean
  ariaLabel: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const coarse = isCoarse()
  const d = value ? new Date(value) : null
  const valid = d && Number.isFinite(d.getTime())
  const display = valid
    ? `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    : ''

  return (
    <span className={`timefield${className ? ` ${className}` : ''}`}>
      {coarse ? (
        <button
          type="button" ref={btnRef} className={`timefield-trigger dt${valid ? '' : ' empty'}`}
          disabled={disabled} aria-label={ariaLabel} onClick={() => setOpen(true)}
        >
          {display || '--.--.---- --:--'}
        </button>
      ) : (
        <TextCommitInput
          value={value ?? ''} display={display} disabled={disabled} ariaLabel={ariaLabel}
          placeholder="TT.MM.JJJJ HH:MM" wide
          commit={(raw) => {
            const parsed = parseDateTime(raw)
            if (parsed) onCommit(parsed.toISOString())
            else if (!raw.trim()) onCommit(null)
          }}
        />
      )}
      {open && btnRef.current && (
        <WheelPopover
          anchor={btnRef.current.getBoundingClientRect()}
          initial={valid ? d : new Date()}
          withDate
          onClose={() => setOpen(false)}
          onCommit={(v: WheelValue) => {
            setOpen(false)
            onCommit(new Date(v.y, v.mo - 1, v.d, v.h, v.mi, 0, 0).toISOString())
          }}
          onClear={valid ? () => { setOpen(false); onCommit(null) } : undefined}
        />
      )}
    </span>
  )
}
