import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { isOfficer, rankAbbr, rankLabel, rankOrder } from '../lib/rank'

/**
 * A custom dropdown styled like the Atemschutz Trupp picker (tap-to-open menu, no native select
 * chrome). The menu is PORTALLED to <body> with fixed positioning so it isn't clipped by a
 * scrollable/overflow-hidden container (e.g. the detail panel) and the last option is never cut
 * off. Optionally offers a free-type escape ("… eingeben") for non-listed values.
 *
 * `value=""` + a non-empty placeholder makes it a pure prefill picker (it shows the placeholder and
 * never retains a selection, since the parent keeps value empty).
 */
export function Combo({ value, options, groups, placeholder, allowCustom, customLabel = appConfig.copy.combo.customDefault, clearable = true, officerFilter, rankOf, onChange }: {
  value: string
  options: string[]
  /** optional grouped rendering: section headers with their own options. When set, the menu
   *  renders these groups instead of the flat `options` list (which still backs value matching). */
  groups?: { label: string; options: string[] }[]
  placeholder: string
  allowCustom?: boolean
  customLabel?: string
  clearable?: boolean
  /** rank-aware roster picker: sort officers first and offer a "nur Offiziere" filter toggle.
   *  Needs `rankOf` to resolve an option (person name) to its rank key. Ignored with `groups`. */
  officerFilter?: boolean
  rankOf?: (name: string) => string | undefined
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [officersOnly, setOfficersOnly] = useState(false)
  const [typing, setTyping] = useState(false)

  // rank-aware view of the flat options: officers first (rank asc), then alpha; optional filter
  // to officers only. Only used when officerFilter is set (leadership symbols) and not grouped.
  const shown = useMemo(() => {
    if (!officerFilter || !rankOf) return options
    const list = officersOnly ? options.filter((o) => isOfficer(rankOf(o))) : options
    return [...list].sort((a, b) => rankOrder(rankOf(a)) - rankOrder(rankOf(b)) || a.localeCompare(b, 'de'))
  }, [options, officerFilter, rankOf, officersOnly])
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number; up: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const pickRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (typing) inputRef.current?.focus() }, [typing])

  // position the portalled menu under (or above, near the viewport bottom) the trigger
  useEffect(() => {
    if (!open) return
    const place = () => {
      const el = pickRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - 12
      const above = r.top - 12
      const up = below < 200 && above > below
      setPos({ left: r.left, top: up ? r.top : r.bottom, width: r.width, maxH: Math.max(140, Math.min(280, up ? above : below)), up })
    }
    place()
    const onScroll = () => place()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll) }
  }, [open])

  // close on an outside tap — counting BOTH the trigger and the portalled menu as "inside"
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  if (typing) {
    return (
      <div className="combo">
        <input ref={inputRef} className="combo-input" value={value} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTyping(false)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </div>
    )
  }
  return (
    <div className="combo" ref={rootRef}>
      <button ref={pickRef} type="button" className={`combo-pick${value ? '' : ' empty'}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="combo-pick-name">{value || placeholder}</span>
        <span className="combo-chev" aria-hidden><Icon id="chevron-down" /></span>
      </button>
      {clearable && value && (
        <button type="button" className="combo-clear" aria-label={appConfig.copy.clear} onMouseDown={(e) => e.preventDefault()} onClick={() => onChange('')}><Icon id="close" /></button>
      )}
      {open && pos && createPortal(
        <ul ref={menuRef} className="combo-menu combo-menu-portal" role="listbox"
          // up-mode must NEUTRALISE the base class's `top: calc(100% + 4px)` — under
          // position:fixed that's viewport-bottom + 4, which (with the inline `bottom`)
          // stretched the menu into a 0-height sliver OFF-screen whenever the trigger sat
          // low (the phone bottom sheet — "the dropdown does nothing")
          style={{ left: pos.left, width: pos.width, maxHeight: pos.maxH, ...(pos.up ? { top: 'auto', bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }) }}>
          {officerFilter && rankOf && !groups && (
            <li>
              <button type="button" className={`combo-opt combo-toggle${officersOnly ? ' on' : ''}`}
                aria-pressed={officersOnly} onMouseDown={(e) => e.preventDefault()}
                onClick={() => setOfficersOnly((v) => !v)}>
                {officersOnly && <Icon id="check" />}<span>{appConfig.copy.combo.officersOnly}</span>
              </button>
            </li>
          )}
          {groups
            ? groups.map((g) => (
              <li key={g.label} className="combo-group">
                <div className="combo-group-head">{g.label}</div>
                <ul>
                  {g.options.map((o) => (
                    <li key={o}>
                      <button type="button" className={`combo-opt${o === value ? ' on' : ''}`} onClick={() => { onChange(o); setOpen(false) }}>
                        <span className="combo-opt-name">{o}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))
            : shown.map((o) => {
              // rank-aware picker: show the Dienstgrad chip next to each name (same badge as the
              // Atemschutz PersonField), so the officers-first sorting is legible at a glance
              const rank = officerFilter && rankOf ? rankOf(o) : undefined
              return (
                <li key={o}>
                  <button type="button" className={`combo-opt${o === value ? ' on' : ''}`} onClick={() => { onChange(o); setOpen(false) }}>
                    {rank && <span className="combo-rank" title={rankLabel(rank)}>{rankAbbr(rank)}</span>}
                    <span className="combo-opt-name">{o}</span>
                  </button>
                </li>
              )
            })}
          {!(groups ? options.length : shown.length) && <li className="combo-empty">{appConfig.copy.combo.empty}</li>}
          {allowCustom && (
            <li>
              <button type="button" className="combo-opt combo-type" onClick={() => { setOpen(false); setTyping(true) }}>
                <Icon id="type" /><span>{customLabel}</span>
              </button>
            </li>
          )}
        </ul>,
        document.body,
      )}
    </div>
  )
}
