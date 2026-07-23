import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { isOfficer, rankAbbr, rankLabel, rankOrder } from '../lib/rank'
import type { Person } from '../types'
import s from './Atemschutz.module.css'

export type Slot = { name: string; personId?: string }

// A combobox for a leader/AdF slot: pick from the Mannschaft dropdown (present crew first,
// already-assigned flagged) OR just type a name (guests, mutual aid, Divera outage). Selecting
// a person links the id; typing leaves it a manual snapshot. Replaces the old chip list.
export function PersonField({
  label, placeholder, value, onChange, personnel, legacyRoster, presentIds, assignedIds, usedIds, usedNames,
  rankFirst = false, officerFilter = false,
}: {
  label: string
  placeholder: string
  value: Slot
  onChange: (slot: Slot) => void
  personnel: Person[]
  legacyRoster: string[]
  presentIds: Set<string>
  assignedIds: Set<string>
  usedIds: Set<string>
  usedNames: Set<string>
  /** sort higher-ups first (rank → present → alpha) instead of the default present-first —
   *  used for the Einsatzleiter/officer pickers. */
  rankFirst?: boolean
  /** offer a "nur Offiziere" toggle that narrows the list to officer-rank people (the
   *  type-a-name fallback stays, so nobody is truly hidden — 3am tenet). */
  officerFilter?: boolean
}) {
  const az = appConfig.copy.atemschutz
  const [open, setOpen] = useState(false)
  const [officersOnly, setOfficersOnly] = useState(false)
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
  const q = value.name.trim().toLowerCase()

  type Opt = { key: string; name: string; personId?: string; present: boolean; assigned: boolean; rank?: string }
  const options: Opt[] = useMemo(() => {
    if (personnel.length) {
      return personnel
        // people already in ANOTHER active Trupp are excluded — one person can't be in two
        // Trupps at once (a typed-name fallback still works for guests/mutual aid)
        .filter((p) => p.active && !usedIds.has(p.id) && !usedNames.has(p.displayName) && !assignedIds.has(p.id))
        // officer filter is opt-in (officerFilter) AND toggled on — narrows to officer ranks
        .filter((p) => !(officerFilter && officersOnly) || isOfficer(p.rank))
        .map((p) => ({ key: p.id, name: p.displayName, personId: p.id, present: presentIds.has(p.id), assigned: false, rank: p.rank }))
        // rankFirst: higher-ups first (rank → present → alpha); default: present first, rank as tiebreaker
        .sort((a, b) =>
          rankFirst
            ? rankOrder(a.rank) - rankOrder(b.rank) || Number(b.present) - Number(a.present) || a.name.localeCompare(b.name, 'de')
            : Number(b.present) - Number(a.present) || rankOrder(a.rank) - rankOrder(b.rank) || a.name.localeCompare(b.name, 'de'),
        )
    }
    return legacyRoster.filter((n) => !usedNames.has(n)).map((n) => ({ key: n, name: n, present: false, assigned: false }))
  }, [personnel, legacyRoster, presentIds, assignedIds, usedIds, usedNames, rankFirst, officerFilter, officersOnly])

  // filter only while typing a free name; the roster list shows in full when just browsing
  const filtered = typing && q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options

  // entering type-mode is a deliberate user tap, so focusing here is allowed to open the keyboard
  useEffect(() => { if (typing) inputRef.current?.focus() }, [typing])

  // close the roster dropdown on an outside tap (the picker button isn't a focusable input) —
  // the portalled menu counts as "inside" alongside the trigger
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
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
      setPos({ left: r.left, top: up ? r.top : r.bottom, width: r.width, maxH: Math.max(140, Math.min(252, up ? above : below)), up })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place) }
  }, [open])

  const clear = () => { onChange({ name: '' }); setTyping(false) }

  return (
    <div className={s.field}>
      <span>{label}</span>
      <div className={s.combo} ref={rootRef}>
        {typing ? (
          <input
            ref={inputRef}
            value={value.name} placeholder={placeholder}
            onChange={(e) => onChange({ name: e.target.value })}
            onBlur={() => window.setTimeout(() => { setTyping(false); setOpen(false) }, 120)}
          />
        ) : (
          <button
            ref={pickRef}
            type="button" className={cx(s.comboPick, !value.name && s.comboPickEmpty)}
            aria-haspopup="listbox" aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
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
                  onClick={() => { onChange({ name: o.name, personId: o.personId }); setOpen(false) }}
                >
                  {o.personId && <span className={cx(s.comboDot, o.present ? s.comboDotPresent : s.comboDotOff)} />}
                  {o.rank && <span className={s.comboRank} title={rankLabel(o.rank)}>{rankAbbr(o.rank)}</span>}
                  <span className={s.comboName}>{o.name}</span>
                  {o.personId && !o.present && <span className={s.comboHint}>{az.notPresent}</span>}
                </button>
              </li>
            ))}
            {!filtered.length && <li className={s.comboEmpty}>{az.noRoster}</li>}
            {/* type-a-name fallback for guests / mutual aid — only here does the keyboard appear */}
            <li>
              <button type="button" className={cx(s.comboOpt, s.comboType)} onClick={() => { setOpen(false); setTyping(true) }}>
                <Icon id="type" /><span>{az.typeName}</span>
              </button>
            </li>
          </ul>,
          document.body,
        )}
      </div>
    </div>
  )
}
