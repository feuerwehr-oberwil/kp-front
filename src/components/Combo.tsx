import { useMemo } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { isOfficer, rankOrder } from '../lib/rank'
import { ComboMenu, ComboRank, useComboMenu, type ComboEntry, type ComboMenuClasses } from './ComboMenu'

/** The panel/wizard skin — 13px type on --fill-soft, global `.combo-*` in 06-contextpanel.css. */
const CLASSES: ComboMenuClasses = {
  menu: 'combo-menu', menuPortal: 'combo-menu-portal',
  opt: 'combo-opt', optOn: 'on',
  toggle: 'combo-toggle', toggleOn: 'on',
  type: 'combo-type', empty: 'combo-empty',
  group: 'combo-group', groupHead: 'combo-group-head',
}

/**
 * A custom dropdown over plain strings, styled like the Atemschutz Trupp picker (tap-to-open
 * menu, no native select chrome). The portalled menu and everything in it comes from
 * `ComboMenu`; this file is the string policy — what the options are, how they sort, and the
 * field itself. Optionally offers a free-type escape ("… eingeben") for non-listed values.
 *
 * `value=""` + a non-empty placeholder makes it a pure prefill picker (it shows the placeholder
 * and never retains a selection, since the parent keeps value empty).
 */
export function Combo({ value, options, groups, placeholder, searchPlaceholder, allowCustom, customLabel = appConfig.copy.combo.customDefault, clearable = true, officerFilter, rankOf, statusOf, openTick, onInput, onChange }: {
  value: string
  options: string[]
  /** optional grouped rendering: section headers with their own options. When set, the menu
   *  renders these groups instead of the flat `options` list (which still backs value matching). */
  groups?: { label: string; options: string[] }[]
  placeholder: string
  /** the OPEN menu's own search row placeholder. Defaults to `copy.combo.searchPlaceholder`
   *  («Person suchen …») — right for the roster pickers this control was built for, wrong for a
   *  picker over anything else (material, unit, Quelle …), so a non-roster caller passes its own. */
  searchPlaceholder?: string
  allowCustom?: boolean
  customLabel?: string
  clearable?: boolean
  /** rank-aware roster picker: sort officers first and offer a "nur Offiziere" filter toggle.
   *  Needs `rankOf` to resolve an option (person name) to its rank key. Ignored with `groups`. */
  officerFilter?: boolean
  rankOf?: (name: string) => string | undefined
  /** What is already known about this person, shown ON the entry: «unter AS», «Magazin»,
   *  «nicht anwesend». A picker that lists sixty names and says nothing about any of them makes
   *  the operator pick first and find out afterwards — which is what the toast used to do. */
  statusOf?: (name: string) => { label: string; tone?: 'warn' | 'muted' | 'info' } | undefined
  /** Imperative open: bump the number and the menu opens as if the trigger had been tapped.
   *  The Fahrzeug header title falls through to its «Bezeichnung» field this way (ContextPanel). */
  openTick?: number
  /** Free typing, keystroke by keystroke — `onChange` then fires ONCE, when the field is left.
   *  ⚠️ Without it every letter is a finished value, which is fine for a text field and wrong
   *  for a person: a typed Gast is recorded on the Anwesenheit the moment the name is committed,
   *  and «Muster Felix» typed letter by letter would put thirteen people on the list. */
  onInput?: (v: string) => void
  onChange: (v: string) => void
}) {
  const [combo, { rootRef, pickRef, menuRef, inputRef }] = useComboMenu(openTick)

  // A filter that can only ever empty the list is worse than no filter: without Dienstgrade
  // (no personnel source, or a roster that carries none) «nur Offiziere» offered a toggle
  // whose single outcome was «keine Einträge». Offer it only where it can select something.
  const hasOfficers = useMemo(
    () => !!officerFilter && !!rankOf && !groups && options.some((o) => isOfficer(rankOf(o))),
    [options, officerFilter, rankOf, groups],
  )
  // rank-aware view of the flat options: officers first (rank asc), then alpha; optional filter
  // to officers only. A stale `officersOnly` from a roster that HAD officers is ignored once
  // they are gone — otherwise the list empties with the un-filter toggle no longer rendered.
  const shown = useMemo(() => {
    if (!officerFilter || !rankOf) return options
    const list = combo.officersOnly && hasOfficers ? options.filter((o) => isOfficer(rankOf(o))) : options
    return [...list].sort((a, b) => rankOrder(rankOf(a)) - rankOrder(rankOf(b)) || a.localeCompare(b, 'de'))
  }, [options, officerFilter, rankOf, combo.officersOnly, hasOfficers])

  // rank-aware picker: show the Dienstgrad chip next to each name (same badge as the Atemschutz
  // PersonField), so the officers-first sorting is legible at a glance
  const entry = (o: string): ComboEntry<string> => {
    const rank = officerFilter && rankOf ? rankOf(o) : undefined
    const status = statusOf?.(o)
    return {
      key: o, label: o, value: o, selected: o === value,
      lead: rank ? <ComboRank rank={rank} /> : undefined,
      note: status ? <span className={`combo-opt-status${status.tone ? ` ${status.tone}` : ''}`}>{status.label}</span> : undefined,
    }
  }

  if (combo.typing) {
    return (
      <div className="combo">
        <input ref={inputRef} className="combo-input" value={value} placeholder={placeholder}
          onChange={(e) => (onInput ?? onChange)(e.target.value)}
          onBlur={() => { combo.stopTyping(); if (onInput) onChange(value) }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </div>
    )
  }
  return (
    <div className="combo" ref={rootRef}>
      <button ref={pickRef} type="button" className={`combo-pick${value ? '' : ' empty'}`} aria-haspopup="listbox" aria-expanded={combo.open} onClick={combo.toggle}>
        <span className="combo-pick-name">{value || placeholder}</span>
        <span className="combo-chev" aria-hidden><Icon id="chevron-down" className="chev" /></span>
      </button>
      {clearable && value && (
        <button type="button" className="combo-clear" aria-label={appConfig.copy.clear} onMouseDown={(e) => e.preventDefault()} onClick={() => onChange('')}><Icon id="close" /></button>
      )}
      <ComboMenu
        state={combo}
        menuRef={menuRef}
        classes={CLASSES}
        copy={{
          search: searchPlaceholder ?? appConfig.copy.combo.searchPlaceholder,
          empty: appConfig.copy.combo.empty,
          noMatches: appConfig.copy.combo.noMatches,
        }}
        entries={shown.map(entry)}
        groups={groups?.map((g) => ({ label: g.label, options: g.options.map(entry) }))}
        // below this the whole list is on screen anyway — counted on the RAW options, so the
        // box does not vanish under the operator when «nur Offiziere» narrows the list
        showSearch={(groups ? groups.reduce((n, g) => n + g.options.length, 0) : options.length) > 8}
        toggle={hasOfficers ? { label: appConfig.copy.combo.officersOnly } : undefined}
        custom={allowCustom ? { label: customLabel } : undefined}
        onPick={onChange}
      />
    </div>
  )
}
