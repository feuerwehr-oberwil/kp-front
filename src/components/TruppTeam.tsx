import { useMemo, useRef, useState } from 'react'
import { caretToEnd } from '../lib/ui'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { fillTemplate, stripUnprintable } from '../lib/format'
import { rankAbbr, rankLabel, rankOrder } from '../lib/rank'
import { matchesQuery, searchQuery } from '../lib/search'
import type { Person } from '../types'
import type { Slot } from './PersonField'
import s from './Atemschutz.module.css'

/** A Trupp is a Gruppenführer and two AdF — three slots, always shown. A bigger Trupp is a real
 *  Trupp and simply grows the box (see the render below); three is what the form should be
 *  ASKING for, and a fourth empty slot on every single Trupp read as one man missing. */
const SLOTS = 3

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
  value, onChange, personnel, legacyRoster, presentIds, stationIds, assignedIds, rolesById, onAddGuest,
}: {
  /** the Trupp, in printed order — `value[0]` is the Gruppenführer */
  value: Slot[]
  onChange: (next: Slot[]) => void
  personnel: Person[]
  /** names off older Trupps, used when no roster synced (Divera outage) */
  legacyRoster: string[]
  presentIds: Set<string>
  /** …of whom these are still at the MAGAZIN. Somebody standing at the Magazin usually cannot
   *  go under PA at all, so the picker says so and sinks them below the crew on scene — a hint
   *  and an ordering, never a block: they may be five minutes out, and the Überwacher decides. */
  stationIds?: Set<string>
  /** ids in another ACTIVE Trupp — shown, greyed, and not selectable (one person, one Trupp) */
  assignedIds: Set<string>
  /** the job somebody already holds on this Einsatz (Anwesenheits-Bemerkung) — a soft note */
  rolesById?: Map<string, string>
  /** record a hand-typed Gast on the Anwesenheit too. Absent for a session that may not write. */
  /** records the Gast on the Anwesenheit and hands back the id it filed them under */
  onAddGuest?: (name: string) => string | undefined
}) {
  const az = appConfig.copy.atemschutz
  const [q, setQ] = useState('')
  // the guest / Nachbarwehr path — the ONE place a keyboard opens on this surface
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')
  const typedRef = useRef<HTMLInputElement>(null)

  const chosenIds = new Set(value.map((v) => v.personId).filter(Boolean) as string[])
  const chosenNames = new Set(value.map((v) => v.name.trim()).filter(Boolean))

  type Opt = { key: string; name: string; personId?: string; present: boolean; atStation: boolean; rank?: string; role?: string; taken: boolean; guest?: boolean }
  const options: Opt[] = useMemo(() => {
    if (personnel.length) {
      return personnel
        .filter((p) => p.active && !chosenIds.has(p.id) && !chosenNames.has(p.displayName))
        .map((p) => ({
          key: p.id, name: p.displayName, personId: p.id, present: presentIds.has(p.id),
          atStation: !!stationIds?.has(p.id),
          rank: p.rank, role: rolesById?.get(p.id), taken: assignedIds.has(p.id),
          // not on the Mannschaftsliste (lib/guests) — offered like anybody else, but SAID
          guest: p.guest,
        }))
        // present first, then by seniority, then alphabetical — the same order every other
        // picker in the app uses, so a name sits where the hand already expects it. Somebody
        // already in another Trupp sinks to the bottom: they are shown, never hunted for.
        .sort((a, b) =>
          Number(a.taken) - Number(b.taken)
          || Number(b.present) - Number(a.present)
          // …and of the people who ARE here, the ones on scene come before the ones still at
          // the Magazin: a Trupp is formed from who is standing in front of you
          || Number(a.atStation) - Number(b.atStation)
          || rankOrder(a.rank) - rankOrder(b.rank)
          || a.name.localeCompare(b.name, 'de'))
    }
    return legacyRoster.filter((n) => !chosenNames.has(n))
      .map((n) => ({ key: n, name: n, present: false, atStation: false, taken: false }))
    // chosenIds/chosenNames are rebuilt from `value` on every render; `value` is the real input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personnel, legacyRoster, presentIds, stationIds, assignedIds, rolesById, value])

  // umlaut-neutral and one typo forgiven (lib/search) — the Mannschaft is searched here with
  // gloves on, and a name that will not come up reads as a person who is not on the list
  const needle = searchQuery(q)
  const filtered = needle ? options.filter((o) => matchesQuery(needle, o.name)) : options

  // Adding the FIRST person makes them Gruppenführer, because the overwhelmingly common case is
  // that the Trupp is entered leader-first. Nothing is locked by it — the crown moves with a tap.
  const add = (slot: Slot) => { onChange([...value, slot]); setQ('') }
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i))
  /** crown: the chosen person moves to the front, everyone else keeps their order */
  const promote = (i: number) => onChange([value[i], ...value.filter((_, j) => j !== i)])

  const submitTyped = () => {
    const name = typed.trim()
    if (!name) return
    // A Gast under PA was at the Einsatz — that is not in question, it is the premise of putting
    // them in a Trupp. They used to have to be added to the Anwesenheit by hand afterwards, and
    // a name that only ever existed on a Trupp card reaches neither the Personalblatt nor the
    // statistics export.
    // ⚠️ …and the slot keeps the id the Anwesenheit gave them, so the two rows are the SAME
    // person to everything downstream: the roster row locks and wears the PA badge, the picker
    // says «in einem Trupp», and «einer, ein Trupp» holds for a Nachbarwehr too. Added by name
    // only, the Gast was two unrelated entries that happened to read alike.
    add({ name, personId: onAddGuest?.(name) })
    setTyped('')
    setTyping(false)
  }

  return (
    <div className={s.team}>
      {/* THE TRUPP — first, because it is the answer; the Mannschaft below it is the way to it.
          THREE slots at rest: that is the Trupp the form is asking for (GF + 2), the box does not
          change height as the usual three are ticked, and an empty slot says «this is where the
          next one goes» far better than a sentence would. A fourth, fifth, tenth person simply
          adds a row — `Math.max(SLOTS, value.length)` — so a big Trupp is never refused. */}
      <ul className={s.teamChosen}>
        {Array.from({ length: Math.max(SLOTS, value.length) }, (_, i) => {
          const m = value[i]
          if (!m) {
            // ⚠️ The empty slot NAMES its role — «GF», «AdF», «AdF». Three identical dashes said
            // only «something is missing here»; the badge column was blank on exactly the rows
            // where a first-time user needs to be told what a Trupp is made of. The role is the
            // one thing the form knows about a slot nobody is in yet, so it is what the slot says.
            return (
              <li key={`empty-${i}`} className={cx(s.teamRow, s.teamRowEmpty)} aria-hidden>
                <span className={s.teamRole}>{i === 0 ? az.leaderBadge : az.memberLabel}</span>
                <span className={s.teamName}>{az.teamSlotEmpty}</span>
              </li>
            )
          }
          const lead = i === 0
          return (
            <li key={`${m.personId ?? m.name}-${i}`} className={cx(s.teamRow, lead && s.teamRowLead)}>
              {/* ⚠️ The ROW is the control, not a star at its edge. Exactly one Gruppenführer,
                  always — so this behaves like a radio, and a radio is chosen by tapping the
                  option, not a glyph beside it. The leader's own row is inert: tapping «make
                  this one the leader» on the leader has no meaning, and a live control that
                  does nothing teaches that taps here sometimes fail. */}
              <button
                type="button"
                className={s.teamPick}
                aria-pressed={lead}
                disabled={lead}
                title={lead ? az.leaderLabel : fillTemplate(az.makeLeader, { name: m.name })}
                aria-label={lead ? az.leaderLabel : fillTemplate(az.makeLeader, { name: m.name })}
                onClick={() => promote(i)}
              >
                <span className={cx(s.teamRole, lead && s.teamRoleLead)}>
                  {lead ? az.leaderBadge : az.memberLabel}
                </span>
                <span className={s.teamName}>{m.name}</span>
                {/* a typed name carries no roster link — say so, so nobody wonders later why
                    this one person never appeared in the statistics export */}
                {!m.personId && <span className={s.comboHint}>{az.teamManual}</span>}
              </button>
              <button
                type="button" className={s.slotRemove}
                title={fillTemplate(az.teamRemove, { name: m.name })}
                aria-label={fillTemplate(az.teamRemove, { name: m.name })}
                onClick={() => remove(i)}
              ><Icon id="close" /></button>
            </li>
          )
        })}
      </ul>

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
              {o.guest && <span className={s.comboGuest}>{appConfig.copy.anwesenheit.guestBadge}</span>}
              <span className={s.comboName}>{o.name}</span>
              {/* ONE note per row, most operational first: already in a Trupp beats «still at
                  the Magazin», which beats a Funktion, which beats «nicht anwesend». Where
                  somebody IS decides whether they can go under PA at all; a Funktion is only a
                  reason to think twice. */}
              {o.taken
                ? <span className={s.comboHint}>{az.teamTaken}</span>
                : o.atStation
                  ? <span className={cx(s.comboHint, s.teamAtStation)}>{appConfig.copy.anwesenheit.ortStation}</span>
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
            ref={typedRef} autoFocus onFocus={caretToEnd} className={s.teamTypeInput} value={typed} maxLength={40}
            placeholder={az.guestNamePlaceholder} aria-label={az.typeName}
            onChange={(e) => setTyped(stripUnprintable(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitTyped() }
              else if (e.key === 'Escape') { setTyped(''); setTyping(false) }
            }}
          />
          <button
            type="button" className={s.teamTypeAdd} disabled={!typed.trim()}
            title={az.teamAdd} aria-label={az.teamAdd} onClick={submitTyped}
          ><Icon id="plus" /></button>
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
