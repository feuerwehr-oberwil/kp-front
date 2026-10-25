// «Personen» on the capture page: the roster (and its guests) with the four-state tap cycle,
// the current presence block's von/bis, and the Gast door. State lives in CaptureApp.

import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm, localeDate } from '../lib/format'
import { Icon } from '../lib/icons'
import { SearchField } from '../components/SearchField'
import { InfoToggle } from '../components/InfoToggle'
import { TimeField } from '../components/TimeField'
import { applyTimeToIso, isoOnDay, keepEndAfterStart, keepStartBeforeEnd } from '../lib/abschluss'
import { intervalsOf, isPresent } from '../lib/attendanceIntervals'
import { ortOf } from '../lib/attendanceOrt'
import type { AttendanceEntry } from '../types'
import type { IncidentMeta, Workspace } from '../lib/incidents'
import type { CaptureAction, CapturePerson } from '../lib/captureClient'
import { AccSection } from './AccSection'

/**
 * Where a corrected «von»/«bis» on a person's row lands.
 *
 * A day picked off the wheel is the operator's ANSWER and is kept as such — only the ordering
 * guard survives it, so a presence block can never end before it starts (a reversed block
 * renders as nothing and counts zero minutes on the Rapport). Without a day nothing changes:
 * the day is inferred from the neighbouring stamp, the same rule the Anwesenheit view applies,
 * so the two surfaces cannot drift.
 */
const personTimeIso = (
  clock: string, day: Date | undefined, edge: 'from' | 'to',
  block: { from?: string; to?: string }, baseIso: string,
): string | null => {
  if (!day) {
    return edge === 'to'
      ? applyTimeToIso(block.to ?? baseIso, clock, { nextDayIfBefore: block.from })
      : applyTimeToIso(baseIso, clock, { prevDayIfAfter: block.to })
  }
  const iso = isoOnDay(day, clock)
  if (!iso) return null
  if (edge === 'to') return block.from ? keepEndAfterStart(block.from, iso) : iso
  return block.to ? keepStartBeforeEnd(iso, block.to) : iso
}

/** The calendar day of a recorded time — but ONLY when it is not the Einsatz' own start day.
 *  An Einsatz that ends the same evening (nearly all of them) reads as a bare clock exactly as
 *  before; one that runs past midnight says which day a «bis 01:15» belongs to. */
const dayTag = (iso: string | undefined, baseIso: string): string | null => {
  if (!iso) return null
  const d = new Date(iso)
  const base = new Date(baseIso)
  if (!Number.isFinite(d.getTime()) || !Number.isFinite(base.getTime())) return null
  if (d.toDateString() === base.toDateString()) return null
  return localeDate(d, { day: '2-digit', month: '2-digit' })
}

/** the shell's wiring for one section (CaptureApp owns which one is open) */
type Shell = { open: boolean; onToggle: () => void; sectionRef: (el: HTMLElement | null) => void }

type Props = Shell & {
  incident: IncidentMeta
  /** the Einsatz' own days, for a clock that may fall on another one (CaptureApp · zeitDays) */
  zeitDays: Date[]
  busy: boolean
  attendance: Record<string, AttendanceEntry>
  rosterIds: ReadonlySet<string>
  filteredRoster: CapturePerson[]
  presentCount: number
  recordedCount: number
  search: string
  setSearch: (v: string) => void
  onlyRecorded: boolean
  setOnlyRecorded: Dispatch<SetStateAction<boolean>>
  showTapHelp: boolean
  setShowTapHelp: Dispatch<SetStateAction<boolean>>
  /** the typed name, offered as a Gast while nobody listed answers it ('' = no offer) */
  guestOffer: string
  tapPerson: (p: CapturePerson) => Promise<void>
  addGuest: (name: string) => Promise<void>
  run: (action: CaptureAction) => Promise<Workspace | null>
  savedToast: () => void
}

