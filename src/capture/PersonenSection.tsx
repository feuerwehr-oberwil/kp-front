// «Personen» on the capture page: the roster (and its guests) with the four-state tap cycle,
// the current presence block's von/bis, and the Gast door. State lives in CaptureApp.

import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { SearchField } from '../components/SearchField'
import { InfoToggle } from '../components/InfoToggle'
import { DateTimeField } from '../components/TimeField'
import { keepEndAfterStart, keepStartBeforeEnd } from '../lib/abschluss'
import { intervalsOf, isPresent } from '../lib/attendanceIntervals'
import { ortOf } from '../lib/attendanceOrt'
import type { AttendanceEntry } from '../types'
import type { Workspace } from '../lib/incidents'
import type { CaptureAction, CapturePerson } from '../lib/captureClient'
import { AccSection } from './AccSection'

/**
 * Where a corrected «von»/«bis» on a person's row lands: the instant the picker showed, kept as
 * the operator's answer — only the ordering guard survives it, so a presence block can never end
 * before it starts (a reversed block renders as nothing and counts zero minutes on the Rapport,
 * and the poster has no sheet that would show it). The guard steps the DAY, and the field then
 * shows the date it stepped to.
 */
const personTimeIso = (iso: string, edge: 'from' | 'to', block: { from?: string; to?: string }): string => {
  if (edge === 'to') return block.from ? keepEndAfterStart(block.from, iso) : iso
  return block.to ? keepStartBeforeEnd(iso, block.to) : iso
}

/** the shell's wiring for one section (CaptureApp owns which one is open) */
type Shell = { open: boolean; onToggle: () => void; sectionRef: (el: HTMLElement | null) => void }

type Props = Shell & {
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
  open, onToggle, sectionRef, zeitDays, busy, attendance, rosterIds, filteredRoster, presentCount,
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
                <DateTimeField
                  className="cv-person-time"
                  ariaLabel={here ? C.von : C.bis}
                  value={here ? cur?.from : cur?.to}
                  disabled={busy} required
                  // the Einsatz' own days, exactly like the Zeiten grid below: the field shows
                  // the date it stores, like the tablet's Anwesenheit sheet (TimeBlockSheet)
                  days={zeitDays}
                  onCommit={(picked) => {
                    if (!picked) return
                    const iso = personTimeIso(picked, here ? 'from' : 'to', { from: cur?.from, to: cur?.to })
                    const patch = here ? { from: iso } : { to: iso }
                    void run({ kind: 'setTimes', personId: p.id, index: bi, ...patch }).then((ok) => { if (ok) savedToast() })
                  }}
                />
              )}
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
