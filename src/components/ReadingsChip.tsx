import { useEffect, useMemo, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { useOnlyOpenCard } from '../lib/floatCards'
import { useMinuteClock } from '../lib/minuteClock'
import { worstFirst, type MeasuredPoint } from '../lib/readingsList'
import { ReadingPill } from '../lib/symbolRender'
import s from './ReadingsChip.module.css'

/**
 * «Messungen» in the floating chip row – the Karte's and every plan's (owner, 27.10.2026). The chip
 * wears the worst reading; a tap opens EVERY Messpunkt of the Einsatz as one list, worst first, the
 * place as a tag (pick L2: no groups). A row goes to its point – the sheet it was placed on, else
 * the Karte – and closes the list. Non-modal like the Gebäude-Info beside it: Esc or the chip close it.
 * Rendered only once a Messpunkt exists (`points` non-empty).
 */
export function ReadingsChip({ points, compact = false, onGo }: {
  points: MeasuredPoint[]
  /** a phone: the pill alone, its words in aria-label/title */
  compact?: boolean
  onGo: (p: MeasuredPoint) => void
}) {
  const [open, setOpen] = useState(false)
  // one chip-row card at a time: opening this list closes the Gebäude card, and vice versa
  useOnlyOpenCard(open, () => setOpen(false))
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  // re-sorted on the minute clock the pills age by, so the chip's pill stays the list's first row
  // when a reading turns stale (measuredPoints sorted them when the Einsatz last changed)
  const now = useMinuteClock()
  const sorted = useMemo(() => worstFirst(points, now), [points, now])
  const worst = sorted[0]
  if (!worst) return null
  const C = appConfig.copy.building
  return (
    <span className={s.anchor}>
      <button type="button" className={cx('wb-scale-chip', open && 'arm')} aria-expanded={open}
        title={C.readingsChipLabel} aria-label={C.readingsChipLabel} onClick={() => setOpen(!open)}>
        {!compact && <span>{C.readingsChip}</span>}
        <ReadingPill props={worst.props} inline />
      </button>
      {open && (
        <div className={s.pop} role="dialog" aria-label={C.readingsChip}>
          {sorted.map((p) => (
            <button key={p.id} type="button" className={s.row} onClick={() => { setOpen(false); onGo(p) }}>
              <ReadingPill props={p.props} inline />
              <span className={s.room}>{p.props.fields?.Raum?.trim() || p.props.label || ''}</span>
              <span className={s.where}>{p.where}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
