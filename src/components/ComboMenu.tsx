import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefCallback } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { rankAbbr, rankLabel } from '../lib/rank'
import { matchesQuery, searchQuery } from '../lib/search'
import c from './ComboMenu.module.css'

/**
 * The tap-to-open picker every roster/value field in the app is made of — the machinery, not
 * the policy. It was hand-rolled twice (the global Combo and the Atemschutz PersonField) and the
 * two copies cross-referenced each other in their comments, which is the shape of duplication
 * that drifts: the maxHeight cap was fixed twice, months apart, and the search row's press wash
 * only ever reached one of them.
 *
 * The admin `Select` (admin/ui.tsx) deliberately stays out: it is keyboard-driven with
 * active-descendant navigation and is not portalled, so adopting this machinery would cost it
 * that. It is not a forgotten third call site.
 *
 * What lives here: open/typing/search state, the portalled menu and where it is put, dismissal,
 * the search row, the «nur Offiziere» row, the free-type escape and the empty row.
 * What does NOT: the trigger, and what an entry means. `Combo` (plain strings) and
 * `PersonField` (a person + their id) are thin policy layers on top — they own their own field
 * markup, because a 13px control on --fill-soft in a detail panel and a 15px control on
 * --surface in a modal are two skins, not one control pretending to be two.
 */

/** Where the portalled menu goes. Recomputed on scroll/resize while it is open. */
interface MenuPos { left: number; top: number; width: number; maxH: number; up: boolean }

/** Ceiling for the portalled menu. Not a target — the menu takes whatever room the trigger
 *  actually has (see `place`); this only stops it from becoming a curtain over the form it
 *  belongs to. ~9 name rows, which is enough that a Mannschaft rarely needs scrolling before
 *  the search narrows it. It used to be 252px in one copy and 280px in the other: on a
 *  full-height Rapport the roster then scrolled inside a short box with half the sheet empty
 *  underneath it. */
const MAX_MENU_H = 440

export interface ComboMenuState {
  open: boolean
  typing: boolean
  search: string
  setSearch: (v: string) => void
  officersOnly: boolean
  setOfficersOnly: (v: boolean) => void
  pos: MenuPos | null
  /** open ⇄ closed, from a tap on the trigger */
  toggle: () => void
  /** close AND forget the search — a menu that reopens still holding last time's search would
   *  look like a roster with people missing from it, which is the one way this control can lie */
  close: () => void
  /** leave the picker for the free-text field (guests, mutual aid, a Divera outage) */
  startTyping: () => void
  stopTyping: () => void
}

/**
 * The four elements the machinery has to reach, as CALLBACK refs: a policy layer ATTACHES them
 * (`ref={pickRef}`) and never reads them, so the hook hands back no `.current` at all.
 *
 * ⚠️ They come back beside the state rather than inside it, and the call site destructures them
 * on the spot. An object that holds a ref is a ref as far as react-hooks/refs is concerned, and
 * every later `combo.open` off it then reads as a render-time ref access — two dozen warnings
 * for something nobody is doing.
 */
export interface ComboMenuRefs {
  rootRef: RefCallback<HTMLDivElement>
  /** the trigger the menu is measured against — placed off ITS rect, not the root's */
  pickRef: RefCallback<HTMLButtonElement>
  /** the portalled <ul>; it counts as "inside" for the outside-tap close although it is not a
   *  DOM descendant of the field */
  menuRef: RefCallback<HTMLUListElement>
  /** the free-text input, focused the moment the user asks for it */
  inputRef: RefCallback<HTMLInputElement>
}

/**
 * All of the picker's state and every effect that keeps the portalled menu where it belongs.
 *
 * @param openTick imperative open: bump the number and the menu opens as if the trigger had
 *   been tapped, leaving free-type mode if that is where the field happened to be. The Fahrzeug
 *   header title falls through to its «Bezeichnung» field this way (ContextPanel).
 */
