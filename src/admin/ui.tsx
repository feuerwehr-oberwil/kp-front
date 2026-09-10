import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { apiDelete, apiGet, apiPost } from '../lib/api'
import { Icon } from '../lib/icons'
import { Menu } from '../lib/overlays'
import { InfoTip } from './InfoTip'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

// Shared admin presentational primitives. One source of truth for the card, field,
// status-badge, metric and usage-bar shapes that every admin surface reuses — they
// were previously copy-pasted into ConfigEditor / DataView / SystemView and could
// drift. All styles live on the global tokens in app.css via admin.css class names.

/** Short de-CH date for admin tables; null/invalid → "—". (Admin tooling is German-only,
 *  so the locale is fixed rather than following appConfig.locale.) */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('de-CH')
}

/** Date AND time, for lists where several entries share a day.
 *  ⚠️ The config history is exactly that: a Verwaltung session writes one kept document per
 *  save, so «15.8.2026» five times over is not an answer to «which one do I put back». */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('de-CH', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

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

/* ── the settings table ──────────────────────────────────────────────────────────────────────
   The Station pages are a LIST OF SETTINGS, and they were laid out as a stack of two-up form
   rows where every field carried a paragraph of prose under it. Fourteen doctrine numbers came
   to nearly three screens, and «what is the Alarmdruck here» meant scrolling past the answer.

   These four primitives are that same page as one strict table: Einstellung | Wert | Standard |
   ⓘ, one row per setting, uppercase group dividers, and the prose moved verbatim into the row's
   ⓘ (InfoTip — hover on a desktop, tap on an iPad, no layout shift either way).

   ⚠️ A GRID, NOT A <table>. A setting's label has to wrap its control to stay associated with
   it — that is what keeps every call site free of an id and `getByLabelText` working — and a
   <label> cannot span two <td>s. So each row is a `display: contents` <label> whose cells become
   the grid's own items. Same columns, same hairlines, association intact. Its cells therefore
   carry the row's borders and hover themselves (a `display: contents` box paints nothing), and
   the grid STRETCHES them to the row's height — otherwise one wrapping label leaves its
   neighbours' hairlines halfway up the row (admin.css · .adm-settings).                      */

/** One page's settings, as the strict table. `title`/`caption`/`tip` are the card head; a
 *  single-sheet page leans on the page head instead and passes none of them. */
export function SettingsSheet({ id, title, caption, tip, children }: {
  id?: string
  title?: string
  caption?: string
  tip?: string
  children: ReactNode
}) {
  const C = appConfig.copy.admin.common
  return (
    <section className="adm-card adm-sheet" id={id}>
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
      <div className="adm-settings">
        <div className="adm-set-head">
          <span className="adm-set-h">{C.colSetting}</span>
          <span className="adm-set-h">{C.colValue}</span>
          <span className="adm-set-h adm-set-h-std">{C.colStandard}</span>
          <span className="adm-set-h adm-set-h-info" aria-label={C.colInfo}>ⓘ</span>
        </div>
        {children}
      </div>
    </section>
  )
}

/** A divider row inside a sheet — the uppercase group heading (Funk · Atemschutz – Druck …).
 *  `tip` is where a group's own explanation goes, which is most of the prose this table
 *  replaced: it explained the GROUP, not any one field in it. */
export function SettingsGroup({ title, tip, action }: {
  title: string
  tip?: string
  /** the row's own control, right-aligned in the divider — a list editor's delete bin. This is
   *  what lets ONE RECORD of a list editor (an Alarmgruppe, a Fahrzeug, ein Formular) be a
   *  divider plus its fields as rows, instead of a card floating inside a table. */
  action?: ReactNode
}) {
  return (
    <p className="adm-set-grp">
      {title}
      {tip && <InfoTip label={title} text={tip} />}
      {action && <span className="adm-set-grp-act">{action}</span>}
    </p>
  )
}

/** A full-width row for what is not a setting: a validation message, a worked example, an offer,
 *  or a list editor that owns its own shape (Alarmgruppen, Fahrzeuge, Formulare & Links).
 *  `tone='warn'` is the amber «noch nicht gespeichert» band. */
export function SettingsNote({ tone, children }: { tone?: 'warn'; children: ReactNode }) {
  return <div className={`adm-set-note${tone === 'warn' ? ' warn' : ''}`}>{children}</div>
}

/** Value + shipped default in the one form the Standard column prints them in. A boolean is a
 *  Ja/Nein there, because «true» is not a word anybody set. */
function readable(v: string | number | boolean): string {
  const C = appConfig.copy.admin.common
  return typeof v === 'boolean' ? (v ? C.standardOn : C.standardOff) : String(v)
}

/**
 * The Standard column's cell: «Standard 100 · geändert», or null when there is nothing to say.
 *
 * ⚠️ The column is EMPTY on most rows on purpose. It answers one question — «is this still what
 * ships?» — so it speaks only when the answer is no. Printing «Standard 100» on every row would
 * put the wall of text back, one column to the right. Two cases are silence, not omission:
 * an unset value (the document stores nothing, so the setting IS running on the default), and a
 * setting with no default a reader could act on (a station's own map centre, its Kommandant).
 */
export function standardNote(
  current: string | number | boolean | null | undefined,
  standard: string | number | boolean | null | undefined,
): string | null {
  if (current == null || current === '' || standard == null) return null
  if (readable(current) === readable(standard)) return null
  return fillTemplate(appConfig.copy.admin.common.standardChanged, { value: readable(standard) })
}

/**
 * One setting: label | control | Standard | ⓘ.
 *
 * ⚠️ The rule, so that two controls that look alike are not laid out differently: EVERY setting
 * reads label-left / value-right. A control that does not fit the Wert column on its own takes
 * `span` — the Wert AND Standard columns, wrapping inside them, with the ⓘ still in its own
 * column — and that is the only exception there is. For swatch rows and chip lists, which used
 * to scroll sideways; for a long URL and its token chips; for a textarea.
 *
 * ⚠️ There used to be a third shape, `stack`, that put the control on its own full-width line
 * UNDER its label — the Textbausteine, «Einleitung in der Hilfe», the prefill-URL editors. With
 * a Wert column wide enough to type a URL in (admin.css · .adm-settings) it bought nothing and
 * cost the one thing the table exists for: a page where the eye finds every value in the same
 * place. It is gone; a multi-line control belongs in `span`, and several boxes in one cell stack
 * inside a `.adm-set-col` wrapper rather than by leaving the columns.
 */
export function SettingRow({ label, hint, tip, standard, span, children }: {
  label: string
  /** the rare qualifier that belongs ON the label rather than in the ⓘ */
  hint?: string
  /** the explanation, verbatim from the copy catalogue — this is where the prose went */
  tip?: string
  /** `standardNote(…)`, or null while the value is the shipped default */
  standard?: string | null
  span?: boolean
  children: ReactNode
}) {
  // ⚠️ Source order IS column order: the cells are the grid's own items (the row is
  // `display: contents`), so they are placed in the order they are written here.
  return (
    <label className={`adm-set-row${span ? ' span' : ''}`}>
      <span className="adm-set-lbl">
        <span className="adm-set-name">{label}</span>
        {hint && <span className="adm-field-hint">{hint}</span>}
      </span>
      <span className="adm-set-ctl">{children}</span>
      <span className="adm-set-std">{standard}</span>
      <span className="adm-set-info">
        {tip && <InfoTip label={label} text={tip} />}
      </span>
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

/** A labelled usage bar: filled fraction = used/total.
 *
 *  ⚠️ Sized by `width`, not `transform: scaleX()`. Scaling collapsed the fill to nothing at
 *  0 % — where the CSS `min-width: 2px` is meant to leave a sliver saying «this bar is empty»,
 *  not «this bar is missing» — and it stretched the pill's `border-radius` with the element, so
 *  the cap came out squashed at every value in between. */
export function UsageBar({ pctFilled, tone = 'blue' }: { pctFilled: number; tone?: 'blue' | 'amber' }) {
  const pct = Math.max(0, Math.min(100, pctFilled))
  return (
    <div className="adm-sys-bar" role="img" aria-label={fillTemplate(appConfig.copy.admin.usageBar.aria, { pct: Math.round(pctFilled) })}>
      <span className={`adm-sys-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
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

/**
 * A tinted inline panel that names a CONSEQUENCE and puts the fix right next to it.
 *
 * Two callers, deliberately one shape: «ohne Alarm-Webhook-Secret bleibt der Eingang zu» on the
 * Alarmierung page, and «Kartenmitte gesetzt — Suchbereich daraus übernehmen?» in the Adresssuche
 * card. Both are the same move: the page knows something the operator does not, and the button
 * that settles it belongs in the same box as the sentence rather than three cards away.
 *
 * `tone='blue'` is an OFFER (one tap and it is done), amber a consequence already in force.
 * Never red — nothing offered here is destructive. `preview` shows the value that WOULD be
 * written, because an offer nobody can read before accepting is a dice roll.
 */
export function Offer({ tone = 'amber', icon, title, body, preview, children }: {
  tone?: 'amber' | 'blue'
  icon: string
  title: string
  body: string
  preview?: string
  children?: ReactNode
}) {
  return (
    <div className={`adm-offer${tone === 'blue' ? ' blue' : ''}`}>
      <Icon id={icon} className="adm-offer-ic" />
      <div className="adm-offer-txt">
        <span className="adm-offer-t">{title}</span>
        <span className="adm-offer-b">{body}</span>
        {preview && <p className="adm-offer-preview">{preview}</p>}
        {children && <div className="adm-offer-acts">{children}</div>}
      </div>
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
 *  8 s untouched, so a stray click never leaves an armed destructive button behind.
 *
 *  `className` + `ariaLabel` exist for the icon-only bins in the config editors
 *  (ConfigSections · `.adm-formlink-x`): same two-step, but the trigger has to keep the row's
 *  own shape and its accessible name, because there is no visible label to read. */
export function ConfirmButton({ label, question, danger, primary, disabled, className, ariaLabel, onConfirm }: {
  label: ReactNode
  /** one short sentence naming the consequence (shown next to the yes/no pair) */
  question: string
  danger?: boolean
  primary?: boolean
  disabled?: boolean
  /** replaces the default button classes — for triggers that are not a `.btn` */
  className?: string
  /** the trigger's accessible name; required whenever `label` is an icon */
  ariaLabel?: string
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
        title={ariaLabel} aria-label={ariaLabel}
        className={className ?? `btn ${primary ? 'adm-save-btn' : danger ? 'adm-danger-btn' : 'adm-int-btn'}`}>
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
  // Base UI's Positioner handles the portal + collision-aware flip-up that this used to hand-roll
  // (getBoundingClientRect + a 260px threshold + scroll/resize close), and adds keyboard nav.
  // The .adm-menu wrapper stays for layout (.adm-members-actions-col .adm-menu); the open trigger
  // styles off [data-popup-open] (Base UI) instead of the old .adm-menu.open class.
  return (
    <span className="adm-menu">
      <Menu
        trigger={
          <button type="button" className="adm-menu-btn" aria-label={ariaLabel} disabled={disabled}>
            <Icon id="more-vert" className="adm-menu-ic" />
          </button>
        }
        items={actions.map((a) => ({
          label: <span className="adm-menu-item-label">{a.label}</span>,
          onClick: a.onClick,
          danger: a.danger,
          disabled: a.disabled,
          // a disabled item keeps its reason visible (native title never shows on a disabled control)
          reason: a.title,
        }))}
        popupClassName="adm-menu-list adm-menu-portal"
        itemClassName={(danger) => `adm-menu-item${danger ? ' danger' : ''}`}
        reasonClassName="adm-menu-reason"
      />
    </span>
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
    // 'pointerdown', not 'mousedown': touch synthesizes mousedown late or not at all,
    // so tapping outside would not reliably close the listbox
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
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
        <Icon id="chevron-down" className="adm-select-chev chev" />
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
              // choose on pointerdown: same blur-guard as the old onMouseDown (preventDefault
              // keeps focus on the trigger), but it fires reliably for touch too
              onPointerDown={(e) => { e.preventDefault(); choose(o.value) }}
              // …and on click for drivers that never send pointerdown (jsdom's fireEvent).
              // No double-fire in a browser: choosing unmounts the row, so its click never lands.
              onClick={() => choose(o.value)}
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

/**
 * Type, or pick a name off a list — the combo the Kommandant field wears (04.09.).
 *
 * ⚠️ Why this and not `Select`. The 03.09. Rapport printed the Kommandant as «Paul Hauptmann»
 * beside an Einsatzleiter called «Hauptmann Paul» — the same person, written in two orders,
 * because this was a free text box while the whole Personalstamm is «Nachname Vorname». A plain
 * `Select` would fix the order but shut out the two cases a station really has: a config edited
 * before any roster exists, and a Kommandant who is not in this station's own list. So the
 * roster is the FIRST answer and free text is the last one, which is exactly how the Rapport
 * already asks for the Einsatzleiter.
 *
 * ⚠️ It never materialises a value on render. Empty is the honest starting state — this page
 * PUTs the whole config document, so a name that appeared by itself would be saved as a decision
 * nobody made (the same trap `resolveLocaleChoice` exists for one field up).
 */
export function NameCombo({ value, onChange, options, placeholder, ariaLabel }: {
  value: string
  onChange: (v: string) => void
  /** the roster, in ITS OWN order and spelling — empty means «no list», and the control is
   *  then a plain text field with no list to open */
  options: string[]
  placeholder?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listId = useId()
  const q = value.trim().toLowerCase()
  // an exact hit is not a suggestion — once the field says what the list says, the popup has
  // nothing left to offer and would just sit over the next field
  const matches = options.filter((o) => o.toLowerCase() !== q && (!q || o.toLowerCase().includes(q))).slice(0, 8)
  const show = open && matches.length > 0

  useEffect(() => {
    if (!show) return
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [show])

  const choose = (v: string) => { onChange(v); setOpen(false) }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(matches.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    // ⚠️ Enter only commits a HIGHLIGHTED suggestion. Otherwise it must leave the typed text
    // alone: the free-text case is the whole reason this is not a Select, and silently swapping
    // what somebody typed for the nearest roster name is the failure it exists to avoid.
    else if (e.key === 'Enter' && show && matches[active]) { e.preventDefault(); choose(matches[active]) }
    else if (e.key === 'Escape') setOpen(false)
  }

  return (
    <div className={`adm-select adm-combo${show ? ' open' : ''}`} ref={ref}>
      <input
        className="adm-input" type="text" value={value} placeholder={placeholder} aria-label={ariaLabel}
        role="combobox" aria-expanded={show} aria-controls={listId} aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); setActive(0); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {show && (
        <ul className="adm-select-list" role="listbox" id={listId} aria-label={ariaLabel}>
          {matches.map((o, i) => (
            <li
              key={o} role="option" aria-selected={o === value}
              className={`adm-select-opt${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onPointerDown={(e) => { e.preventDefault(); choose(o) }}
              onClick={() => choose(o)}
            >
              <span className="adm-select-opt-label">{o}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// --- Secret tokens -------------------------------------------------------------------
//
// Three admin surfaces manage a shared secret with the backend: the Statistik-Export token,
// the Einsatz-Link minting key and the Erfassungs-Poster secret. All three are the same
// object — one value the server holds, handed out ONCE when it is minted, rotated to cut off
// every consumer at a stroke, deleted as the off switch (fail-closed: no secret, no surface).
// They were three hand-written copies of the same hook and the same card, differing in an
// endpoint prefix, a copy namespace and one example string.

/** What the backend answers: whether a secret exists, plus the value itself — only in the
 *  reply to a rotation. A later GET says `configured: true` and no token, which is why the
 *  card shows the value once and never again. */
export interface SecretState { configured: boolean; token?: string | null }

export interface SecretApi {
  /** null while the first read is in flight — the card renders nothing until then */
  state: SecretState | null
  busy: boolean
  result: { tone: 'ok' | 'err'; text: string } | null
  clearResult: () => void
  /** Say something on the card's own result chip. For the extra actions a surface hangs on a
   *  secret — «Poster konnte nicht erzeugt werden» belongs in the same slot, last one wins. */
  report: (tone: 'ok' | 'err', text: string) => void
  rotate: () => Promise<void>
  disable: () => Promise<void>
}

/**
 * The get / rotate / disable trio behind a secret-token card.
 *
 * `basePath` is the backend resource — `/api/stats/secret`, with `POST <basePath>/rotate` and
 * `DELETE <basePath>`. `said` is the caller's own copy: a rotated poster and a rotated export
 * token are not the same sentence, so nothing here holds a string.
 *
 * A failed READ reports «not configured» rather than an error: that is what the surface does
 * with a missing secret anyway, and an admin card showing «fehlgeschlagen» for a secret nobody
 * has set yet reads as a broken deployment.
 */
export function useSecret(basePath: string, said: { rotated: string; disabled: string; failed: string }): SecretApi {
  const [state, setState] = useState<SecretState | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const reload = useCallback(async () => {
    try { setState(await apiGet<SecretState>(basePath)) } catch { setState({ configured: false }) }
  }, [basePath])
  useEffect(() => { void reload() }, [reload])

  const rotate = async () => {
    setBusy(true)
    try {
      setState(await apiPost<SecretState>(`${basePath}/rotate`, {}))
      setResult({ tone: 'ok', text: said.rotated })
    } catch { setResult({ tone: 'err', text: said.failed }) } finally { setBusy(false) }
  }

  const disable = async () => {
    setBusy(true)
    try {
      await apiDelete(basePath)
      setState({ configured: false })
      setResult({ tone: 'ok', text: said.disabled })
    } catch { setResult({ tone: 'err', text: said.failed }) } finally { setBusy(false) }
  }

  return {
    state, busy, result,
    clearResult: () => setResult(null),
    report: (tone, text) => setResult({ tone, text }),
    rotate,
    disable,
  }
}

/** Everything the card says. Passed in from the caller's own copy namespace
 *  (admin.statistik / admin.einsatzlink), so this component owns no strings. */
export interface SecretCardCopy {
  body: string
  stateLabel: string
  stateOn: string
  stateOff: string
  /** what the value IS, in front of it on the chip: «Token» / «Schlüssel» */
  tokenLabel: string
  exampleLabel: string
  docsLink: string
  enableBtn: string
  rotateBtn: string
  rotateMsg: string
  disableBtn: string
  disableMsg: string
  hint: string
}

/**
 * The card a secret-token surface is: status, the value while it is being handed out, a
 * copyable example of using it, and the actions in consequence order — enable, rotate,
 * disable last.
 *
 * `example` builds the one line that is genuinely per-surface (a curl command, a link shape)
 * from the freshly minted token; it is only asked for while there is one to show.
 */
export function SecretCard({ secret, copy, docsUrl, example }: {
  secret: SecretApi
  copy: SecretCardCopy
  docsUrl: string
  example: (token: string) => string
}) {
  const { state, busy, result, clearResult, rotate, disable } = secret
  if (state === null) return null
  return (
    <Card>
      <p className="adm-card-cap">{copy.body}</p>
      <div className="adm-cap-rows">
        <div className="adm-cap-status">
          <StatusBadge tone={state.configured ? 'on' : 'off'} label={copy.stateLabel} state={state.configured ? copy.stateOn : copy.stateOff} />
        </div>
        {state.token && <CopyChip value={state.token} display={`${copy.tokenLabel}: ${state.token}`} />}
        {state.token && (
          <div className="adm-cap-example">
            <p className="adm-card-cap">{copy.exampleLabel} — <a href={docsUrl} target="_blank" rel="noreferrer">{copy.docsLink}</a></p>
            <CopyChip value={example(state.token)} />
          </div>
        )}
      </div>
      <div className="adm-actions">
        {state.configured ? (
          <>
            <ConfirmButton label={copy.rotateBtn} question={copy.rotateMsg} primary disabled={busy} onConfirm={() => void rotate()} />
            <ConfirmButton label={copy.disableBtn} question={copy.disableMsg} danger disabled={busy} onConfirm={() => void disable()} />
          </>
        ) : (
          <button type="button" className="btn adm-save-btn" disabled={busy} onClick={() => void rotate()}>{copy.enableBtn}</button>
        )}
        {result && <ResultChip tone={result.tone} onExpire={clearResult}>{result.text}</ResultChip>}
      </div>
      <p className="adm-card-cap">{copy.hint}</p>
    </Card>
  )
}
