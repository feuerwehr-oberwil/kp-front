import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { Sheet } from '../lib/overlays'
import { DateTimeField } from './TimeField'
import { Button, IconButton } from './Button'
import { DoneChip } from './DoneChip'
import { useOneShot } from '../lib/useOneShot'
import s from './TimeBlockSheet.module.css'


/**
 * The card's head: what this stretch IS, in one word and one colour.
 *
 * It carries the state instead of a control sitting next to the times, because a button labelled
 * with a state cannot say whether the word is the current value or what tapping will do — at 3am
 * that is a coin flip. As a head it is simply what the card is, and where a second state exists
 * (the Zeitplan's verfügbar ⇄ eingeteilt) the whole head is the switch: a full-width target
 * instead of a 118px slab competing with the times for attention.
 */
export interface TimeBlockHead {
  label: string
  /** the grid's own colours, so the sheet and the grid teach one vocabulary rather than two */
  tone: 'available' | 'planned' | 'open' | 'done'
  /** present = the head is a switch; absent = it is a read-out (an attendance stretch has no
   *  second state — it is either running or finished, and that is decided elsewhere) */
  onToggle?: () => void
  toggleHint?: string
}

/** Stated, not interpolated: `s[tone]` would silently resolve to undefined if a tone were ever
 *  renamed, and «open» is already taken in this stylesheet by the «noch da» chip. */
const TONE: Record<TimeBlockHead['tone'], string> = {
  available: s.toneAvailable, planned: s.tonePlanned, open: s.toneOpen, done: s.toneDone,
}

/** One von–bis row, both ends ISO and read as date + time (DateTimeField). `to` absent = still
 *  running: the «bis» field then reads `openLabel`. */
export interface TimeBlock {
  key: string
  from: string
  to?: string
  /** shown in place of the «bis» field while the block is open (e.g. «noch da») */
  openLabel?: string
  /** flagged as a problem — a shift overlapping another, or a block whose end is not after its
   *  start. The caller decides: an overlap needs the person's other blocks. */
  warn?: boolean
  /** «ab Einsatzbeginn»: set this block's start to the incident start in one tap. Offered INSIDE
   *  the «von» picker — it answers the question that picker asks, and beside the field it was one
   *  more shape in a row that already had too many. */
  onFromStart?: () => void
  /** the time «ab Beginn» would set, as HH:MM — shown in the shortcut, because a shortcut without
   *  its number is a promise you cannot check before tapping it */
  fromStartValue?: string
  /** this start IS the incident start — the field then reads «ab Beginn» instead of a clock, since
   *  that is what it means. The instant is still stored in full, date included. */
  fromIsStart?: boolean
  /** «noch da»: empty this block's end, which says the person never left. Offered inside the «bis»
   *  picker, where it replaces the bin glyph — emptying a «bis» records presence, it destroys
   *  nothing, and a bin said the opposite of what it did. */
  onReopen?: () => void
  /** what this stretch is — drawn as the card's head */
  head: TimeBlockHead
  /** how long it lasts, already formatted (fmtSpanShort) — «4 h 00», «seit 29 min» */
  duration?: string
  /** the instant the picker committed — the day it showed, never one inferred afterwards */
  onFrom?: (iso: string) => void
  onTo?: (iso: string) => void
  onRemove?: () => void
}

/**
 * The one sheet behind BOTH per-person time surfaces — the Anwesenheit's recorded blocks and the
 * Zeitplan's planned shifts.
 *
 * They ask the same question about the same person ("when, exactly?"), so they are the same sheet:
 * same frame, same labelled von/bis fields, same add button, same optional note. Only the words and
 * the optional right-hand control differ. Two hand-built dialogs drifted apart within a day —
 * different paddings, one with labels and one without — and at 3am two surfaces that look almost
 * alike are worse than either.
 */
