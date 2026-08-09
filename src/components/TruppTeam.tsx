import { useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { fillTemplate, stripUnprintable } from '../lib/format'
import { rankAbbr, rankLabel, rankOrder } from '../lib/rank'
import type { Person } from '../types'
import type { Slot } from './PersonField'
import s from './Atemschutz.module.css'

/**
 * Who is in this Trupp, and which of them leads it.
 *
 * Replaces the fixed «Gruppenführer / AdF 1 / AdF 2» slot stack (2026-08-09, after the 08.08.
 * Einsatz). Three separate dropdowns could NAME a Trupp but not re-arrange one: whoever was typed
 * into the first slot was the Gruppenführer forever, so a mis-tap meant clearing three fields and
 * starting again — at the one moment nobody has a spare thirty seconds. And there was no way to
 * find anybody: each dropdown was a scroll list of the whole Mannschaft with no search.
 *
 * So: ONE list you tick, and one tap that says who leads. The order is the record —
 * `value[0]` IS the Gruppenführer — which is also the order the card, the Rapport and the map tag
 * print, so «who leads» is never stored twice and cannot disagree with itself.
 */
export function TruppTeam({
  value, onChange, personnel, legacyRoster, presentIds, assignedIds, rolesById,
}: {
  /** the Trupp, in printed order — `value[0]` is the Gruppenführer */
  value: Slot[]
  onChange: (next: Slot[]) => void
  personnel: Person[]
  /** names off older Trupps, used when no roster synced (Divera outage) */
  legacyRoster: string[]
  presentIds: Set<string>
  /** ids in another ACTIVE Trupp — shown, greyed, and not selectable (one person, one Trupp) */
  assignedIds: Set<string>
  /** the job somebody already holds on this Einsatz (Anwesenheits-Bemerkung) — a soft note */
  rolesById?: Map<string, string>
}) {
  const az = appConfig.copy.atemschutz
  const [q, setQ] = useState('')
  // the guest / Nachbarwehr path — the ONE place a keyboard opens on this surface
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')
  const typedRef = useRef<HTMLInputElement>(null)

  const chosenIds = new Set(value.map((v) => v.personId).filter(Boolean) as string[])
  const chosenNames = new Set(value.map((v) => v.name.trim()).filter(Boolean))

  type Opt = { key: string; name: string; personId?: string; present: boolean; rank?: string; role?: string; taken: boolean }
  const options: Opt[] = useMemo(() => {
    if (personnel.length) {
      return personnel
        .filter((p) => p.active && !chosenIds.has(p.id) && !chosenNames.has(p.displayName))
        .map((p) => ({
          key: p.id, name: p.displayName, personId: p.id, present: presentIds.has(p.id),
          rank: p.rank, role: rolesById?.get(p.id), taken: assignedIds.has(p.id),
        }))
        // present first, then by seniority, then alphabetical — the same order every other
        // picker in the app uses, so a name sits where the hand already expects it. Somebody
        // already in another Trupp sinks to the bottom: they are shown, never hunted for.
        .sort((a, b) =>
          Number(a.taken) - Number(b.taken)
          || Number(b.present) - Number(a.present)
          || rankOrder(a.rank) - rankOrder(b.rank)
          || a.name.localeCompare(b.name, 'de'))
    }
    return legacyRoster.filter((n) => !chosenNames.has(n))
      .map((n) => ({ key: n, name: n, present: false, taken: false }))
    // chosenIds/chosenNames are rebuilt from `value` on every render; `value` is the real input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personnel, legacyRoster, presentIds, assignedIds, rolesById, value])

  const needle = q.trim().toLowerCase()
  const filtered = needle ? options.filter((o) => o.name.toLowerCase().includes(needle)) : options

  // Adding the FIRST person makes them Gruppenführer, because the overwhelmingly common case is
  // that the Trupp is entered leader-first. Nothing is locked by it — the crown moves with a tap.
  const add = (slot: Slot) => { onChange([...value, slot]); setQ('') }
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i))
  /** crown: the chosen person moves to the front, everyone else keeps their order */
  const promote = (i: number) => onChange([value[i], ...value.filter((_, j) => j !== i)])

  const submitTyped = () => {
    const name = typed.trim()
    if (!name) return
    add({ name })
    setTyped('')
    setTyping(false)
  }

  return (
    <div className={s.team}>
      {/* THE TRUPP — first, because it is the answer; the Mannschaft below it is the way to it. */}
      {value.length === 0 ? (
        <p className={s.teamEmpty}>{az.teamEmpty}</p>
      ) : (
        <ul className={s.teamChosen}>
          {value.map((m, i) => (
            <li key={`${m.personId ?? m.name}-${i}`} className={cx(s.teamRow, i === 0 && s.teamRowLead)}>
              {/* The crown is a RADIO in behaviour: exactly one Gruppenführer, always. On the
                  leader it is pressed and inert — tapping «make this one the leader» on the
                  leader has no meaning, and an enabled button that does nothing teaches that
                  taps here sometimes fail. */}
              <button
                type="button"
                className={cx(s.teamCrown, i === 0 && s.teamCrownOn)}
                aria-pressed={i === 0}
                disabled={i === 0}
                title={i === 0 ? az.leaderLabel : fillTemplate(az.makeLeader, { name: m.name })}
                aria-label={i === 0 ? az.leaderLabel : fillTemplate(az.makeLeader, { name: m.name })}
                onClick={() => promote(i)}
              >
                <Icon id="star" />
              </button>
              <span className={s.teamName}>{m.name}</span>
              {i === 0 && <span className={s.teamBadge}>{az.leaderBadge}</span>}
              {/* a typed name carries no roster link — say so, so nobody wonders later why this
                  one person never appeared in the statistics export */}
              {!m.personId && <span className={s.comboHint}>{az.teamManual}</span>}
              <button
                type="button" className={s.slotRemove}
                title={fillTemplate(az.teamRemove, { name: m.name })}
                aria-label={fillTemplate(az.teamRemove, { name: m.name })}
                onClick={() => remove(i)}
              ><Icon id="close" /></button>
            </li>
          ))}
        </ul>
      )}

      {/* THE MANNSCHAFT. A search box rather than a scroll list: on a 66-person roster the old
          dropdown was the surface people complained about first. */}
      <label className={s.teamSearch}>
        <Icon id="search" />
        <input
          value={q} onChange={(e) => setQ(e.target.value)} inputMode="search"
          placeholder={az.teamSearchPlaceholder} aria-label={az.teamSearchPlaceholder}
        />
        {q && (
          <button type="button" className={s.teamSearchClear} onClick={() => setQ('')}
            aria-label={appConfig.copy.anwesenheit.clearSearch}><Icon id="close" /></button>
        )}
      </label>

      <ul className={s.teamList} role="listbox" aria-label={az.sectionTeam}>
        {filtered.map((o) => (
          <li key={o.key}>
            <button
              type="button" className={cx(s.comboOpt, o.taken && s.teamOptTaken)}
              role="option" aria-selected={false} disabled={o.taken}
              onClick={() => add({ name: o.name, personId: o.personId })}
            >
              {o.personId && <span className={cx(s.comboDot, o.present ? s.comboDotPresent : s.comboDotOff)} />}
              {o.rank && <span className={s.comboRank} title={rankLabel(o.rank)}>{rankAbbr(o.rank)}</span>}
              <span className={s.comboName}>{o.name}</span>
              {/* one note per row, most important first: already in a Trupp beats a Funktion,
                  which beats «nicht anwesend» — somebody with a job IS here */}
              {o.taken
                ? <span className={s.comboHint}>{az.teamTaken}</span>
                : o.role
                  ? <span className={s.comboHint}>{fillTemplate(appConfig.copy.anwesenheit.alreadyBooked, { role: o.role })}</span>
                  : o.personId && !o.present && <span className={s.comboHint}>{az.notPresent}</span>}
            </button>
          </li>
        ))}
        {!filtered.length && <li className={s.comboEmpty}>{needle ? az.teamNoMatches : az.noRoster}</li>}
      </ul>

      {/* Guests / Nachbarwehr / an AdF whose roster row never synced. Same escape hatch the slot
          picker had, in the same words — it is the one control here that opens a keyboard. */}
      {typing ? (
        <div className={s.teamTypeRow}>
          <input
            ref={typedRef} autoFocus className={s.teamTypeInput} value={typed} maxLength={40}
            placeholder={az.memberPlaceholder} aria-label={az.typeName}
            onChange={(e) => setTyped(stripUnprintable(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitTyped() }
              else if (e.key === 'Escape') { setTyped(''); setTyping(false) }
            }}
          />
          <button type="button" className="ip-btn" disabled={!typed.trim()} onClick={submitTyped}>{az.teamAdd}</button>
          <button type="button" className={s.slotRemove} aria-label={az.cancel} title={az.cancel}
            onClick={() => { setTyped(''); setTyping(false) }}><Icon id="close" /></button>
        </div>
      ) : (
        <button type="button" className={s.linkBtn} onClick={() => setTyping(true)}>
          <Icon id="type" /><span>{az.teamTypeName}</span>
        </button>
      )}
    </div>
  )
}
