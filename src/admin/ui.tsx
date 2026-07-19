import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { InfoTip } from './InfoTip'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

// Shared admin presentational primitives. One source of truth for the card, field,
// status-badge, metric and usage-bar shapes that every admin surface reuses — they
// were previously copy-pasted into ConfigEditor / DataView / SystemView and could
// drift. All styles live on the global tokens in app.css via admin.css class names.

/** Section card — the single container used by every admin view. `title` is optional:
 *  a single-card page leans on the page head (h1 + lede + tip) and renders the card as a
 *  plain panel, so the title/caption aren't duplicated. Multi-card pages title each card. */
export function Card({ id, title, caption, tip, children }: {
  id?: string
  title?: string
  caption?: string
  tip?: string
  children: ReactNode
}) {
  return (
    <section className="adm-card" id={id}>
      {(title || caption) && (
        <header className="adm-card-head">
          {title && (
            <h2 className="adm-card-title">
              {title}
              {tip && <InfoTip label={title} text={tip} />}
            </h2>
          )}
          {caption && <p className="adm-card-cap">{caption}</p>}
        </header>
      )}
      <div className="adm-card-body">{children}</div>
    </section>
  )
}

/** Labelled form field (label + optional hint/tip over the control). */
export function Field({ label, hint, tip, children }: {
  label: string
  hint?: string
  tip?: string
  children: ReactNode
}) {
  return (
    <label className="adm-field">
      <span className="adm-field-label">
        {label}
        {hint && <span className="adm-field-hint">{hint}</span>}
        {tip && <InfoTip label={label} text={tip} />}
      </span>
      {children}
    </label>
  )
}

/** Status pill: tone drives the dot + text colour. */
export function StatusBadge({ tone, label, state }: {
  tone: 'on' | 'off' | 'warn' | 'err'
  label: string
  state: string
}) {
  return (
    <span className={`adm-badge ${tone}`}>
      <span className="adm-badge-dot" aria-hidden />
      <span className="adm-badge-label">{label}</span>
      <span className="adm-badge-state">{state}</span>
    </span>
  )
}

/** One key/value metric row inside a card. */
export function Metric({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <div className="adm-sys-metric">
      <span className="adm-sys-metric-label">
        {label}
        {tip && <InfoTip label={label} text={tip} />}
      </span>
      <span className="adm-sys-metric-value adm-mono">{value}</span>
    </div>
  )
}

/** A labelled usage bar: filled fraction = used/total. */
export function UsageBar({ pctFilled, tone = 'blue' }: { pctFilled: number; tone?: 'blue' | 'amber' }) {
  return (
    <div className="adm-sys-bar" role="img" aria-label={fillTemplate(appConfig.copy.admin.usageBar.aria, { pct: Math.round(pctFilled) })}>
      <span className={`adm-sys-bar-fill ${tone}`} style={{ width: `${pctFilled}%` }} />
    </div>
  )
}

/** Teaching empty / load / error state. `message` is the headline; `hint` teaches the
 *  next action (e.g. which CLI command populates this surface); `action` is an optional
 *  button/link. `tone='err'` colours it as a failure. Replaces the bare inline
 *  `<div className="adm-state">…` blocks that were copy-pasted across every view. */
export function EmptyState({ message, hint, action, tone }: {
  message: string
  hint?: ReactNode
  action?: ReactNode
  tone?: 'err'
}) {
  return (
    <div className={`adm-empty${tone === 'err' ? ' err' : ''}`}>
      <p className="adm-empty-msg">{message}</p>
      {hint && <p className="adm-empty-hint">{hint}</p>}
      {action && <div className="adm-empty-action">{action}</div>}
    </div>
  )
}

export interface Column { key: string; label: string; num?: boolean }

/** Data table chrome — owns the scroll wrapper, the `.adm-table` element and the header
 *  row (built from `columns`, with right-alignment for numeric columns). The caller still
 *  renders the `<tr><td>…` body as `children`, so heterogeneous cells stay flexible; what
 *  was duplicated (wrapper + thead markup + alignment classes) now lives here once. */
export function Table({ columns, className, children }: { columns: Column[]; className?: string; children: ReactNode }) {
  return (
    <div className="adm-table-wrap">
      <table className={`adm-table${className ? ` ${className}` : ''}`}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.num ? 'adm-num' : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

/** Transient async-result chip (the "OK" / "Fehler" / "geleert" pills). Announces itself
 *  to screen readers via `role="status"` (the bare spans before were silent), and—when
 *  `onExpire` is given—auto-clears after `clearAfterMs` so a stale result can't linger.
 *  Parents that want the auto-clear must remount per result (pass a changing `key`), since
 *  the timer is armed on mount. */
export function ResultChip({ tone, children, onExpire, clearAfterMs = 6000 }: {
  tone: 'ok' | 'err' | 'off'
  children: ReactNode
  onExpire?: () => void
  clearAfterMs?: number
}) {
  useEffect(() => {
    if (!onExpire) return
    const t = window.setTimeout(onExpire, clearAfterMs)
    return () => window.clearTimeout(t)
  }, [onExpire, clearAfterMs])
  return (
    <span className={`adm-test-chip ${tone}`} role="status" aria-live="polite">{children}</span>
  )
}

/** Monospace copy area — tokens, URLs, curl examples. The whole surface is clickable. */
export function CopyChip({ value, display }: { value: string; display?: string }) {
  const C = appConfig.copy.admin.common
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked (http/permissions) — the text stays selectable */ }
  }
  return (
    <button type="button" className={`adm-copychip${copied ? ' copied' : ''}`}
      onClick={() => void copy()} title={copied ? C.copied : C.copy} aria-label={C.copy}>
      <code>{display ?? value}</code>
      <span className="adm-copy-btn" aria-hidden>
        <Icon id={copied ? 'check' : 'doc'} />
      </span>
    </button>
  )
}

