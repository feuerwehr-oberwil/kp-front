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
