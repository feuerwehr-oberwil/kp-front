// The read view's pieces around the visit card (VisitSections · SummaryCard): the card's own
// rows, the one line «Abgeschlossen … / Korrigiert …» that opens the earlier versions, and the
// other visits at the same stop — a second checklist at the same object is a second card under
// the first (owner, 15.10.2026), not a list of its own.

import { useEffect, useState } from 'react'
import { Icon } from '../../lib/icons'
import { appConfig } from '../../config/appConfig'
import { getRevisions } from '../../objectVisits/api'
import { personName, type Revision } from '../../objectVisits/types'
import { fmtDate, fmtWhen, lifecycleLabel } from './ovFormat'
import s from './ObjectVisits.module.css'

/** A row at the visit card's foot. */
export function CardRow({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  return (
    <button type="button" className={s.row} onClick={onClick}>
      <Icon id={icon} className={s.rowGlyph} />
      <span className={s.rowMain}><span className={s.rowTitle}>{title}</span></span>
      <Icon id="chevron" className={s.chev} />
    </button>
  )
}

const short = (iso: string) => `${fmtDate(iso).slice(0, 6)} ${fmtWhen(iso).split(' ').pop()}`
const long = (iso: string) => `${fmtDate(iso)} ${fmtWhen(iso).split(' ').pop()}`

/**
 * When the visit was finished, and corrected since — one line; with corrections it opens the
 * versions, each its report. The drafts' save points before the completion are not history (on
 * prod a 10-minute visit left up to 8 of them, 13.10.2026). Nothing while the server cannot be
 * asked: the card above is the visit either way.
 */
export function VisitHistory({ visitId, onReport }: { visitId: string; onReport: (revision: number) => void }) {
  const C = appConfig.copy.objectVisits
  const [revs, setRevs] = useState<Revision[] | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let alive = true
    void getRevisions(visitId)
      .then((r) => { if (alive) setRevs([...r].sort((a, b) => a.revision - b.revision)) })
      .catch(() => {})
    return () => { alive = false }
  }, [visitId])
  const done = (revs ?? []).filter((r) => r.lifecycle === 'completed')
  if (!done.length) return null
  const corr = done.slice(1)
  const label = corr.length
    ? `${C.corrected} ${short(corr[corr.length - 1].acceptedAt)}`
    : `${lifecycleLabel('completed')} ${short(done[0].acceptedAt)}`
  const inner = (
    <>
      <Icon id="history" className={s.rowGlyph} />
      <span className={s.rowMain}><span className={s.rowSub}>{label}</span></span>
      {corr.length > 0 && <Icon id="chevron-down" className={s.chev} />}
    </>
  )
  return (
    <>
      {corr.length
        ? <button type="button" className={`${s.row} ${s.rowQuiet}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>{inner}</button>
        : <div className={`${s.rowStatic} ${s.rowQuiet}`}>{inner}</div>}
      {open && [...done].reverse().map((r) => (
        <button key={r.revision} type="button" className={s.row} onClick={() => onReport(r.revision)}>
          <Icon id="doc" className={s.rowGlyph} />
          <span className={s.rowMain}>
            <span className={s.rowTitle}>{r.revision === done[0].revision ? lifecycleLabel('completed') : C.corrected}</span>
            <span className={s.rowSub}>{[long(r.acceptedAt), personName(r.acceptedBy)].filter(Boolean).join(' · ')}</span>
          </span>
          <Icon id="chevron" className={s.chev} />
        </button>
      ))}
    </>
  )
}
