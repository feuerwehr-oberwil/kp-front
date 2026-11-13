// 24h time / date-time entry. ONE way in on every device: the trigger opens the WheelPicker
// popover, which offers the wheels for a finger AND a text field for a keyboard, side by side.
// The split by pointer type it replaced (wheels on touch, a bare text box on the desktop) meant
// every choice added to the popover — the day wheel, «ab Start», «noch da» — was unreachable
// with a mouse. Always 24h regardless of OS language: a native picker renders AM/PM on an
// English device, which is why none is used.

/*
 * - Time popovers join the shared dismissal guard: one Escape closes only the picker. Invalid
 *   typed times stay open with an error; optional values expose «Leeren» left of «Jetzt» and «OK»
 *   in the action row. Named state choices such as «noch da» stay above the wheels. Hold-repeat
 *   buttons support click-only assistive activation without doubling pointer taps.
 * - ONE picker: every clock entry opens `WheelPopover` – no per-surface ± time stepper, no native
 *   `datetime-local`, never day/month/year wheels. Its «Jetzt» and every inline «Jetzt» here stamp
 *   the deployment's clock (`lib/serverClock · serverNow`, 12.11.2026).
 * - ONE date+time control: `DateTimeField` (ISO in/out). EVERY time of the Rapport and its twins
 *   is one (owner, 12.11.2026 – docs/rapport.md › Times): the Zeiten grid, Einsatzende,
 *   Rückmeldung ELZ, the QR-Erfassung's fields, the Anwesenheit's von/bis (`TimeBlockSheet`, which
 *   the Zeitplan's shift sheet shares), the wizard's Alarmzeit, a visit's «Besucht am». What it
 *   shows is what is stored – the day is never inferred after the commit. The trigger reads
 *   «12.11. 11:26» (day quiet, clock loud; the year only off the Einsatz's year, `format ·
 *   fieldWhen`), and the picker ALWAYS shows its bounded day column («Mo 05.10.», `lib/zeitplanFormat
 *   · fmtWheelDay`) from `days` – the incident's (`incidentDays`) or by default the last 60 days.
 *   One narrow row may wear its `stacked` face instead (owner pick A «Gestapelt», 13.11.2026): the
 *   word and the day small above the loud clock – «von 12.11.» / «23:37» – so the QR-Erfassung's
 *   Personen rows keep a one-line name at 390px. Same control, same picker, same value.
 * - A bare clock is `TimeField` (HH:MM + an optional day column), kept for the surfaces outside
 *   the Rapport that ask for one: the Zeitplan's bands (`BandGrid`) and the imported memo's
 *   «Aufnahme begann» (a `required` `TimeField`). The Verlauf composer's «Uhrzeit …» (Wiedervorlage)
 *   opens `WheelPopover` straight off the clock button (`title`, a day column of today + 6 days,
 *   `noNow`, and a `note` that BLOCKS «OK» on a past instant – never rolled to tomorrow).
 */

import { useRef, useState } from 'react'
import { WheelPopover, type WheelValue } from './WheelPicker'
import { FIELD_CLOCK_EMPTY, FIELD_DAY_EMPTY, FIELD_WHEN_EMPTY, fieldDay, hhmm, pad2 } from '../lib/format'
import { serverNow } from '../lib/serverClock'
import { dayRange, RECENT_DAYS } from '../lib/zeitplanFormat'

/** A one-tap answer offered inside the picker — «ab Einsatzbeginn 07:29». */
type Shortcut = { label: string; value?: string; tone?: 'blue' | 'green'; active?: boolean; onPick: () => void }
/** Shown INSTEAD of the value, because the value is not really a clock reading: «ab Start» for a
 *  beginning tied to the alarm, «noch da» for an end that has not happened. The instant behind it
 *  is still stored in full (date included) — this is how it reads, not what it is. */
type Token = { label: string; tone: 'start' | 'open' }

