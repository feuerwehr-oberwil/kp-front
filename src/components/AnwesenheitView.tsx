import { useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import type { AttendanceState, Person } from '../types'
import { cx } from '../lib/cx'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { applyTimeToIso } from '../lib/abschluss'
import { rankAbbr, rankLabel, rankOrder } from '../lib/rank'
import { CaptureUsageChip, type CaptureUsage } from './CaptureUsageChip'
import { Segmented } from './Segmented'
import { EmptyState } from './EmptyState'
import s from './Anwesenheit.module.css'

/** sentinel value for the «Alle» segment of the rank filter (no real rank uses it) */
const RANK_ALL = '__all__'

// HH:MM of an ISO stamp — the tappable time chip / the <input type="time"> value
function toHM(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// The Anwesenheit surface: one unified, compact grid of the whole Mannschaft. Each name is a
// button whose tap cycles its state — frei → anwesend → gegangen → frei — so a single view
// both shows and edits attendance with no mode switching (3am tenet: recognition over recall).
// A member in an active Atemschutz-Trupp is locked: tapping jumps to the Trupp instead of
// marking them gone (the checkout rule). Order is stable alphabetical so chips don't reflow
// under your finger while you tap.
export function AnwesenheitView({
  people, attendance, canEdit, loading, error, blockedIds,
  onMarkPresent, onMarkLeft, onClear, onJumpToTrupp, onReload, onSetTimes, captureUsage,
}: {
  people: Person[]
  attendance: AttendanceState
  canEdit: boolean
  loading: boolean
  error: boolean
  /** person ids assigned to an active Trupp — locked against "Gegangen" until released */
  blockedIds: Set<string>
  onMarkPresent: (p: Person) => void
  onMarkLeft: (p: Person) => void
  onClear: (p: Person) => void
  onJumpToTrupp: () => void
  onReload: () => void
  /** correct a wrong auto-stamped time via the row's time chip (e.g. "gegangen" marked
   *  after the person already left) — same handler as the Rapport Stunden editor */
  onSetTimes?: (personId: string, patch: { checkedInAt?: string; leftAt?: string }) => void
  /** QR self-reporting in use — «QR: N Einträge · zuletzt HH:MM» chip (informational) */
  captureUsage?: CaptureUsage | null
}) {
  const [q, setQ] = useState('')
  const [rankFilter, setRankFilter] = useState<string | null>(null)
  // person whose time chip is open as an inline <input type="time">
  const [editing, setEditing] = useState<string | null>(null)
  const A = appConfig.copy.anwesenheit

  // Distinct ranks present in the roster, most senior first — drives the quick-filter chips.
  // Only shown when at least one member carries a rank (else the row is noise).
  const ranksPresent = useMemo(() => {
    const keys = [...new Set(people.map((p) => p.rank).filter((r): r is string => !!r))]
    return keys.sort((a, b) => rankOrder(a) - rankOrder(b))
  }, [people])

  const counts = useMemo(() => {
    let present = 0
    let left = 0
    for (const a of Object.values(attendance)) {
      if (a.status === 'present') present++
      else if (a.status === 'left') left++
    }
    return { present, left, total: people.length }
  }, [attendance, people])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return people
      .filter((p) => !needle || p.displayName.toLowerCase().includes(needle))
      .filter((p) => !rankFilter || p.rank === rankFilter)
      // grouped by seniority (most senior first), alpha within a rank
      .sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || a.displayName.localeCompare(b.displayName, 'de'))
  }, [people, q, rankFilter])

  // frei → anwesend → gegangen → frei. A present+locked member jumps to the Trupp instead.
  const cycle = (p: Person) => {
    const status = attendance[p.id]?.status
    if (status === 'present') {
      if (blockedIds.has(p.id)) { onJumpToTrupp(); return }
      onMarkLeft(p)
    } else if (status === 'left') {
      onClear(p)
    } else {
      onMarkPresent(p)
    }
  }

  const empty = !people.length

  return (
    <div className={s.surface}>
      <header className={s.head}>
        <div className={s.headTitles}>
          <h2>{A.title}</h2>
          <p>{fillTemplate(A.summary, { present: counts.present, left: counts.left, total: counts.total })}</p>
        </div>
        <div className={s.headActions}>
          <CaptureUsageChip usage={captureUsage} />
          <button className={s.reload} onClick={onReload} disabled={loading} aria-label={A.reload}>
            <Icon id="rotate" /><span className={s.reloadLabel}>{loading ? A.loading : A.refresh}</span>
          </button>
        </div>
      </header>

      {!empty && (
        <div className={s.controls}>
          <label className={s.search}>
            <Icon id="search" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={A.searchPlaceholder} inputMode="search" />
            {q && <button className={s.searchClear} onClick={() => setQ('')} aria-label={A.clearSearch}><Icon id="close" /></button>}
          </label>
          <div className={s.legend} aria-hidden>
            <span><i className={s.dotFrei} />{A.legendFrei}</span>
            <span><i className={s.dotPresent} />{A.legendPresent}</span>
            <span><i className={s.dotLeft} />{A.legendLeft}</span>
          </div>
        </div>
      )}

      {!empty && ranksPresent.length > 1 && (
        <div className={s.rankRow}>
          {/* rank filter — the shared <Segmented>; «Alle» (sentinel) clears the filter, and re-tapping
              the active rank clears it too (parent decides the toggle-off). */}
          <Segmented<string> ariaLabel={A.rankFilterLabel} value={rankFilter ?? RANK_ALL}
            onChange={(v) => setRankFilter(v === RANK_ALL || v === rankFilter ? null : v)}
            options={[
              { value: RANK_ALL, label: A.rankAll },
              ...ranksPresent.map((r) => ({ value: r, label: rankAbbr(r) || rankLabel(r), title: rankLabel(r) })),
            ]} />
        </div>
      )}

      {empty ? (
        <EmptyState className="empty-fill" icon={error ? 'warn' : 'people'}
          title={error ? A.loadFailedTitle : A.emptyTitle} sub={error ? A.loadFailedHint : A.emptyHint}
          action={<button type="button" className="ip-btn" onClick={onReload} disabled={loading}><Icon id="rotate" /> {A.retry}</button>} />
      ) : !rows.length ? (
        <div className="ip-ac-note ip-ac-note-center">{A.noMatches}</div>
      ) : (
        <div className={s.grid}>
          {rows.map((p) => {
            const a = attendance[p.id]
            const present = a?.status === 'present'
            const left = a?.status === 'left'
            const locked = present && blockedIds.has(p.id)
            // the time this row shows: arrival while anwesend, departure once gegangen —
            // tap the chip to correct a wrong auto-stamped time in place
            const timeIso = left ? a?.leftAt : present ? a?.checkedInAt : undefined
            return (
              <div key={p.id} className={cx(s.person, present && s.isPresent, left && s.isLeft)}>
                <button
                  type="button"
                  className={s.personMain}
                  disabled={!canEdit}
                  onClick={() => cycle(p)}
                  title={locked ? A.lockedTitle : !p.active ? A.notInDivera : undefined}
                >
                  <span className={cx(s.dot, present && s.dotPresent, left && s.dotLeft, !present && !left && s.dotFrei)} />
                  {p.rank && <span className={s.rank} title={rankLabel(p.rank)}>{rankAbbr(p.rank)}</span>}
                  <span className={s.name}>{p.displayName}</span>
                  {locked && <Icon id="gauge" />}
                </button>
                {timeIso && (editing === p.id && onSetTimes ? (
                  <input
                    type="time"
                    className={s.timeInput}
                    autoFocus
                    value={toHM(timeIso)}
                    aria-label={A.editTime}
                    onChange={(e) => {
                      const iso = e.target.value
                        ? applyTimeToIso(timeIso, e.target.value, left ? { nextDayIfBefore: a?.checkedInAt } : undefined)
                        : null
                      if (iso) onSetTimes(p.id, left ? { leftAt: iso } : { checkedInAt: iso })
                    }}
                    onBlur={() => setEditing(null)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <button
                    type="button"
                    className={cx(s.timeChip, left && s.timeChipLeft)}
                    disabled={!canEdit || !onSetTimes}
                    title={A.editTime}
                    aria-label={`${A.editTime} – ${p.displayName}`}
                    onClick={() => setEditing(p.id)}
                  >
                    {left ? `${A.weg} ${toHM(timeIso)}` : toHM(timeIso)}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
