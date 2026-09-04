import { useEffect, useMemo, useRef, useState } from 'react'
import { caretToEnd } from '../lib/ui'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { fillTemplate, stripUnprintable } from '../lib/format'
import { rankOrder } from '../lib/rank'
import { matchesQuery, searchQuery } from '../lib/search'
import { useLongPress } from '../lib/useLongPress'
import type { Person } from '../types'
import type { Slot } from './PersonField'
import { ComboRank } from './ComboMenu'
import s from './Atemschutz.module.css'
// the Dienstgrad chip and the name cell of a roster row live with the picker they were shared
// with (ComboMenu.module.css) — this list draws the same row, so it draws the same two marks
import c from './ComboMenu.module.css'

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
  /* ONE field (04.09.). There used to be two: a search, and — after the whole roster list — a
   * «Name eingeben (Gast / Nachbarwehr)» link that unfolded a second input. On a 66-person
   * Mannschaft that link sat below the list, so the one case where the list has no answer was the
   * case where the answer was furthest away; and the two fields asked the same question («wer»)
   * in two places, one of which had to be found first.
   * So the search IS the guest entry: type a name, and if the Mannschaft cannot answer, the last
   * row of the list offers to take that name as a Gast. Nothing is typed twice and there is no
   * permanent Gast row standing over a roster that usually has the person on it. */
  const [q, setQ] = useState('')
  // An empty slot LOOKS like the field it is not: people tap it and wait for a keyboard. It
  // stays a slot — names are picked from the Mannschaft below — so the tap points at the search
  // AND at the list: caret in the field, and both blink once so the eye follows the finger. Same
  // pointing gesture the card flash makes (.cardFlash), never a state that stays.
  // ⚠️ Not just the field. The search is only how you NARROW the list; the list is where the
  // names actually are, and blinking the field alone sent people looking for a keyboard again.
  // (The Gast link used to blink with them. It is gone — the answer for somebody who is not on
  // the Mannschaft now appears IN the list, so the list is already the thing being pointed at.)
  const searchRef = useRef<HTMLInputElement>(null)
  const [hint, setHint] = useState(false)
  const pointAtSearch = () => {
    searchRef.current?.focus()
    // restart the blink even if one is still running — a second tap has to be answered too
    setHint(false)
    requestAnimationFrame(() => setHint(true))
  }
  // cleared on a timer, not on animationend: under prefers-reduced-motion there is no animation
  // to end, and the ring would sit there for good
  useEffect(() => {
    if (!hint) return
    const t = window.setTimeout(() => setHint(false), 1200)
    return () => window.clearTimeout(t)
  }, [hint])

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
  // …by a tap OR by a hold. The row is a radio and a tap is the right gesture for one, but the
  // hand that has just learned «press and hold» on a node handle, a lock chip and a Trupp card
  // tries it here too — and a press that does nothing reads as a row that isn't a control.
  // ⚠️ The trailing click MUST be swallowed. The rows re-order the instant the hold fires, so
  // the click that arrives a moment later would land on whoever slid into that position and
  // crown THEM — the mis-tap this whole surface exists to prevent.
  const hold = useLongPress()
  const heldAt = useRef(0)
  const promoteByHold = (i: number) => { heldAt.current = Date.now(); promote(i) }
  const clickAfterHold = () => Date.now() - heldAt.current < 600

  /** What the query would be taken as, if it is taken as a name at all. */
  const typedName = q.trim()

  /* The Gast / Nachbarwehr commit. Deliberately EXPLICIT — a tap on the action row, or Enter on a
   * query the Mannschaft cannot answer.
   * ⚠️ It no longer commits on blur or on unmount (04.09.), and that reversal is the price of the
   * shared field: a half-typed «Hub» is a SEARCH in progress, and the old auto-commit would have
   * put a person called «Hub» in the Trupp the moment the field lost focus. The rule it replaced
   * («a typed name is never silently dropped») was about a field that could only ever have been a
   * name; this one is a name only once somebody says so.
   *
   * A Gast under PA was at the Einsatz — that is not in question, it is the premise of putting
   * them in a Trupp. They used to have to be added to the Anwesenheit by hand afterwards, and a
   * name that only ever existed on a Trupp card reaches neither the Personalblatt nor the
   * statistics export.
   * ⚠️ …and the slot keeps the id the Anwesenheit gave them, so the two rows are the SAME person
   * to everything downstream: the roster row locks and wears the PA badge, the picker says «in
   * einem Trupp», and «einer, ein Trupp» holds for a Nachbarwehr too. Added by name only, the
   * Gast was two unrelated entries that happened to read alike. */
  const addGuest = () => {
    if (!typedName) return
    add({ name: typedName, personId: onAddGuest?.(typedName) })
  }

  /* Enter keeps the keyboard flow one step, and it never has to be aimed: with matches on screen
   * it takes the first one that can be taken (the list is already sorted the way the hand
   * expects — present first, then seniority); with NO matches the query can only have been a
   * name, so it becomes the Gast. A list whose every match is already in another Trupp does
   * nothing: those rows are shown greyed for a reason, and inventing a Gast with the same name is
   * the one outcome nobody meant. */
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (filtered.length) {
      const first = filtered.find((o) => !o.taken)
      if (first) add({ name: first.name, personId: first.personId })
      return
    }
    addGuest()
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
            // ⚠️ …and it is TAPPABLE, but never a field: the tap hands the caret to the search
            // below (pointAtSearch). Out of the screen reader's way — it announces nothing a
            // «–» row could tell it, and the search field is the next thing in the tab order.
            return (
              <li key={`empty-${i}`} className={cx(s.teamRow, s.teamRowEmpty)}>
                <button
                  type="button" className={s.teamPick} tabIndex={-1} aria-hidden
                  title={az.teamSearchPlaceholder} onClick={pointAtSearch}
                >
                  <span className={s.teamRole}>{i === 0 ? az.leaderBadge : az.memberLabel}</span>
                  <span className={s.teamName}>{az.teamSlotEmpty}</span>
                </button>
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
                {...(lead ? {} : hold.press(() => promoteByHold(i)))}
                onClick={() => { if (!clickAfterHold()) promote(i) }}
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
          dropdown was the surface people complained about first — and since 04.09. it is also
          where a Gast is typed, so this is the ONE field on the block. `maxLength` is the name's,
          not the search's: whatever stands here can end up on the Personalblatt.
          ⚠️ `stripUnprintable` on the way IN, for the same reason — the query is a search until
          the moment it is committed as a name, and there is no second field left to clean it. */}
      <label className={cx(s.teamSearch, hint && s.teamSearchHint)}>
        <Icon id="search" />
        <input
          ref={searchRef}
          value={q} onChange={(e) => setQ(stripUnprintable(e.target.value))} inputMode="search"
          maxLength={40} onFocus={caretToEnd} onKeyDown={onSearchKeyDown}
          placeholder={az.teamSearchPlaceholder} aria-label={az.teamSearchPlaceholder}
        />
        {q && (
          <button type="button" className={s.teamSearchClear} onClick={() => setQ('')}
            aria-label={appConfig.copy.clear}><Icon id="close" /></button>
        )}
      </label>

      <ul className={cx(s.teamList, hint && s.teamListHint)} role="listbox" aria-label={az.sectionTeam}>
        {filtered.map((o) => (
          <li key={o.key}>
            <button
              type="button" className={cx(s.comboOpt, o.taken && s.teamOptTaken)}
              role="option" aria-selected={false} disabled={o.taken}
              onClick={() => add({ name: o.name, personId: o.personId })}
            >
              {o.personId && <span className={cx(s.comboDot, o.present ? s.comboDotPresent : s.comboDotOff)} />}
              {o.rank && <ComboRank rank={o.rank} />}
              {o.guest && <span className={s.comboGuest}>{appConfig.copy.anwesenheit.guestBadge}</span>}
              <span className={c.name}>{o.name}</span>
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
        {/* THE GAST DOOR, and it exists only while something is typed (04.09.). It carries the
            query in its own label, so the row states what pressing it will do rather than opening
            a second field to say it again — «"Keller" als Gast hinzufügen». The label is short
            BECAUSE it carries the name: the row ellipsizes (ComboMenu.module.css · .name), and a
            longer sentence spent that budget on words instead of on the typed name. With an
            empty query there is nothing to take and no row: a permanent «Name eingeben» line over
            a roster that usually HAS the person was the old shape, and it is what put the escape
            hatch below 66 rows in the first place.
            ⚠️ LAST, under the matches, and that is not a reachability problem: a name the
            Mannschaft cannot answer leaves few matches or none, so this row is right under the
            thumb exactly when it is the row that is wanted. */}
        {typedName && (
          <li>
            <button
              type="button" className={cx(s.comboOpt, s.comboType)}
              role="option" aria-selected={false} onClick={addGuest}
            >
              <Icon id="type" />
              <span className={c.name}>{fillTemplate(az.teamGuestAdd, { name: typedName })}</span>
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}