export function TimeBlockSheet({ title, subject, sectionTitle, blocks, emptyLabel, addLabel, onAdd, addedLabel, note, extra, danger, onClose, labels, days }: {
  title: string
  /** who this sheet is about — field labels read «von – Meier Anna», not «von – Schichten – …» */
  subject: string
  sectionTitle: string
  blocks: TimeBlock[]
  emptyLabel: string
  /** absent = this surface cannot add a block here */
  addLabel?: string
  onAdd?: () => void
  /** the add is a one-time action (docs/ui-conventions.md · One-time actions): after a tap the
   *  button gives way to ✓ `addedLabel` for a moment (lib/useOneShot), so a double tap adds ONE
   *  block – the Zeitplan's «Schicht erstellen» drafted two identical shifts (05.11.2026). Absent:
   *  every tap adds (the Anwesenheit's «Weiterer Block» guards itself, useAttendanceActions). */
  addedLabel?: string
  /** closing note; omit where a surface has nothing useful to say */
  note?: string
  /** an additional read-only section under the blocks (the Zeitplan's «tatsächlich anwesend») */
  extra?: ReactNode
  /** the sheet's one destructive action (the Anwesenheit's «Person entfernen») — the footer's far
   *  left, by the one footer rule; there is no Abbrechen/primary beside it, the edits are live */
  danger?: ReactNode
  onClose: () => void
  labels: { from: string; to: string; remove: string; fromStart: string; reopen: string; flip: string }
  /** the days the pickers offer — the incident's own (or the planning horizon) */
  days?: Date[]
}) {
  const shot = useOneShot()
  return (
    // NO confirm footer (29.09.2026, owner: «everything should be auto-saved without manual
    // confirmations»): every change here is live the moment it is made, so a primary «Fertig»
    // was only a second ✕ promising an action. ✕ and the swipe close it. The quiet «Alles wird
    // laufend gespeichert.» line under it went too (sweep 30.10.2026, owner: «not very useful»,
    // and it clipped at the bottom of the phone). A `danger` alone takes the footer's far left.
    <Sheet open onClose={onClose} fit sheetClassName={s.sheet} title={title} footer={danger}>
      <div className={s.group}>
        <h4 className={s.groupTitle}>{sectionTitle}</h4>
        {blocks.length === 0 && <p className={s.note}>{emptyLabel}</p>}
        {blocks.map((b) => (
          // A reversed block renders as NOTHING on the grid (shiftSpan/barGeometry both bail) and
          // counts as zero minutes on the Rapport — it must never look normal here, which is the
          // only place it is visible at all.
          // Two zones, always in this order: the TIMES on the left, the ACTIONS on the right.
          // They are real groups rather than six loose flex children, because loose children wrap
          // one at a time: a row offering «ab Beginn» pushed its state chip onto a second line
          // while the row below it kept the chip inline and sent only the ✕ down — two rows of the
          // same kind in two different shapes, with the ✕ landing left on one and right on the
          // other. Grouped, the actions wrap as one block or not at all.
          <div key={b.key} className={cx(s.card, b.warn && s.cardWarn)}>
            {/* THE HEAD. A container, not one big button: the bin cannot nest inside the toggle,
                so the toggle takes the room it can and the delete sits beside it, aligned — instead
                of floating in the block's top-right corner on no line with anything. */}
            <div className={cx(s.head, TONE[b.head.tone])}>
              {b.head.onToggle ? (
                <button type="button" className={s.headMain} onClick={b.head.onToggle}
                  title={b.head.toggleHint} aria-label={`${b.head.label} – ${subject} – ${labels.flip}`}>
                  <span className={s.swatch} aria-hidden />
                  <b>{b.head.label}</b>
                  {/* the always-visible ⇄, at the head's right edge beside the duration – the
                      number is the thing that flips, so the sign sits on it. `labels.flip`
                      («umschalten») lives on in the aria-label above. */}
                  <Icon id="swap" className={s.flip} />
                </button>
              ) : (
                <span className={s.headMain}>
                  <span className={s.swatch} aria-hidden />
                  <b>{b.head.label}</b>
                </span>
              )}
              {b.duration && <span className={s.duration}>{b.duration}</span>}
              {/* The bin, a full --tap square (UX sweep F1, 20.10.2026). It was a grey 34px ✕, the
                  twin of the sheet's own close ✕ two rows up: a tired hand closing the sheet erased
                  somebody's stretch. A ✕ only closes. Grey, like every inline row bin (Rapport rows,
                  Ansichten) — not the red outline, which is a footer's delete (owner, F4 rework
                  21.10.2026). The undo toast stays the caller's (useAttendanceActions / useShiftActions). */}
              {b.onRemove && (
                <IconButton className={s.del} label={`${labels.remove} – ${subject}`} title={labels.remove}
                  onClick={b.onRemove}>
                  <Icon id="trash" />
                </IconButton>
              )}
            </div>
            {/* THE BODY: nothing but the two times, read as one pair. Each field carries its own
                date («12.11. 22:15») since 12.11.2026 — the caption that hung under the field to
                say which day it was is gone with the guess it explained. */}
            <span className={s.times}>
              <span className={s.field}>
                <span className={s.label}>{labels.from}</span>
                <DateTimeField className={s.time} ariaLabel={`${labels.from} – ${subject}`} value={b.from}
                  required disabled={!b.onFrom} onCommit={(iso) => { if (iso) b.onFrom?.(iso) }}
                  days={days}
                  token={b.fromIsStart ? { label: labels.fromStart, tone: 'start' as const } : undefined}
                  shortcut={b.onFromStart && {
                    label: labels.fromStart, value: b.fromStartValue,
                    // stays visible while it IS the value, drawn as pressed — otherwise the tab
                    // vanished exactly when you needed it to get back to that state
                    active: b.fromIsStart, onPick: b.onFromStart,
                  }} />
              </span>
              <span className={s.sep} aria-hidden>–</span>
              <span className={s.field}>
                <span className={s.label}>{labels.to}</span>
                {/* An open stretch keeps a real field, reading «noch da». It used to be an <em>:
                    it looked like a value, and there was no way to close the stretch from here at
                    all — the one place its times are edited. */}
                <DateTimeField className={cx(s.time, b.to == null && s.timeOpen)}
                  ariaLabel={`${labels.to} – ${subject}`} value={b.to}
                  token={b.to == null && b.openLabel ? { label: b.openLabel, tone: 'open' as const } : undefined}
                  required={!b.onReopen}
                  disabled={!b.onTo} onCommit={(iso) => { if (iso == null) b.onReopen?.(); else b.onTo?.(iso) }}
                  clearLabel={b.onReopen ? labels.reopen : undefined}
                  clearActive={b.to == null} days={days} />
              </span>
            </span>
          </div>
        ))}
        {addLabel && onAdd && (addedLabel && shot.done
          ? <DoneChip className={s.add}>{addedLabel}</DoneChip>
          : (
            <Button variant="quiet" icon={<Icon id="plus" />} className={s.add} onClick={() => (addedLabel ? shot.run(onAdd) : onAdd())}>
              {addLabel}
            </Button>
          ))}
        {note && <p className={s.note}>{note}</p>}
      </div>
      {extra}
    </Sheet>
  )
}

/** The read-only «this is what actually happened» section — same frame, no controls. */
export function TimeBlockReadOnly({ title, blocks, emptyLabel, note, openLabel }: {
  title: string
  blocks: { from: string; to?: string; dayLabel?: string }[]
  emptyLabel: string
  note: string
  openLabel: string
}) {
  return (
    <div className={cx(s.group, s.groupSecond)}>
      <h4 className={s.groupTitle}>{title}</h4>
      {blocks.length === 0 ? (
        <p className={s.note}>{emptyLabel}</p>
      ) : (
        <ul className={s.readOnly}>
          {blocks.map((b, i) => (
            <li key={i}>
              {b.dayLabel && <em className={s.day}>{b.dayLabel}</em>}
              <b>{b.from} – {b.to ?? ''}</b>
              {b.to == null && <em className={s.open}>{openLabel}</em>}
            </li>
          ))}
        </ul>
      )}
      <p className={s.note}>{note}</p>
    </div>
  )
}
