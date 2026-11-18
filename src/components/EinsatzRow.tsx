import type { ReactNode } from 'react'
import { ListRow } from './ListRow'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { shortAddress } from '../lib/deploymentConfig'

// THE row of an Einsatz in a list (duck sweep LISTS.2, 17.11.2026). An Einsatz was drawn four
// ways – the Einsatz menu, «Alle Einsätze», the Meldeleiste and the standing link's chooser – and
// «Alle Einsätze» had lost the red Atemschutz word the menu shows, so the one Einsatz with an
// overdue Trupp looked calm there. One anatomy now, the menu's (AppMenuRows · `.ip-menu-row`
// keeps its own dense container but reads the same pieces in the same order):
//
//   name  [ÜBUNG] [ABGESCHLOSSEN]        ← the tags BESIDE the name: a long name ellipsises,
//   Schlossgasse 9                          the word «Übung» must not be what gets cut off
//   Mo., 16.11. · seit 23:58 · 42 min    ← `when`, the caller's (a list of any age needs the day)
//   ⚠ Atemschutz-Alarm                   ← lib/foreignAlarm · foreignMark, red, under the place
//
// The place is `shortAddress` – THE short form (the own Gemeinde left off), «ohne Ort» without
// one. A `ListRow`, so › says the tap opens the Einsatz.

/** What the row reads from an Einsatz – an `IncidentMeta`, or the standing link's candidate. */
export interface EinsatzRowFacts {
  title: string
  address: string | null
  is_exercise: boolean
  is_archived?: boolean
}

/** The hatched «Übung» tag – the one Übung mark (13-incident · `.ip-badge-exercise`). */
export const ExerciseTag = () => <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>

export function EinsatzRow({ incident: i, when, alarm, onClick, disabled, className }: {
  incident: EinsatzRowFacts
  /** the time line under the place – «Mo., 16.11. · seit 23:58 · 42 min», «10:42» */
  when?: ReactNode
  /** the red Atemschutz word (lib/foreignAlarm · foreignMark); null when nothing is at the alarm tier */
  alarm?: { word: string; names: string } | null
  onClick: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <ListRow className={className} onClick={onClick} disabled={disabled}
      title={(
        <span className="einsatz-row-title">
          <span className="einsatz-row-name" title={i.title}>{i.title}</span>
          {i.is_exercise && <ExerciseTag />}
          {i.is_archived && <span className="ip-badge ip-badge-arch">{appConfig.copy.history.statusArchived}</span>}
        </span>
      )}
      sub={shortAddress(i.address) ?? appConfig.copy.history.noLocation}>
      {when && <span className="list-row-sub einsatz-row-when">{when}</span>}
      {alarm && <span className="einsatz-row-alarm" title={alarm.names}><Icon id="warn" />{alarm.word}</span>}
    </ListRow>
  )
}
