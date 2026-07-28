import { useMemo } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from '../lib/format'
import { shiftConflicts } from '../lib/shifts'
import type { Person, Shift } from '../types'
import s from './ShiftConflictNotice.module.css'

/**
 * «Doppelt eingeteilt» — said out loud, with what to do about it.
 *
 * A double booking used to be a red outline plus a 12px sign on a blue bar, and its explanation
 * lived in a `title`. That is two failures at once: on a touch screen a title never appears, and a
 * sign inside a filled bar is the one place a small glyph has the least contrast. So the surface
 * carrying the problem said nothing you could read at arm's length, about the single fault this
 * planning form exists to catch.
 *
 * It is a NOTICE, not a block: the house rule is that a double entry at 3am is a hint to look, not
 * a reason to refuse the plan (see `conflictingShiftIds`). So it names the person and the exact
 * stretch, says which gesture resolves it, and leaves the plan alone. The marks on the bars stay —
 * they are what points at WHERE. This is what says WHAT and WHY.
 */
export function ShiftConflictNotice({ shifts, people, className }: {
  shifts: Shift[]
  /** for the names; anybody missing from the roster is skipped rather than named as an id */
  people: Person[]
  className?: string
}) {
  const Z = appConfig.copy.zeitplan
  const items = useMemo(() => {
    const name = new Map(people.map((p) => [p.id, p.displayName]))
    // one line per PERSON, not per pair: somebody triple-booked produces three pairs, and three
    // lines about one person reads as three problems
    const byPerson = new Map<string, { name: string; from: number; to: number }>()
    for (const c of shiftConflicts(shifts)) {
      const who = name.get(c.personId)
      if (!who) continue
      const cur = byPerson.get(c.personId)
      byPerson.set(c.personId, cur
        ? { name: who, from: Math.min(cur.from, c.from), to: Math.max(cur.to, c.to) }
        : { name: who, from: c.from, to: c.to })
    }
    return [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'))
  }, [shifts, people])

  if (!items.length) return null
  return (
    <div className={`${s.notice}${className ? ` ${className}` : ''}`} role="status">
      <Icon id="warn" />
      <div className={s.body}>
        <b>{items.length === 1 ? Z.conflictTitleOne : fillTemplate(Z.conflictTitleMany, { n: items.length })}</b>
        {/* the exact stretch, because «Meier ist doppelt eingeteilt» still leaves you hunting for
            where on a 96 h axis */}
        <p className={s.who}>
          {items.slice(0, 4).map((c) => (
            <span key={c.name}>{fillTemplate(Z.conflictWho, { name: c.name, from: hhmm(new Date(c.from)), to: hhmm(new Date(c.to)) })}</span>
          ))}
          {items.length > 4 && <span>{fillTemplate(Z.conflictMore, { n: items.length - 4 })}</span>}
        </p>
        <p className={s.fix}>{Z.conflictFix}</p>
      </div>
    </div>
  )
}
