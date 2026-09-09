import { useMemo, useRef, useState } from 'react'
import { caretToEnd } from '../lib/ui'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { fillTemplate, stripUnprintable } from '../lib/format'
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

/** How many matches the PHONE shows under the search field. Four is the answer to a typed query,
 *  not a list to browse: it fits above the fold with the keyboard up, and the Gast row underneath
 *  stays under the thumb. (On a tablet the whole Mannschaft is on screen and nothing is capped.) */
const PHONE_HITS = 4

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
  phone = false,
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
  /** THE PHONE SKIN (05.09.). Same control, same words, same record — a wrapping row of chips
   *  instead of three full-width slot rows, and the Mannschaft appears only under a typed query
   *  (at most `PHONE_HITS` of it). On 375px the old block was three slot rows plus a 38dvh
   *  roster before the operator had picked anybody. Tablet/desktop is untouched. */
  phone?: boolean
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

  /* ── With the keyboard up, the SEARCH IS THE SCREEN (09.09., maintainer decision) ───────────
   * This reverses the 05.09. answer to the same complaint, whose rule was «nothing is hidden and
   * nothing is collapsed»: the field rode to the top of the sheet's scroller (`liftSearch`) and
   * everything else stayed standing, one flick away. In the field that read as every part of the
   * form fighting the hits for the same band — the sheet's title clipped off the top, «Art des
   * Trupps», the Auftrag tiles and the Abbrechen/Bereitstellen footer all still holding rows,
   * and the four rows that ANSWER the typed query squeezed between them.
   * So on the phone stack, while THIS field is focused, everything below the Mannschaft is
   * hidden — the remaining sections and the footer — and the chips, the field and the hits get
   * the whole band above the keyboard. Everything is back the moment the keyboard goes.
   * ⚠️ It is CSS, not React state (Atemschutz.module.css · `.modalStack:global(.is-kb)` +
   * `:has(.teamSearch input:focus)`), and that is the load-bearing part: a blur handler would
   * re-lay the form out mid-gesture. Only things BELOW the hits come and go, so the row under
   * the thumb never moves — and there is no timer whose un-hide can be mistimed.
   * ⚠️ …and because the takeover hangs on this field's `:focus`, a tap on a hits row must not
   * take it away — see `keepSearch` below, which is what lets a second and third person be
   * added without the search closing between them (09.09.).
   * ⚠️ The selector names this field, not «an input»: focusing the Ziel leaves the form as it is.
   * (`liftSearch` went with the layout it was built for. With the sections gone the field is
   * already near the top of the sheet, and a 260ms smooth scroll still running when a tap lands
   * is the one remaining way to move the hits out from under a finger.) */

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
        // FULLY alphabetical since 08.09. (field ask), in exactly two bands: whoever is
        // anwesend AND free to take stands first, everyone else (absent, or already in a
        // Trupp) follows — each band A–Z. Seniority and the Magazin ordering retired: a name
        // is found by its letter, not by guessing its rank's position; the Magazin and
        // «in Trupp X» hints keep SAYING what they said, they just stop re-sorting the list.
        .sort((a, b) => {
          const aReady = a.present && !a.taken
          const bReady = b.present && !b.taken
          return Number(bReady) - Number(aReady) || a.name.localeCompare(b.name, 'de')
        })
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
  /* What the list actually OFFERS, and the only array anything acts on. On a tablet that is every
   * match. On a phone the list exists only while something is typed and shows the first
   * `PHONE_HITS` of it: a typed name has an answer, and four rows are that answer with room to
   * have mistyped it. Enter reads this same array, so the key and the finger can never take two
   * different people. */
  const visible = phone ? (needle ? filtered.slice(0, PHONE_HITS) : []) : filtered

  /** the search field itself — the takeover above is driven by ITS `:focus` (see `keepSearch`) */
  const searchRef = useRef<HTMLInputElement>(null)

  /* ⚠️ THE SEARCH SURVIVES THE TAP (09.09., field ask). A Trupp is entered several people at a
   * time, and adding one used to end the search: the tap moved focus onto the hits row, `add`
   * cleared the query, the row unmounted with the list — and focus fell to the body, which drops
   * the keyboard AND ends the takeover (which is `:has(.teamSearch input:focus)`). The next name
   * cost a tap back into the field and a second keyboard animation, every time.
   * Two halves, and both are needed:
   *   · `keepSearch` — the row refuses the focus in the first place (`mousedown` default
   *     prevented, the standard combobox move), so nothing blurs and iOS never starts closing
   *     the keyboard. It is also what keeps the CSS takeover from re-laying the form out
   *     mid-gesture, which is exactly what its own ⚠️ above warns about.
   *   · the `focus()` in `add` — the belt under it, for the paths that DO leave the field
   *     (Enter is already there; a browser that focuses on `pointerdown` regardless is not).
   *     Called inside the tap's own handler, so iOS accepts it as a user gesture and the
   *     keyboard stays up rather than reopening.
   * The QUERY still clears: the hits that answered «bru» are not the way to the next person, and
   * an empty field is what the placeholder («Weitere Person suchen …») promises. */
  const keepSearch = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() }

  // Adding the FIRST person makes them Gruppenführer, because the overwhelmingly common case is
  // that the Trupp is entered leader-first. Nothing is locked by it — the crown moves with a tap.
  const add = (slot: Slot) => { onChange([...value, slot]); setQ(''); searchRef.current?.focus() }
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
  /* …and only while the Trupp does not already have that name standing in it. The roster options
   * have dropped whoever is chosen since the beginning (`chosenNames`); the Gast door never did,
   * so typing a member's own name back offered to add them a SECOND time. Nobody means that —
   * and one name twice is also what would let two chips claim the same identity (see the chip
   * `key` below, which is that identity). */
  const guestOffer = typedName && !chosenNames.has(typedName) ? typedName : ''

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
    if (!guestOffer) return
    add({ name: guestOffer, personId: onAddGuest?.(guestOffer) })
  }

  /* Enter keeps the keyboard flow one step, and it never has to be aimed: with matches on screen
   * it takes the first one that can be taken (the list is already sorted the way the hand
   * expects — present first, then alphabetical; confirmed 09.09. against the field ask for rank
   * order); with NO matches the query can only have been a
   * name, so it becomes the Gast. A list whose every match is already in another Trupp does
   * nothing: those rows are shown greyed for a reason, and inventing a Gast with the same name is
   * the one outcome nobody meant. */
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (visible.length) {
      const first = visible.find((o) => !o.taken)
      if (first) add({ name: first.name, personId: first.personId })
      return
    }
    addGuest()
  }

  /* THE TWO SKINS of one control (05.09.). Full-width rows on a tablet, a wrapping row of chips
   * on a phone — same buttons, same labels, same handlers, same `value[0]` record. Only the class
   * names differ, so «who leads» and «take them out» cannot drift apart between the two layouts. */
  const skin = phone
    ? { list: s.teamChips, row: s.chip, lead: s.chipLead, pick: s.chipPick,
        role: s.chipRole, roleLead: s.chipRoleLead, name: s.chipName, remove: s.chipX }
    : { list: s.teamChosen, row: s.teamRow, lead: s.teamRowLead, pick: s.teamPick,
        role: s.teamRole, roleLead: s.teamRoleLead, name: s.teamName, remove: s.slotRemove }

  return (
    <div className={s.team}>
      {/* THE TRUPP — first, because it is the answer; the Mannschaft below it is the way to it.
          No reserved slots since 08.09.: the crew POPULATES as people are picked, and a fourth,
          fifth, tenth person simply adds a row — a big Trupp is never refused. An empty Trupp
          renders no chip at all (09.09.): the search sits right below it already, so a dashed
          placeholder chip only repeated what the very next control on screen already says. */}
      <ul className={skin.list}>
        {value.map((m, i) => {
          const lead = i === 0
          /* ⚠️ IDENTITY, not position. The key carried the index until 09.09., and crowning
             re-orders this very list — so every promote tore all N chips down and built them
             again, one frame of blank in the middle of the gesture that is supposed to move a
             single outline. Keyed by the person, React MOVES the node it already has.
             The suffix is a guard, not a case: a person can be in the Trupp once (the options
             drop `chosenIds`/`chosenNames`, and the Gast door refuses a name already standing
             here), so it only ever fires for a legacy record that came in with a duplicate. */
          const id = m.personId ?? m.name
          const first = value.findIndex((o) => (o.personId ?? o.name) === id)
          return (
            <li key={first === i ? id : `${id}#${i}`} className={cx(skin.row, lead && skin.lead)}>
              {/* ⚠️ The ROW/CHIP BODY is the control, not a star at its edge. Exactly one
                  Gruppenführer, always — so this behaves like a radio, and a radio is chosen by
                  tapping the option, not a glyph beside it. The leader's own is inert: tapping
                  «make this one the leader» on the leader has no meaning, and a live control that
                  does nothing teaches that taps here sometimes fail. */}
              <button
                type="button"
                className={skin.pick}
                aria-pressed={lead}
                disabled={lead}
                title={lead ? az.leaderLabel : fillTemplate(az.makeLeader, { name: m.name })}
                aria-label={lead ? az.leaderLabel : fillTemplate(az.makeLeader, { name: m.name })}
                {...(lead ? {} : hold.press(() => promoteByHold(i)))}
                onClick={() => { if (!clickAfterHold()) promote(i) }}
              >
                {/* no GF/AdF badge since 08.09. (field ask): the amber outline IS the leader
                    marker — the same tone the card, the Rapport and the map tag print — and
                    every other row is an AdF by definition. The role words live on in the
                    a11y labels and the stack summary. */}
                <span className={skin.name}>{m.name}</span>
                {/* a typed name carries no roster link — say so, so nobody wonders later why
                    this one person never appeared in the statistics export */}
                {!m.personId && <span className={s.comboHint}>{az.teamManual}</span>}
              </button>
              <button
                type="button" className={skin.remove}
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
      <label className={s.teamSearch}>
        <Icon id="search" />
        <input
          ref={searchRef}
          value={q} onChange={(e) => setQ(stripUnprintable(e.target.value))} inputMode="search"
          maxLength={40} onFocus={caretToEnd} onKeyDown={onSearchKeyDown}
          // ⚠️ The PLACEHOLDER moves on once the Trupp has somebody in it — «Weitere Person
          // suchen …» — because on the phone this field is the only way in and «Person suchen»
          // over three chips reads as if it were asking again for whoever is already standing
          // there. The a11y NAME stays put: a label that renames itself under the same control
          // is a second control to a screen reader.
          placeholder={phone && value.length ? az.teamSearchMore : az.teamSearchPlaceholder}
          aria-label={az.teamSearchPlaceholder}
        />
        {q && (
          <button type="button" className={s.teamSearchClear} onClick={() => setQ('')}
            aria-label={appConfig.copy.clear}><Icon id="close" /></button>
        )}
      </label>

      {/* ⚠️ On a PHONE the Mannschaft appears only under a typed query, and the list is the
          ANSWER to it rather than a surface to browse: `.teamHits` shrink-wraps its ≤4 rows
          instead of reserving 38dvh of standing roster, and it deliberately carries a class of
          its own — the `:has(.teamList)` rules that hand the open section the sheet's spare room
          (Atemschutz.module.css) must not fire on a box that comes and goes with the keyboard. */}
      {(!phone || !!needle) && (
      <ul className={phone ? s.teamHits : s.teamList}
        role="listbox" aria-label={az.sectionTeam}>
        {visible.map((o) => (
          <li key={o.key}>
            <button
              type="button" className={cx(s.comboOpt, o.taken && s.teamOptTaken)}
              role="option" aria-selected={false} disabled={o.taken}
              {...keepSearch}
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
        {!visible.length && <li className={s.comboEmpty}>{needle ? az.teamNoMatches : az.noRoster}</li>}
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
        {guestOffer && (
          <li>
            <button
              type="button" className={cx(s.comboOpt, s.comboType)}
              role="option" aria-selected={false} {...keepSearch} onClick={addGuest}
            >
              <Icon id="type" />
              <span className={c.name}>{fillTemplate(az.teamGuestAdd, { name: guestOffer })}</span>
            </button>
          </li>
        )}
      </ul>
      )}

      {/* THE ONE LINE UNDER THE CHIPS (phone, at rest) — and only that one (09.09., field ask:
          the count + a second sentence read as «blabla»). With 0 or 1 people, tapping a name
          would promote nobody or nobody-else, so the hint saying it means nothing yet either. */}
      {phone && !needle && value.length >= 2 && (
        <p className={s.teamHint}>{az.teamHintChips}</p>
      )}
    </div>
  )
}
