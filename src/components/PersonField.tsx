import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { fillTemplate, stripUnprintable } from '../lib/format'
import { isOfficer, rankAbbr, rankLabel, rankOrder } from '../lib/rank'
import { matchesQuery, searchQuery } from '../lib/search'
import type { Person } from '../types'
import s from './Atemschutz.module.css'

export type Slot = { name: string; personId?: string }

/** Ceiling for the portalled roster menu. Not a target — the menu takes whatever room the
 *  trigger actually has (see `place`); this only stops it from becoming a curtain over the
 *  form it belongs to. ~9 name rows, which is enough that a Mannschaft rarely needs scrolling
 *  before the search narrows it. */
const MAX_MENU_H = 440

// A combobox for a leader/AdF slot: pick from the Mannschaft dropdown (present crew first,
// already-assigned flagged) OR just type a name (guests, mutual aid, Divera outage). Selecting
// a person links the id; typing leaves it a manual snapshot. Replaces the old chip list.
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
  const [open, setOpen] = useState(false)
  const [officersOnly, setOfficersOnly] = useState(false)
  // Narrowing the roster by typing. A 66-person Mannschaft in a short menu is a handful of
  // visible rows, so finding somebody meant scrolling past sixty names with a gloved finger —
  // the one complaint about this picker after the 08.08. Einsatz. NOT auto-focused: this stays a
  // roster-first picker, and a keyboard that opens by itself covers the list it is filtering.
  const [search, setSearch] = useState('')
  // Roster-first: the field is a tap-to-open picker (no keyboard). The OS keyboard only
  // appears once the user explicitly chooses "Name eingeben" for a guest / mutual-aid name.
  const [typing, setTyping] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const pickRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  // portalled-menu position (mirrors Combo): the TruppForm modal / report sheet scrolls, and an
  // absolutely-positioned menu gets clipped at that overflow boundary — fatal on a phone where
  // the lower person fields sit right at the sheet's scroll edge
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number; up: boolean } | null>(null)

  type Opt = { key: string; name: string; personId?: string; present: boolean; assigned: boolean; rank?: string; role?: string; guest?: boolean }
  const options: Opt[] = useMemo(() => {
    if (personnel.length) {
      return personnel
        // people already in ANOTHER active Trupp are excluded — one person can't be in two
        // Trupps at once (a typed-name fallback still works for guests/mutual aid)
        .filter((p) => p.active && !usedIds.has(p.id) && !usedNames.has(p.displayName) && !assignedIds.has(p.id))
        // officer filter is opt-in (officerFilter) AND toggled on — narrows to officer ranks
        .filter((p) => !(officerFilter && officersOnly) || isOfficer(p.rank))
        .map((p) => ({
          key: p.id, name: p.displayName, personId: p.id, present: presentIds.has(p.id), assigned: false, rank: p.rank,
          role: rolesById?.get(p.id),
          // not on the Mannschaftsliste (lib/guests) — offered like anybody else, but SAID, so
          // nobody picks a Nachbarwehr's AdF thinking they are looking at their own crew
          guest: p.guest,
        }))
        // rankFirst: higher-ups first (rank → present → alpha); default: present first, rank as tiebreaker
        .sort((a, b) =>
          rankFirst
            ? rankOrder(a.rank) - rankOrder(b.rank) || Number(b.present) - Number(a.present) || a.name.localeCompare(b.name, 'de')
            : Number(b.present) - Number(a.present) || rankOrder(a.rank) - rankOrder(b.rank) || a.name.localeCompare(b.name, 'de'),
        )
    }
    return legacyRoster.filter((n) => !usedNames.has(n)).map((n) => ({ key: n, name: n, present: false, assigned: false }))
  }, [personnel, legacyRoster, presentIds, assignedIds, usedIds, usedNames, rolesById, rankFirst, officerFilter, officersOnly])

  // two independent narrowings: the free-name field filters by what is being typed INTO the
  // slot, the menu's own box filters while browsing. Never both — the box only exists in the
  // menu, and the menu is closed while typing a name.
  // …and both narrow the same way (lib/search): umlauts either way, one typo forgiven.
  const needle = useMemo(() => searchQuery(typing ? value.name : search), [typing, value.name, search])
  const filtered = needle ? options.filter((o) => matchesQuery(needle, o.name)) : options
  // below this the whole roster is on screen anyway and a search box is one more control
  // between the finger and the name it came for
  const showSearch = options.length > 8

  // entering type-mode is a deliberate user tap, so focusing here is allowed to open the keyboard
  useEffect(() => { if (typing) inputRef.current?.focus() }, [typing])

  // close the roster dropdown on an outside tap (the picker button isn't a focusable input) —
  // the portalled menu counts as "inside" alongside the trigger
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) { setOpen(false); setSearch('') }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  // place the portalled menu under (or above, near the viewport bottom) the trigger — same
  // placement logic as the global Combo
  useEffect(() => {
    if (!open) return
    const place = () => {
      const el = pickRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      const up = below < 200 && above > below
      // TAKE the room that is there. The cap used to be 252px — about five names — so on a
      // full-height Rapport the roster scrolled inside a short box with half the sheet empty
      // underneath it. `below`/`above` already hold the real space, so the ceiling only has to
      // stop the menu becoming a full-screen curtain over the form it belongs to.
      setPos({ left: r.left, top: up ? r.top : r.bottom, width: r.width, maxH: Math.max(140, Math.min(MAX_MENU_H, up ? above : below)), up })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place) }
  }, [open])

  // a menu that reopens still holding last time's search would look like a roster with people
  // missing from it — the one way this control can lie
  const closeMenu = () => { setOpen(false); setSearch('') }
  const clear = () => { onChange({ name: '' }); setTyping(false) }
  /** Leaving the free-text field is what FINISHES a hand-typed name: it is filed under an id —
   *  the roster's if it names one of ours, a fresh Gast's otherwise (lib/guests) — so whoever is
   *  named here reaches the Anwesenheit like anybody picked from the list. A name that only ever
   *  sat on the Rapport reached neither the Personalblatt nor the statistics export. */
  const commitTyped = () => {
    setTyping(false)
    closeMenu()
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
        {typing ? (
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
            aria-haspopup="listbox" aria-expanded={open}
            onClick={() => { if (open) closeMenu(); else setOpen(true) }}
          >
            <span className={s.comboPickName}>{value.name || placeholder}</span>
          </button>
        )}
        {!typing && !value.name && <span className={s.comboChev} aria-hidden><Icon id="chevron-down" /></span>}
        {value.name && (
          <button
            type="button" className={s.comboClear} title={appConfig.copy.clear} aria-label={az.clearName}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
          ><Icon id="close" /></button>
        )}
        {open && !typing && pos && createPortal(
          <ul ref={menuRef} className={cx(s.comboMenu, s.comboMenuPortal)} role="listbox"
            // up-mode must neutralise the base class's `top: calc(100% + 4px)` (under
            // position:fixed that's viewport-bottom + 4 — the 0-height-sliver trap the
            // global Combo already guards against)
            style={{ left: pos.left, width: pos.width, maxHeight: pos.maxH, ...(pos.up ? { top: 'auto', bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }) }}>
            {showSearch && (
              <li className={s.comboSearchRow}>
                <span className={s.comboSearchIcon} aria-hidden><Icon id="search" /></span>
                <input
                  className={s.comboSearch} value={search} inputMode="search"
                  placeholder={az.teamSearchPlaceholder} aria-label={az.teamSearchPlaceholder}
                  onChange={(e) => setSearch(e.target.value)}
                  // a stray Enter in a picker must not submit the form the picker sits in
                  onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
                />
                {search && (
                  <button type="button" className={s.comboSearchClear}
                    aria-label={appConfig.copy.anwesenheit.clearSearch}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setSearch('')}><Icon id="close" /></button>
                )}
              </li>
            )}
            {officerFilter && (
              <li>
                <button
                  type="button" className={cx(s.comboOpt, s.comboToggle, officersOnly && s.comboToggleOn)}
                  aria-pressed={officersOnly}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setOfficersOnly((v) => !v)}
                >
                  {officersOnly && <Icon id="check" />}<span>{az.officersOnly}</span>
                </button>
              </li>
            )}
            {filtered.slice(0, 60).map((o) => (
              <li key={o.key}>
                <button
                  type="button" className={s.comboOpt}
                  onClick={() => { onChange({ name: o.name, personId: o.personId }); closeMenu() }}
                >
                  {o.personId && <span className={cx(s.comboDot, o.present ? s.comboDotPresent : s.comboDotOff)} />}
                  {o.rank && <span className={s.comboRank} title={rankLabel(o.rank)}>{rankAbbr(o.rank)}</span>}
                  {o.guest && <span className={s.comboGuest}>{appConfig.copy.anwesenheit.guestBadge}</span>}
                  <span className={s.comboName}>{o.name}</span>
                  {/* the job they already hold outranks «nicht anwesend»: somebody with a
                      Funktion IS here, and «schon: Einsatzleiter» is the more useful warning */}
                  {o.role
                    ? <span className={s.comboHint}>{fillTemplate(appConfig.copy.anwesenheit.alreadyBooked, { role: o.role })}</span>
                    : o.personId && !o.present && <span className={s.comboHint}>{az.notPresent}</span>}
                </button>
              </li>
            ))}
            {!filtered.length && <li className={s.comboEmpty}>{needle ? az.teamNoMatches : az.noRoster}</li>}
            {/* type-a-name fallback for guests / mutual aid — only here does the keyboard appear */}
            <li>
              <button type="button" className={cx(s.comboOpt, s.comboType)} onClick={() => { closeMenu(); setTyping(true) }}>
                <Icon id="type" /><span>{az.typeName}</span>
              </button>
            </li>
          </ul>,
          document.body,
        )}
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
