import { appConfig } from '../config/appConfig'
import { truppCrewWithout, truppLogName } from '../lib/atemschutz'
import { fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { doubleAssignments, rosterIdByName, truppCrewSlots } from '../lib/personnel'
import type { Person, Trupp } from '../types'
import { cx } from '../lib/cx'
import s from './Atemschutz.module.css'

/**
 * «Müller Hans in 2 Trupps» — one band per person above the board's sections (audit F05,
 * 25.10.2026; owner pick B over a note on each card or a top-bar chip, gallery 26.10.).
 *
 * Only a sync can produce this: the Trupp form refuses a double assignment on one device, but two
 * offline devices can each make one half, and the merge keeps both (lib/personnel ·
 * doubleAssignments). Both crews stay monitored — the band picks nothing. After the radio check a
 * tap on «Bleibt in …» takes the person out of the other crew(s) (useTruppActions ·
 * keepInOneTrupp: one Verlauf row, undoable). A choice that would leave a crew without anybody is
 * not offered; a viewer sees the band without the buttons. The affected cards wear `.cardConflict`.
 * The band is THE amber form warning (`.form-warn-amber`, its choices `.form-warn-act`; style
 * sweep T3, 15.11.2026 – it had a border and buttons of its own).
 */
export function DoubleAssignmentBanner({ trupps, personnel, onKeep }: {
  trupps: Trupp[]
  personnel: Person[]
  /** absent for a viewer / a closed Einsatz */
  onKeep?: (keepTruppId: string, personId: string) => void
}) {
  const az = appConfig.copy.atemschutz
  const conflicts = doubleAssignments(trupps)
  if (!conflicts.length) return null
  const byId = new Map(trupps.map((t) => [t.id, t]))
  // the crews as the roster reads them — `memberPersonIds` is stored compacted, so a position is
  // no answer to «whose name is this» (atemschutz · truppCrewWithout)
  const byName = rosterIdByName(personnel)
  const roster = new Map(personnel.map((p) => [p.id, p]))
  const slotsOf = (t: Trupp) => truppCrewSlots(t, byName, roster)
  return conflicts.map(({ personId, truppIds }) => {
    const held = truppIds.flatMap((id) => byId.get(id) ?? [])
    const person = roster.get(personId)?.displayName
      || slotsOf(held[0]).find((sl) => sl.personId === personId)?.name.trim() || az.assignedFallbackName
    return (
      <div key={personId} className={cx('form-warn form-warn-amber', s.dupBanner)} role="alert">
        <Icon id="warn" />
        <span className="form-warn-text">
          {fillTemplate(az.doubleTitle, { person, n: held.length })}
          <span className={s.dupText}>{fillTemplate(az.doubleText, { person })}</span>
        </span>
        {onKeep && (
          <span className={s.dupActs}>
            {held.map((keep) => (
              <button key={keep.id} type="button" className="form-warn-act" onClick={() => onKeep(keep.id, personId)}
                disabled={held.some((t) => t !== keep && !truppCrewWithout(t, personId, slotsOf(t)))}>
                {fillTemplate(az.doubleKeep, { trupp: truppLogName(keep, 'leader') })}
              </button>
            ))}
          </span>
        )}
      </div>
    )
  })
}