export function useComboMenu(openTick?: number): [ComboMenuState, ComboMenuRefs] {
  const [open, setOpen] = useState(false)
  // Roster-first: the field is a tap-to-open picker (no keyboard). The OS keyboard only appears
  // once the user explicitly chooses the free-type escape for a guest / mutual-aid name.
  const [typing, setTyping] = useState(false)
  // Narrowing by typing. A 66-person Mannschaft in a short menu is a handful of visible rows, so
  // finding somebody meant scrolling past sixty names with a gloved finger — the one complaint
  // about this picker after the 08.08. Einsatz. NOT auto-focused: this stays a tap-to-pick
  // control, and a keyboard that opens by itself covers the very list it is filtering.
  const [search, setSearch] = useState('')
  const [officersOnly, setOfficersOnly] = useState(false)
  const [pos, setPos] = useState<MenuPos | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const pick = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLUListElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  // stable identities, or React would detach and re-attach every element on every render
  const rootRef = useCallback((el: HTMLDivElement | null) => { root.current = el }, [])
  const pickRef = useCallback((el: HTMLButtonElement | null) => { pick.current = el }, [])
  const menuRef = useCallback((el: HTMLUListElement | null) => { menu.current = el }, [])
  const inputRef = useCallback((el: HTMLInputElement | null) => { input.current = el }, [])

  // entering type-mode is a deliberate user tap, so focusing here is allowed to open the keyboard
  useEffect(() => { if (typing) input.current?.focus() }, [typing])

  // opened from OUTSIDE (openTick): same entry as a tap on the trigger
  useEffect(() => { if (openTick) { setTyping(false); setSearch(''); setOpen(true) } }, [openTick])

  // Place the portalled menu under (or above, near the viewport bottom) the trigger. The menu is
  // portalled to <body> precisely so the scrolling sheet / overflow-hidden panel the field sits
  // in cannot clip it — fatal on a phone, where the lower fields sit right at the scroll edge.
  useEffect(() => {
    if (!open) return
    const place = () => {
      const el = pick.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      const up = below < 200 && above > below
      // TAKE the room that is there: `below`/`above` already hold the real space, so MAX_MENU_H
      // only has to stop the menu becoming a full-screen curtain over the form it belongs to.
      setPos({ left: r.left, top: up ? r.top : r.bottom, width: r.width, maxH: Math.max(140, Math.min(MAX_MENU_H, up ? above : below)), up })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place) }
  }, [open])

  // close on an outside tap — counting BOTH the trigger and the portalled menu as "inside".
  // 'pointerdown', not 'mousedown': touch synthesizes mousedown late or not at all, so tapping
  // outside would not reliably close the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!root.current?.contains(t) && !menu.current?.contains(t)) { setOpen(false); setSearch('') }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const close = () => { setOpen(false); setSearch('') }
  return [{
    open, typing, search, setSearch, officersOnly, setOfficersOnly, pos,
    toggle: () => { if (open) close(); else { setSearch(''); setOpen(true) } },
    close,
    startTyping: () => { close(); setTyping(true) },
    stopTyping: () => setTyping(false),
  }, { rootRef, pickRef, menuRef, inputRef }]
}

/** The skin. Two exist: global `.combo-*` (styles/06-contextpanel.css) and the Atemschutz
 *  module. Everything the two had in common is in ComboMenu.module.css instead and is not
 *  named here. */
export interface ComboMenuClasses {
  menu: string
  /** the fixed-position + z-index override the portal needs — see the style note on the <ul> */
  menuPortal: string
  opt: string
  /** modifier for the option that IS the current value (the roster picker marks none) */
  optOn?: string
  toggle: string
  toggleOn: string
  type: string
  empty: string
  group?: string
  groupHead?: string
}

/** One row of the menu. `value` is what `onPick` hands back, so a picker over plain strings and
 *  one over `{ name, personId }` are the same control with a different V. */
export interface ComboEntry<V> {
  key: string
  /** what the search matches on, and the row's visible text */
  label: string
  value: V
  selected?: boolean
  /** marks BEFORE the name — the presence dot, the Dienstgrad chip (<ComboRank>), «Gast» */
  lead?: ReactNode
  /** a soft note AFTER the name — «unter AS», «schon: Einsatzleiter», «nicht anwesend».
   *  A hint, never a block: the operator decides, they just should not have to pick first and
   *  find out afterwards, which is what the toast this replaced did. */
  note?: ReactNode
}

/** Section headers with their own options, rendered instead of the flat list. */
export interface ComboEntryGroup<V> { label: string; options: ComboEntry<V>[] }

/** The Dienstgrad chip — the same badge on both pickers, so it is drawn in one place. */
export function ComboRank({ rank }: { rank: string }) {
  return <span className={c.rank} title={rankLabel(rank)}>{rankAbbr(rank)}</span>
}

