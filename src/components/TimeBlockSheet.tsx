import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { Sheet } from '../lib/overlays'
import { TimeField } from './TimeField'
import s from './TimeBlockSheet.module.css'

/** bis strictly before von — the block would silently disappear everywhere else. */
const reversed = (b: { from: string; to?: string }) => !!b.to && b.to < b.from

/** One von–bis row. `to` absent = still running, drawn as a state chip instead of a second field. */
export interface TimeBlock {
  key: string
  from: string
  to?: string
  /** shown in place of the «bis» field while the block is open (e.g. «noch da») */
  openLabel?: string
  /** flagged as a problem — e.g. a shift overlapping another. A REVERSED block (bis before von)
   *  is flagged automatically, whatever the caller says. */
  warn?: boolean
  /** date shown above the row when the block is not on the incident's opening day — on a
   *  multi-day Einsatz «07:29» alone never said which day it belonged to */
  dayLabel?: string
  /** «ab Einsatzbeginn»: set this block's start to the incident start in one tap */
  onFromStart?: () => void
  /** right-hand control: the planned/fix toggle in the Zeitplan, nothing in the Anwesenheit */
  trailing?: ReactNode
  onFrom?: (hhmm: string) => void
  onTo?: (hhmm: string) => void
  onRemove?: () => void
}

/**
 * The one sheet behind BOTH per-person time surfaces — the Anwesenheit's recorded blocks and the
 * Zeitplan's planned shifts.
 *
 * They ask the same question about the same person ("when, exactly?"), so they are the same sheet:
 * same frame, same labelled von/bis fields, same add button, same closing note. Only the words and
 * the optional right-hand control differ. Two hand-built dialogs drifted apart within a day —
 * different paddings, one with labels and one without — and at 3am two surfaces that look almost
 * alike are worse than either.
 */
export function TimeBlockSheet({ title, subject, sectionTitle, blocks, emptyLabel, addLabel, onAdd, note, extra, onClose, labels }: {
  title: string
  /** who this sheet is about — field labels read «von – Meier Anna», not «von – Schichten – …» */
  subject: string
  sectionTitle: string
  blocks: TimeBlock[]
  emptyLabel: string
  /** absent = this surface cannot add a block here */
  addLabel?: string
  onAdd?: () => void
  /** closing note; omit where a surface has nothing useful to say */
  note?: string
  /** an additional read-only section under the blocks (the Zeitplan's «tatsächlich anwesend») */
  extra?: ReactNode
  onClose: () => void
  labels: { from: string; to: string; done: string; remove: string; fromStart: string; fromStartHint: string }
}) {
  return (
    <Sheet open onClose={onClose} fit sheetClassName={s.sheet} title={title}
      footer={<button type="button" className="ip-btn primary" onClick={onClose}>{labels.done}</button>}
    >
      <div className={s.group}>
        <h4 className={s.groupTitle}>{sectionTitle}</h4>
        {blocks.length === 0 && <p className={s.note}>{emptyLabel}</p>}
        {blocks.map((b) => (
          // A reversed block renders as NOTHING on the grid (shiftSpan/barGeometry both bail) and
          // counts as zero minutes on the Rapport — it must never look normal here, which is the
          // only place it is visible at all.
          <div key={b.key} className={cx(s.row, (b.warn || reversed(b)) && s.rowWarn)}>
            {b.dayLabel && <span className={s.day}>{b.dayLabel}</span>}
            <span className={s.field}>
              <span className={s.label}>{labels.from}</span>
              <TimeField className={s.time} ariaLabel={`${labels.from} – ${subject}`} value={b.from}
                disabled={!b.onFrom} onCommit={(v) => { if (v) b.onFrom?.(v) }} />
            </span>
            <span className={s.field}>
              <span className={s.label}>{labels.to}</span>
              {b.to != null ? (
                <TimeField className={s.time} ariaLabel={`${labels.to} – ${subject}`} value={b.to}
                  disabled={!b.onTo} onCommit={(v) => { if (v) b.onTo?.(v) }} />
              ) : (
                <em className={s.open}>{b.openLabel}</em>
              )}
            </span>
            {b.onFromStart && (
              <button type="button" className={s.fromStart} onClick={b.onFromStart}
                title={labels.fromStartHint} aria-label={`${labels.fromStart} – ${subject}`}>
                {labels.fromStart}
              </button>
            )}
            {b.trailing}
            {b.onRemove && (
              <button type="button" className={s.del} title={labels.remove} aria-label={`${labels.remove} – ${subject}`}
                onClick={b.onRemove}><Icon id="close" /></button>
            )}
          </div>
        ))}
        {addLabel && onAdd && (
          <button type="button" className={cx('btn', 'ghost', s.add)} onClick={onAdd}>
            <Icon id="plus" />{addLabel}
          </button>
        )}
        {note && <p className={s.note}>{note}</p>}
      </div>
      {extra}
    </Sheet>
  )
}

/** The read-only «this is what actually happened» section — same frame, no controls. */
export function TimeBlockReadOnly({ title, blocks, emptyLabel, note, openLabel }: {
  title: string
  blocks: { from: string; to?: string }[]
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