export function TimeField({ value, valueDay, onCommit, disabled, ariaLabel, nowLabel, className, shortcut, clearLabel, clearActive, days, placeholder, token, required }: {
  /** current value as 'HH:MM' ('' = unset) */
  value: string
  /**
   * The calendar day `value` actually sits on — what the day wheel opens on.
   *
   * ⚠️ Only matters together with `days`, and then it matters a great deal: the picker used to
   * seed itself from `new Date()` and copy only the clock off `value`, so the day wheel opened
   * on TODAY whatever day the stamp was on. Because the popover hands a day back on every
   * commit once the incident spans more than one (see onCommit below), correcting 22:15 → 22:10
   * on Wednesday morning moved a Monday-night arrival to Wednesday — a silent two-day jump on a
   * field nobody re-reads. Omit it and nothing changes: the picker still opens on today, which
   * is right for an empty field.
   */
  valueDay?: Date
  /** 'HH:MM' from wheels/typing/«Jetzt»; null when cleared. `day` comes back only when the picker
   *  offered a day wheel and the operator moved it — the caller then knows the calendar day for
   *  certain and does not have to infer it from the old stamp. */
  onCommit: (hhmm: string | null, day?: Date) => void
  disabled?: boolean
  ariaLabel: string
  /** render an inline «Jetzt» button with this label (fast path) */
  nowLabel?: string
  className?: string
  shortcut?: Shortcut
  /** names the clear action in the picker instead of the bin glyph — «noch da» */
  clearLabel?: string
  /** «noch da» is the current state — the tab stays, drawn as pressed */
  clearActive?: boolean
  /** the incident's own days — a bounded day wheel, shown only when the incident spans more than
   *  one. On a single-day incident nothing changes. */
  days?: Date[]
  /** what an EMPTY field reads instead of «--:--» */
  placeholder?: string
  token?: Token
  /** a value that is always there (an imported memo's recording start): no «Leeren» */
  required?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const initial = (() => {
    const m = /^(\d{2}):(\d{2})$/.exec(value)
    const d = valueDay && Number.isFinite(valueDay.getTime()) ? new Date(valueDay) : new Date(serverNow())
    if (m) d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    return d
  })()
  const stampNow = () => {
    const d = new Date(serverNow())
    // …carrying the DAY wherever a day wheel is on offer. Without it the caller has to infer the
    // day from a neighbouring stamp, and every such rule can only reach one day either side: on
    // an Einsatz that has been running since Monday, «Jetzt» pressed on Wednesday was filed on
    // Tuesday. Callers that pass no `days` are untouched — the day stays undefined for them.
    onCommit(hhmm(d), days && days.length > 1 ? d : undefined)
  }

  return (
    <span className={`timefield${className ? ` ${className}` : ''}`}>
      {/* ONE way in, on every device. The desktop used to get a bare text input instead of this,
          which is why the day wheel, «ab Start» and «noch da» were unreachable with a mouse —
          three rounds of fixes landed in a branch half the users never saw. Typing did not go
          away: it moved INSIDE the popover, where it sits beside those same choices. */}
      <button
        type="button" ref={btnRef}
        className={`timefield-trigger${value || token ? '' : ' empty'}${token ? ` tok-${token.tone}` : ''}`}
        disabled={disabled} aria-label={token ? `${ariaLabel}: ${token.label}` : ariaLabel}
        onClick={() => setOpen(true)}
      >
        {token ? token.label : (value || placeholder || '--:--')}
      </button>
      {nowLabel && (
        <button type="button" className="timefield-now" disabled={disabled} onClick={stampNow}>{nowLabel}</button>
      )}
      {open && btnRef.current && (
        <WheelPopover
          anchor={btnRef.current.getBoundingClientRect()}
          initial={initial}
          onClose={() => setOpen(false)}
          onCommit={(v: WheelValue) => {
            setOpen(false)
            onCommit(`${pad2(v.h)}:${pad2(v.mi)}`,
              days && days.length > 1 ? new Date(v.y, v.mo - 1, v.d) : undefined)
          }}
          days={days}
          // a named clear is offered even on an empty field: «noch da» is a state to SET, not a
          // value to erase, so it must not vanish once the field is already empty
          onClear={!required && (value || clearLabel) ? () => { setOpen(false); onCommit(null) } : undefined}
          clearLabel={clearLabel}
          clearActive={clearActive}
          shortcut={shortcut && { ...shortcut, onPick: () => { setOpen(false); shortcut.onPick() } }}
        />
      )}
    </span>
  )
}

/**
 * «12.11. 11:26» as two spans, the day quiet and the clock loud (owner pick A «Ein Feld»,
 * 12.11.2026) — the trigger's face, and the face of every read-out of a Rapport time that is not
 * a plain string (the derived «Ausgerückt», a read-only grid row). Empty → «--.--. --:--».
 * `refYear`: the Einsatz's year; the day carries its year only when it is another one.
 * `stacked`: a word that leads the day on its own small line above the clock — «von 12.11.» /
 * «23:37», empty «von --.--.» / «--:--» (the CSS of `.timefield-trigger.stacked` breaks the lines).
 */
export function When({ iso, refYear, stacked }: { iso?: string | null; refYear: number; stacked?: string }) {
  const d = iso ? new Date(iso) : null
  const ok = !!d && Number.isFinite(d.getTime())
  if (stacked !== undefined) {
    return <>
      <span className="timefield-day">{stacked} {ok && d ? fieldDay(d, refYear) : FIELD_DAY_EMPTY}</span>
      <span className="timefield-clock">{ok && d ? hhmm(d) : FIELD_CLOCK_EMPTY}</span>
    </>
  }
  if (!ok || !d) return <>{FIELD_WHEN_EMPTY}</>
  return <><span className="timefield-day">{fieldDay(d, refYear)}</span> <span className="timefield-clock">{hhmm(d)}</span></>
}

/**
 * Date + time — THE date-time control (05.10.2026; every Rapport time since 12.11.2026). Same
 * popover as TimeField: the bounded day column («Mo 05.10.») beside the hour/minute wheels,
 * «Jetzt» and «OK». Emits ISO.
 *
 * `days` = the days on offer, normally the incident's own (`incidentDays`). Omitted: the last
 * RECENT_DAYS days up to today. The value's own day (or `opensOn`'s) is always added, so a stamp
 * outside the list still opens on itself instead of silently moving. The day column shows for a
 * single day too: the picker always says which date it commits.
 */
export function DateTimeField({ value, onCommit, disabled, ariaLabel, className, days, opensOn, refYear, nowLabel, required, shortcut, clearLabel, clearActive, token, stacked }: {
  /** ISO datetime ('' /undefined = unset) */
  value?: string
  onCommit: (iso: string | null) => void
  disabled?: boolean
  ariaLabel: string
  className?: string
  /** the selectable days (see above); default: the last RECENT_DAYS days through today */
  days?: Date[]
  /** where an EMPTY field's wheels open (ISO): the alarm for an Alarmierungs-/Ausrückzeit, which
   *  lies minutes after it. Default: the deployment's «now». A preselection only — the day stands
   *  in the column before «OK», and what «OK» commits is exactly what it showed. */
  opensOn?: string
  /** the Einsatz's year — the read-out drops the year inside it. Default: the first offered day's
   *  year (`days` start on the alarm day), else this year. */
  refYear?: number
  /** an inline «Jetzt» button beside the field, on the deployment's clock */
  nowLabel?: string
  /** a value that must always be there (a visit's «Besucht am»): the picker offers no «Leeren» */
  required?: boolean
  shortcut?: Shortcut
  /** names the clear action instead of «Leeren» — «noch da»; offered on an empty field too */
  clearLabel?: string
  clearActive?: boolean
  token?: Token
  /** the two-line face for a narrow row: this word + the day small above the clock (`When`). The
   *  word is only seen – `ariaLabel` must still name the field in full. */
  stacked?: string
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const d = value ? new Date(value) : null
  const valid = !!d && Number.isFinite(d.getTime())
  const year = refYear ?? days?.[0]?.getFullYear() ?? new Date(serverNow()).getFullYear()
  const initial = () => {
    if (valid && d) return d
    const pre = opensOn ? new Date(opensOn) : null
    return pre && Number.isFinite(pre.getTime()) ? pre : new Date(serverNow())
  }
  const offered = (at: Date) => {
    const now = new Date(serverNow())
    const base = days && days.length ? days : dayRange(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (RECENT_DAYS - 1)), now)
    // the day the wheels open on is always in the list — else the column shows one day and OK
    // commits another. WheelPopover de-duplicates and sorts.
    return [...base, at]
  }
  const at = open ? initial() : null

  return (
    <span className={`timefield${className ? ` ${className}` : ''}`}>
      <button
        type="button" ref={btnRef}
        className={`timefield-trigger dt${stacked !== undefined ? ' stacked' : ''}${valid || token ? '' : ' empty'}${token ? ` tok-${token.tone}` : ''}`}
        disabled={disabled} aria-label={token ? `${ariaLabel}: ${token.label}` : ariaLabel} onClick={() => setOpen(true)}
      >
        {token ? token.label : <When iso={valid ? value : null} refYear={year} stacked={stacked} />}
      </button>
      {nowLabel && (
        <button type="button" className="timefield-now" disabled={disabled}
          onClick={() => onCommit(new Date(serverNow()).toISOString())}>{nowLabel}</button>
      )}
      {at && btnRef.current && (
        <WheelPopover
          anchor={btnRef.current.getBoundingClientRect()}
          initial={at}
          days={offered(at)} dayAlways
          onClose={() => setOpen(false)}
          onCommit={(v: WheelValue) => {
            setOpen(false)
            onCommit(new Date(v.y, v.mo - 1, v.d, v.h, v.mi, 0, 0).toISOString())
          }}
          onClear={!required && (valid || clearLabel) ? () => { setOpen(false); onCommit(null) } : undefined}
          clearLabel={clearLabel}
          clearActive={clearActive}
          shortcut={shortcut && { ...shortcut, onPick: () => { setOpen(false); shortcut.onPick() } }}
        />
      )}
    </span>
  )
}