export function ComboMenu<V>({ state, menuRef, classes, copy, entries, groups, showSearch, limit, toggle, custom, onPick }: {
  state: ComboMenuState
  /** from `useComboMenu`'s refs — the <ul> the outside-tap close has to count as inside */
  menuRef: RefCallback<HTMLUListElement>
  classes: ComboMenuClasses
  /** every string this menu shows — passed in, because the two skins draw their words from
   *  different copy namespaces (appConfig.copy.combo vs copy.atemschutz) */
  copy: { search: string; empty: string; noMatches: string }
  entries: ComboEntry<V>[]
  groups?: ComboEntryGroup<V>[]
  /** below ~8 rows the whole list is on screen anyway and a search box is one more control
   *  between the finger and the name it came for. The two skins count different things (one the
   *  raw options, one the already-filtered ones), so the caller decides. */
  showSearch: boolean
  /** cap the rendered rows (the roster stops at 60); the empty row still counts every match */
  limit?: number
  /** the «nur Offiziere» row. Present only where it can select something: without Dienstgrade a
   *  filter whose single outcome is «keine Einträge» is worse than no filter. */
  toggle?: { label: string }
  /** the free-type escape — the only way the keyboard opens on this control */
  custom?: { label: string }
  onPick: (value: V) => void
}) {
  // one shared idea of what a query finds (lib/search): umlauts either way, one typo forgiven
  const needle = useMemo(() => searchQuery(state.search), [state.search])
  const match = (e: ComboEntry<V>) => !needle || matchesQuery(needle, e.label)
  const listed = entries.filter(match)
  const anyHit = groups ? groups.some((g) => g.options.some(match)) : listed.length > 0

  const row = (e: ComboEntry<V>) => (
    <li key={e.key}>
      <button type="button" className={cx(classes.opt, e.selected && classes.optOn)}
        onClick={() => { onPick(e.value); state.close() }}>
        {e.lead}
        <span className={c.name}>{e.label}</span>
        {e.note}
      </button>
    </li>
  )

  if (!state.open || state.typing || !state.pos) return null
  const { pos } = state
  return createPortal(
    <ul ref={menuRef} className={cx(classes.menu, classes.menuPortal)} role="listbox"
      // ⚠️ up-mode must NEUTRALISE the base class's `top: calc(100% + 4px)` — under
      // position:fixed that is viewport-bottom + 4, which (together with the inline `bottom`)
      // stretched the menu into a 0-height sliver OFF-screen whenever the trigger sat low.
      // That is the phone bottom sheet's "the dropdown does nothing".
      style={{ left: pos.left, width: pos.width, maxHeight: pos.maxH, ...(pos.up ? { top: 'auto', bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }) }}>
      {showSearch && (
        <li className={c.searchRow}>
          <span className={c.searchIcon} aria-hidden><Icon id="search" /></span>
          <input
            className={c.search} value={state.search} inputMode="search"
            placeholder={copy.search} aria-label={copy.search}
            onChange={(e) => state.setSearch(e.target.value)}
            // a stray Enter in a picker must not submit the form the picker sits in
            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
          />
          {state.search && (
            <button type="button" className={c.searchClear} aria-label={appConfig.copy.clear}
              onMouseDown={(e) => e.preventDefault()} onClick={() => state.setSearch('')}><Icon id="close" /></button>
          )}
        </li>
      )}
      {toggle && (
        <li>
          <button type="button" className={cx(classes.opt, classes.toggle, state.officersOnly && classes.toggleOn)}
            aria-pressed={state.officersOnly} onMouseDown={(e) => e.preventDefault()}
            onClick={() => state.setOfficersOnly(!state.officersOnly)}>
            {state.officersOnly && <Icon id="check" />}<span>{toggle.label}</span>
          </button>
        </li>
      )}
      {groups
        ? groups.map((g) => (
          <li key={g.label} className={classes.group}>
            <div className={classes.groupHead}>{g.label}</div>
            <ul>{g.options.filter(match).map(row)}</ul>
          </li>
        ))
        : (limit ? listed.slice(0, limit) : listed).map(row)}
      {!anyHit && <li className={classes.empty}>{needle ? copy.noMatches : copy.empty}</li>}
      {custom && (
        <li>
          <button type="button" className={cx(classes.opt, classes.type)} onClick={state.startTyping}>
            <Icon id="type" /><span>{custom.label}</span>
          </button>
        </li>
      )}
    </ul>,
    document.body,
  )
}