/** The Personen section: search · «Erfasste» filter · tap help, then one row per person. */
export function PersonenSection({
  open, onToggle, sectionRef, incident, zeitDays, busy, attendance, rosterIds, filteredRoster, presentCount,
  recordedCount, search, setSearch, onlyRecorded, setOnlyRecorded, showTapHelp, setShowTapHelp, guestOffer,
  tapPerson, addGuest, run, savedToast,
}: Props) {
  const C = appConfig.copy.capture
  const A = appConfig.copy.anwesenheit
  return (
    <AccSection open={open} label={C.sectionPersonen} sub={fillTemplate(C.presentCount, { n: presentCount })} onToggle={onToggle}
      step="anwesenheit" sectionRef={sectionRef}>
      <div className="cv-search-row cv-sticky-search">
        <SearchField className="cv-search" placeholder={C.searchName} aria-label={C.searchName} value={search} onChange={setSearch}
          autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="search" />
        {/* «Erfasste N» — the check-back filter. Only once there IS something to check
            back on: on an untouched roster it would filter to an empty list, and a
            control that can only produce nothing is a trap on a phone at a door.
            ⚠️ …but it must also stay while it is ON, even at zero. The fourth tap on a
            row DELETES that person's entry, so filtering down to the last recorded
            person and tapping them once more took the count to 0 — and a toggle that
            unmounts while still filtering leaves an empty roster with nothing on screen
            to switch it off again. */}
        {(recordedCount > 0 || onlyRecorded) && (
          <button type="button" className={`cv-filter${onlyRecorded ? ' on' : ''}`}
            aria-pressed={onlyRecorded} onClick={() => setOnlyRecorded((v) => !v)}>
            <Icon id="check" />
            <span>{fillTemplate(C.filterRecorded, { n: recordedCount })}</span>
          </button>
        )}
        <InfoToggle open={showTapHelp} onToggle={() => setShowTapHelp((v) => !v)} label={C.tapHelp} />
      </div>
      {showTapHelp && <p className="cv-hint">{C.tapHint}</p>}
      <div className="cv-people">
        {filteredRoster.map((p) => {
          const a = attendance[p.id]
          const here = isPresent(a)
          // ⚠️ THREE visible states, not two: «anwesend» alone was the half-truth this
          // feature exists to end — somebody who has scanned the poster in the Magazin
          // has not left the building yet, and the command post needs to see exactly
          // that. The row therefore shows Magazin and Vor Ort as different states.
          const atStation = here && ortOf(a) === 'station'
          const state = a ? (here ? (atStation ? 'station' : 'on') : 'left') : ''
          const stateLabel = !a ? '' : !here ? C.stateLeft : atStation ? A.ortStation : A.ortScene
          // the poster edits the CURRENT presence block (it keeps the narrow four-step
          // cycle; returns are ticked on the tablet, which has the Zeitplan for them)
          const blocks = intervalsOf(a)
          const bi = blocks.length - 1
          const cur = blocks[bi]
          const vonBase = cur?.from ?? incident.started_at
          return (
            <div key={p.id} className="cv-person-row">
              <button className={`cv-person ${state}`} disabled={busy}
                onClick={() => void tapPerson(p)}>
                <span className="cv-person-name">{p.display_name}</span>
                {/* a row with no Mannschaftsliste behind it SAYS so — the same word the
                    tablet's pickers put on the same person (anwesenheit.guestBadge), so
                    nobody wonders later why this name is in no export */}
                {!rosterIds.has(p.id) && <span className="cv-person-guest">{A.guestBadge}</span>}
                {/* state as a glyph chip — the pin and the Magazin are the same two
                    glyphs the tablet's Anwesenheit uses, so the poster and the KP say
                    the same thing the same way. The word rides as the aria-label. */}
                {a && (
                  <span className="cv-person-state" role="img" aria-label={stateLabel}>
                    <Icon id={!here ? 'arrow' : atStation ? 'station' : 'pin'} />
                  </span>
                )}
              </button>
              {/* ONE inline time, same model as the Anwesenheit view: arrival while
                  anwesend, leave time once gegangen — the flipping meaning is SAID
                  with a von/bis tag, not implied (feedback 2026-07-18) */}
              {a && <span className="cv-time-tag">{here ? C.von : C.bis}</span>}
              {a && (
                <TimeField
                  className="cv-person-time"
                  ariaLabel={here ? C.von : C.bis}
                  value={hhmm(here ? cur?.from : cur?.to)}
                  disabled={busy}
                  // the Einsatz' own days, exactly like the Zeiten grid below. The poster
                  // is filled in hours later and an Einsatz that ran past midnight has two
                  // of them — «bis 01:15» was silently filed on the wrong one, because a
                  // bare clock can only be inferred from the neighbouring stamp.
                  days={zeitDays}
                  // …and the wheel opens on the day this stamp is ON (see TimeField ·
                  // valueDay). Without it the day wheel starts at today, and a correction
                  // made the morning after would move the block to the morning after.
                  valueDay={(() => {
                    const iso = here ? cur?.from : cur?.to
                    return iso ? new Date(iso) : undefined
                  })()}
                  onCommit={(hhmm, day) => {
                    if (!hhmm) return
                    const iso = personTimeIso(hhmm, day, here ? 'from' : 'to',
                      { from: cur?.from, to: cur?.to }, vonBase)
                    if (!iso) return
                    const patch = here ? { from: iso } : { to: iso }
                    void run({ kind: 'setTimes', personId: p.id, index: bi, ...patch }).then((ok) => { if (ok) savedToast() })
                  }}
                />
              )}
              {/* the day, and ONLY when it is not the Einsatz' own — see dayTag. On the
                  ordinary same-evening Einsatz the row looks exactly as it did. */}
              {a && (() => {
                const tag = dayTag(here ? cur?.from : cur?.to, incident.started_at)
                return tag ? <span className="cv-date-tag">{tag}</span> : null
              })()}
            </div>
          )
        })}
        {/* THE GAST DOOR, last under the hits and only while something is typed — the
            same row, in the same place, with the same words as on the Trupp form. It
            carries the typed name itself, so it says what the tap will do instead of
            opening a second field to ask for the name again. */}
        {guestOffer && (
          <button type="button" className="cv-btn cv-btn-add" disabled={busy}
            onClick={() => { void addGuest(guestOffer) }}>
            <Icon id="type" />
            <span>{fillTemplate(A.addGuest, { name: guestOffer })}</span>
          </button>
        )}
      </div>
    </AccSection>
  )
}
