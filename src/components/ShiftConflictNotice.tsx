import { useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from '../lib/format'
import { shiftConflicts } from '../lib/shifts'
import { useIsPhone } from '../lib/useIsPhone'
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
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
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
  const title = items.length === 1 ? Z.conflictTitleOne : fillTemplate(Z.conflictTitleMany, { n: items.length })
  const who = (c: { name: string; from: number; to: number }) =>
    fillTemplate(Z.conflictWho, { name: c.name, from: hhmm(new Date(c.from)), to: hhmm(new Date(c.to)) })

  // On a phone the full notice is three lines — about a quarter of the screen, sitting on top of
  // the very grid you need in order to fix it. Collapsed it is ONE line carrying the load-bearing
  // half (who, and when); the names and the resolving gesture are one tap away. Not hidden: a
  // fault you cannot see is the thing this notice exists to prevent, so the line itself always
  // shows and always says «doppelt eingeteilt».
  const collapsible = isPhone && !open
  return (
    <div className={`${s.notice}${collapsible ? ` ${s.collapsed}` : ''}${className ? ` ${className}` : ''}`} role="status">
      <Icon id="warn" />
      {collapsible ? (
        <button type="button" className={s.summary} onClick={() => setOpen(true)} aria-expanded={false}>
          {/* the NAME is what truncates. «Degen André · 13:00–18…» cut the one thing a clock is
              for; the hours are one tap away, and «doppelt eingeteilt» is the fact that has to
              survive at any width. */}
          <b>{items.length === 1 ? items[0].name : title}</b>
          {items.length === 1 && <span className={s.short}>{Z.conflictShort}</span>}
          <Icon id="chevron-down" />
        </button>
      ) : (
        <div className={s.body}>
          <b>{title}</b>
          {/* the exact stretch, because «Meier ist doppelt eingeteilt» still leaves you hunting for
              where on a 96 h axis */}
          <p className={s.who}>
            {items.slice(0, 4).map((c) => <span key={c.name}>{who(c)}</span>)}
            {items.length > 4 && <span>{fillTemplate(Z.conflictMore, { n: items.length - 4 })}</span>}
          </p>
          <p className={s.fix}>{Z.conflictFix}</p>
        </div>
      )}
    </div>
  )
}