/** Two-step inline confirm — replaces native window.confirm in the admin shell. First
 *  click swaps the button for the QUESTION plus explicit yes/cancel; auto-reverts after
 *  8 s untouched, so a stray click never leaves an armed destructive button behind. */
export function ConfirmButton({ label, question, danger, primary, disabled, onConfirm }: {
  label: ReactNode
  /** one short sentence naming the consequence (shown next to the yes/no pair) */
  question: string
  danger?: boolean
  primary?: boolean
  disabled?: boolean
  onConfirm: () => void
}) {
  const C = appConfig.copy.admin.common
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 8000)
    return () => window.clearTimeout(t)
  }, [armed])
  if (!armed) {
    return (
      <button type="button" disabled={disabled} onClick={() => setArmed(true)}
        className={`btn ${primary ? 'adm-save-btn' : danger ? 'adm-danger-btn' : 'adm-int-btn'}`}>
        {label}
      </button>
    )
  }
  return (
    <span className="adm-confirm" role="alertdialog" aria-label={question}>
      <span className="adm-confirm-q">{question}</span>
      <button type="button" className={`btn ${danger ? 'adm-danger-btn' : 'adm-save-btn'}`}
        onClick={() => { setArmed(false); onConfirm() }}>{C.confirmYes}</button>
      <button type="button" className="btn adm-int-btn" onClick={() => setArmed(false)}>{C.confirmNo}</button>
    </span>
  )
}

export interface MenuAction {
  label: string
  onClick: () => void
  /** off + non-clickable; `title` explains why (surfaced natively on the still-hoverable item). */
  disabled?: boolean
  title?: string
  /** destructive tint (e.g. Deaktivieren). */
  danger?: boolean
}

// Kebab (⋮) action menu — one compact trigger that opens a themed dropdown of row actions,
// replacing a wide row of inline buttons. Click-away and Esc close it. Keeps the actions
// legible (full labels in the list) while decluttering dense tables.
export function ActionMenu({ actions, ariaLabel, disabled }: {
  actions: MenuAction[]
  ariaLabel: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  // The list is PORTALLED to <body> with fixed positioning: rendered inline it forced the
  // table's scroll container to grow/scroll (feedback 2026-07-14). Flip upward when there
  // isn't room below so the last rows of a long table stay reachable.
  const [rect, setRect] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (!open) return
    setRect(ref.current?.getBoundingClientRect() ?? null)
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current && !ref.current.contains(target) && !listRef.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onAway = () => setOpen(false) // scroll/resize: cheap close beats stale coordinates
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onAway, true)
    window.addEventListener('resize', onAway)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onAway, true)
      window.removeEventListener('resize', onAway)
    }
  }, [open])

  const up = rect ? window.innerHeight - rect.bottom < 260 : false
  const listStyle: CSSProperties = rect
    ? {
        position: 'fixed',
        right: Math.max(8, window.innerWidth - rect.right),
        ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      }
    : { display: 'none' }

  return (
    <div className={`adm-menu${open ? ' open' : ''}`} ref={ref}>
      <button
        type="button"
        className="adm-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon id="more-vert" className="adm-menu-ic" />
      </button>
      {open && createPortal(
        <ul className="adm-menu-list adm-menu-portal" role="menu" ref={listRef} style={listStyle}>
          {actions.map((a, i) => (
            <li key={i} role="none">
              <button
                type="button"
                role="menuitem"
                className={`adm-menu-item${a.danger ? ' danger' : ''}`}
                disabled={a.disabled}
                title={a.title}
                onClick={() => { setOpen(false); a.onClick() }}
              >
                <span className="adm-menu-item-label">{a.label}</span>
                {/* a disabled item keeps its reason visible (native title never shows on a
                    disabled control) so the operator still learns WHY it's off. */}
                {a.disabled && a.title && <span className="adm-menu-reason">{a.title}</span>}
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  )
}

export interface SelectOption { value: string; label: string }

// Custom listbox dropdown — replaces the native <select> so the open list is themed
// (tokens, day/night) instead of the OS chrome. Keyboard-accessible: ↑/↓ move, Enter/␣
// open & choose, Esc closes; click-away dismisses. Same value/onChange contract as a
// native select, so it drops into existing controlled fields.
export function Select({ value, onChange, options, ariaLabel, mono }: {
  value: string
  onChange: (v: string) => void
  options: SelectOption[]
  ariaLabel?: string
  mono?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = options.find((o) => o.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, options, value])

  const choose = (v: string) => { onChange(v); setOpen(false) }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      else setActive((a) => Math.min(options.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (open) setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (open) choose(options[active].value)
      else setOpen(true)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className={`adm-select${open ? ' open' : ''}`} ref={ref}>
      <button
        type="button"
        className={`adm-select-btn${mono ? ' mono' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        <span className="adm-select-val">{current?.label ?? ''}</span>
        <Icon id="chevron-down" className="adm-select-chev" />
      </button>
      {open && (
        <ul className="adm-select-list" role="listbox" id={listId} aria-label={ariaLabel}>
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`adm-select-opt${o.value === value ? ' sel' : ''}${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(o.value) }}
            >
              <span className="adm-select-opt-label">{o.label}</span>
              {o.value === value && <Icon id="check" className="adm-select-tick" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
