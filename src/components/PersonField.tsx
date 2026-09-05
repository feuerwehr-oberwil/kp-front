import { useMemo, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { fillTemplate, stripUnprintable } from '../lib/format'
import { isOfficer, rankOrder } from '../lib/rank'
import type { Person } from '../types'
import { ComboMenu, ComboRank, useComboMenu, type ComboEntry, type ComboMenuClasses } from './ComboMenu'
import s from './Atemschutz.module.css'

export type Slot = { name: string; personId?: string }

/** The Atemschutz/Rapport skin — 15px type on --surface, `.combo*` in Atemschutz.module.css. */
const CLASSES: ComboMenuClasses = {
  menu: s.comboMenu, menuPortal: s.comboMenuPortal,
  opt: s.comboOpt,
  toggle: s.comboToggle, toggleOn: s.comboToggleOn,
  type: s.comboType, empty: s.comboEmpty,
}

// A combobox for a leader/AdF slot: pick from the Mannschaft dropdown (present crew first,
// already-assigned flagged) OR just type a name (guests, mutual aid, Divera outage). Selecting
// a person links the id; typing leaves it a manual snapshot. Replaces the old chip list.
//
// The menu, where it is put and how it is dismissed all come from `ComboMenu`; what is left here
// is the person policy — who is offered, in what order, what is said about them, and what a
// hand-typed name becomes.
export function PersonField({
  label, placeholder, value, onChange, onRemove, removeLabel, personnel, legacyRoster, presentIds, assignedIds, usedIds, usedNames,
  rolesById, rankFirst = false, officerFilter = false, onAddGuest, trailing,
}: {
  label: string
  placeholder: string
  value: Slot
  onChange: (slot: Slot) => void
  /** drop the whole SLOT (not just its name) — renders a ✕ next to the label. The ✕ inside the
   *  field only clears the chosen name and leaves the empty row behind, which is a dead end for
   *  a row that was added by mistake. Omit for fixed slots (Gruppenführer, Einsatzleiter). */
  onRemove?: () => void
  removeLabel?: string
  personnel: Person[]
  legacyRoster: string[]
  presentIds: Set<string>
  assignedIds: Set<string>
  usedIds: Set<string>
  usedNames: Set<string>
  /** the job somebody already holds on this Einsatz, per person id — their Anwesenheits-
   *  Bemerkung («Einsatzleiter», «Fahrer TLF»). Shown beside the name as a SOFT note: the
   *  Einsatzleiter going in with a Trupp happens, and the picker's job is to say «this one
   *  is probably already spoken for», never to hide or block them (3am tenet). */
  rolesById?: Map<string, string>
  /** sort higher-ups first (rank → present → alpha) instead of the default present-first —
   *  used for the Einsatzleiter/officer pickers. */
  rankFirst?: boolean
  /** offer a "nur Offiziere" toggle that narrows the list to officer-rank people (the
   *  type-a-name fallback stays, so nobody is truly hidden — 3am tenet). */
  officerFilter?: boolean
  /** File a hand-typed name under an id — the roster's, or a fresh Gast's — so the person named
   *  here reaches the Anwesenheit like anybody picked from the list. Hands back that id; absent
   *  for a session that may not write, and the slot then keeps the bare name it always did. */
  onAddGuest?: (name: string) => string | undefined
  /** A control that belongs to this field and sits at the END of its input line — «Entfällt» on
   *  the Rückmeldung ELZ. It goes beside the COMBO, not beside the label block: a button next to
   *  the whole field would centre itself against label + input and line up with neither. */
  trailing?: ReactNode
}) {
  const az = appConfig.copy.atemschutz
  const [combo, { rootRef, pickRef, menuRef, inputRef }] = useComboMenu()
  const { officersOnly } = combo

  const entries: ComboEntry<Slot>[] = useMemo(() => {
    const dot = (present: boolean) => <span className={cx(s.comboDot, present ? s.comboDotPresent : s.comboDotOff)} />
    if (personnel.length) {
      return personnel
        // people already in ANOTHER active Trupp are excluded — one person can't be in two
        // Trupps at once (a typed-name fallback still works for guests/mutual aid)
        .filter((p) => p.active && !usedIds.has(p.id) && !usedNames.has(p.displayName) && !assignedIds.has(p.id))
        // officer filter is opt-in (officerFilter) AND toggled on — narrows to officer ranks
        .filter((p) => !(officerFilter && officersOnly) || isOfficer(p.rank))
        // rankFirst: higher-ups first (rank → present → alpha); default: present first, rank as tiebreaker
        .sort((a, b) =>
          rankFirst
            ? rankOrder(a.rank) - rankOrder(b.rank) || Number(presentIds.has(b.id)) - Number(presentIds.has(a.id)) || a.displayName.localeCompare(b.displayName, 'de')
            : Number(presentIds.has(b.id)) - Number(presentIds.has(a.id)) || rankOrder(a.rank) - rankOrder(b.rank) || a.displayName.localeCompare(b.displayName, 'de'),
        )
        .map((p) => {
          const present = presentIds.has(p.id)
          const role = rolesById?.get(p.id)
          return {
            key: p.id, label: p.displayName, value: { name: p.displayName, personId: p.id },
            lead: (
              <>
                {dot(present)}
                {p.rank && <ComboRank rank={p.rank} />}
                {/* not on the Mannschaftsliste (lib/guests) — offered like anybody else, but
                    SAID, so nobody picks a Nachbarwehr's AdF thinking they are looking at
                    their own crew */}
                {p.guest && <span className={s.comboGuest}>{appConfig.copy.anwesenheit.guestBadge}</span>}
              </>
            ),
            // the job they already hold outranks «nicht anwesend»: somebody with a Funktion IS
            // here, and «schon: Einsatzleiter» is the more useful warning
            note: role
              ? <span className={s.comboHint}>{fillTemplate(appConfig.copy.anwesenheit.alreadyBooked, { role })}</span>
              : !present ? <span className={s.comboHint}>{az.notPresent}</span> : undefined,
          }
        })
    }
    return legacyRoster.filter((n) => !usedNames.has(n)).map((n) => ({ key: n, label: n, value: { name: n } }))
  }, [personnel, legacyRoster, presentIds, assignedIds, usedIds, usedNames, rolesById, rankFirst, officerFilter, officersOnly, az.notPresent])

  const clear = () => { onChange({ name: '' }); combo.stopTyping() }
  /** Leaving the free-text field is what FINISHES a hand-typed name: it is filed under an id —
   *  the roster's if it names one of ours, a fresh Gast's otherwise (lib/guests) — so whoever is
   *  named here reaches the Anwesenheit like anybody picked from the list. A name that only ever
   *  sat on the Rapport reached neither the Personalblatt nor the statistics export. */
  const commitTyped = () => {
    combo.stopTyping()
    combo.close()
    const name = value.name.trim()
    if (!onAddGuest || !name || value.personId) return
    const id = onAddGuest(name)
    if (id) onChange({ name, personId: id })
  }

  return (
    <div className={s.field}>
      {onRemove ? (
        <span className={s.fieldLabelRow}>
          <span>{label}</span>
          <button type="button" className={s.slotRemove} onClick={onRemove} title={removeLabel} aria-label={removeLabel}>
            <Icon id="close" />
          </button>
        </span>
      ) : (
        <span>{label}</span>
      )}
      <MaybeRow trailing={trailing}>
      <div className={s.combo} ref={rootRef}>
        {combo.typing ? (
          <input
            ref={inputRef}
            value={value.name} placeholder={placeholder}
            // a hand-typed name (guest crew, someone not in Divera) is capped so it can't blow out
            // the Trupp card's one-line name row; every real roster name is far inside this
            maxLength={40}
            onChange={(e) => onChange({ name: stripUnprintable(e.target.value) })}
            // the delay lets a tap on a menu entry win over the blur (that path sets a personId)
            onBlur={() => window.setTimeout(commitTyped, 120)}
          />
        ) : (
          <button
            ref={pickRef}
            type="button" className={cx(s.comboPick, !value.name && s.comboPickEmpty)}
            aria-haspopup="listbox" aria-expanded={combo.open}
            onClick={combo.toggle}
          >
            <span className={s.comboPickName}>{value.name || placeholder}</span>
          </button>
        )}
        {!combo.typing && !value.name && <span className={s.comboChev} aria-hidden><Icon id="chevron-down" className="chev" /></span>}
        {value.name && (
          <button
            type="button" className={s.comboClear} title={appConfig.copy.clear} aria-label={az.clearName}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
          ><Icon id="close" /></button>
        )}
        <ComboMenu
          state={combo}
          menuRef={menuRef}
          classes={CLASSES}
          copy={{ search: az.teamSearchPlaceholder, empty: az.noRoster, noMatches: az.teamNoMatches }}
          entries={entries}
          // below this the whole roster is on screen anyway and a search box is one more control
          // between the finger and the name it came for
          showSearch={entries.length > 8}
          limit={60}
          toggle={officerFilter ? { label: az.officersOnly } : undefined}
          // type-a-name fallback for guests / mutual aid — only here does the keyboard appear
          custom={{ label: az.typeName }}
          onPick={onChange}
        />
      </div>
      {trailing}
      </MaybeRow>
    </div>
  )
}

/** The combo alone when there is no trailing control, combo + control on one line when there is —
 *  so a field without one keeps exactly the markup (and the layout) it always had. */
function MaybeRow({ trailing, children }: { trailing?: ReactNode; children: ReactNode }) {
  return trailing ? <div className="pf-trail">{children}</div> : <>{children}</>
}
