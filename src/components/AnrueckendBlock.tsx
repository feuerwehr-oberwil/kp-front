import { Fragment, useCallback, useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { fillTemplate, hhmm } from '../lib/format'
import { buildAnrueckend, type AnrueckendRow } from '../lib/diveraResponses'
import { getDiveraResponses, type DiveraResponses } from '../lib/api/divera'
import { useResumingPoll } from '../lib/useResumingPoll'
import type { AttendanceState, Person } from '../types'
import { RankBadge } from './RankBadge'
import { Button } from './Button'
import s from './Anwesenheit.module.css'

/** How often the open block re-reads what the SERVER already has. It never makes the server call
 *  Divera (the server's poll does that, 30 s for the first ten minutes after an alarm — backend ·
 *  divera.RESPONSE_WINDOW_SECONDS), so a faster read here could only re-fetch the same answers. */
export const ANRUECKEND_POLL_MS = 30_000

const clock = (iso: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : hhmm(d)
}

/**
 * «Anrückend» — who answered the Divera alarm, above the Anwesenheit's crew list (X1, 08.10.2026).
 *
 * The question it answers is the first one of every Einsatz: «wer kommt noch, und wann». The
 * answers come from Divera; the people from the Mannschaftsliste (their `divera` identity).
 *
 * ⚠️ Rules this block keeps:
 * - A Divera answer is NEVER presence. Nobody becomes anwesend because they pressed «komme»; the
 *   «da» button on a row is the ordinary check-in (`onMarkPresent`), one tap, by a person here.
 *   Once somebody is recorded they leave this block and stand in the list below.
 * - «kommt nicht» is its own group, muted but readable: ✕ glyph + the word on every row, never a
 *   colour alone (owner on the card: they are most likely not there, unless misclicked — so «da»
 *   is still offered on them).
 * - The arrival time is an ESTIMATE (answer + the minutes the status promises) and reads «ca.».
 * - Nothing to show → nothing rendered: a station without Divera, or an Einsatz no Divera alarm
 *   belongs to, never sees an empty frame.
 *
 * It fetches while it is MOUNTED, and it is mounted only on the crew list of a running Einsatz
 * opened from Divera (AnwesenheitView · diveraResponsesFor) — a closed Einsatz, a replay, a link
 * session and every other tab cost nothing.
 */
export function AnrueckendBlock({ incidentId, people, attendance, canEdit, onMarkPresent, initial }: {
  incidentId: string
  people: Person[]
  attendance: AttendanceState
  canEdit: boolean
  onMarkPresent: (p: Person) => void
  /** test seam: a first answer without the network */
  initial?: DiveraResponses | null
}) {
  const R = appConfig.copy.anrueckend
  const [resp, setResp] = useState<DiveraResponses | null>(initial ?? null)
  const [open, setOpen] = useState(true)

  const refresh = useCallback(async () => {
    // a hidden tab reads nothing; the resume on return catches up (useResumingPoll)
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    setResp(await getDiveraResponses(incidentId))
  }, [incidentId])
  useResumingPoll(initial === undefined, refresh, { pollMs: ANRUECKEND_POLL_MS, resumeGapMs: 10_000 })

  const data = useMemo(() => buildAnrueckend(resp, people, attendance), [resp, people, attendance])
  if (!data) return null

  const { counts } = data
  const answered = counts.coming + counts.not_coming + counts.other
  // the head line: one count per kind, zeros left out — «9 kommen · 2 kommen nicht · 3 da»
  const parts = [
    counts.coming > 0 && R.coming(counts.coming),
    counts.not_coming > 0 && R.notComing(counts.not_coming),
    counts.other > 0 && R.other(counts.other),
    data.here > 0 && R.here(data.here),
  ].filter(Boolean) as string[]
  // each count stays on one line («1 da» never breaks after the number); the line wraps between them
  // (the separator stays OUTSIDE the unbreakable span — inside it, the whole line had no break
  // opportunity left and pushed the block past a phone's edge)
  const summary = answered === 0 ? R.noAnswers : parts.map((t, i) => (
    <Fragment key={t}>{i > 0 ? ' · ' : ''}<span className={s.anrPart}>{t}</span></Fragment>
  ))
  const listed = data.coming.length + data.notComing.length + data.other.length
  const stand = clock(data.updatedAt)

  const row = (r: AnrueckendRow) => {
    const notComing = r.kind === 'not_coming'
    // the WORD leads a «kommt nicht» row's second line (beside the name it cut the name short);
    // the answer time before the free text, which is the part that may run out of room
    const meta = [
      notComing ? R.notComingWord : r.statusName || null,
      r.answeredAt ? fillTemplate(R.answeredAt, { t: clock(r.answeredAt) }) : null,
      r.note || null,
    ].filter(Boolean).join(' · ')
    return (
      <li key={r.person.id} className={cx(s.anrRow, notComing && s.anrNo)}>
        <div className={s.anrWho}>
          {notComing && <Icon id="close" />}
          <RankBadge rank={r.person.rank} />
          <span className={s.name}>{r.person.displayName}</span>
          {r.eta && (
            <span className={s.anrEta} title={R.etaHint}>{fillTemplate(R.eta, { t: clock(r.eta) })}</span>
          )}
        </div>
        {meta && <div className={s.anrMeta}>{meta}</div>}
        {canEdit && (
          <Button
            className={s.anrDa}
            icon={<Icon id="check" />}
            onClick={() => onMarkPresent(r.person)}
            aria-label={fillTemplate(R.checkInLabel, { name: r.person.displayName })}
            title={fillTemplate(R.checkInLabel, { name: r.person.displayName })}
          >
            {R.checkIn}
          </Button>
        )}
      </li>
    )
  }

  return (
    <section className={s.anr} aria-label={R.title}>
      <button type="button" className={s.anrHead} aria-expanded={open} onClick={() => setOpen((v) => !v)}
        title={open ? R.collapse : R.expand}>
        <span className={s.anrTitle}>
          {R.title}
          {data.coming.length > 0 && <span className={s.anrCount}>{data.coming.length}</span>}
        </span>
        <span className={s.anrSummary}>{summary}</span>
        <span className={s.anrSource}>{stand ? fillTemplate(R.source, { t: stand }) : R.sourceBare}</span>
        <Icon id={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open && (
        <div className={s.anrBody}>
          {data.coming.length > 0 && <ul className={s.anrList}>{data.coming.map(row)}</ul>}
          {data.other.length > 0 && (
            <>
              <h3 className={s.anrGroup}>{R.otherGroup}</h3>
              <ul className={s.anrList}>{data.other.map(row)}</ul>
            </>
          )}
          {data.notComing.length > 0 && (
            <>
              <h3 className={cx(s.anrGroup, s.anrGroupNo)}><Icon id="close" />{R.notComingGroup(data.notComing.length)}</h3>
              <ul className={s.anrList}>{data.notComing.map(row)}</ul>
            </>
          )}
          {listed === 0 && answered > 0 && <p className={s.anrFoot}>{R.allHere}</p>}
          {/* the one sentence the block owes: an answer is not a check-in */}
          <p className={s.anrFoot}>
            {data.unmapped > 0 && <>{R.unmapped(data.unmapped)} · </>}
            {R.hint}
          </p>
        </div>
      )}
    </section>
  )
}
