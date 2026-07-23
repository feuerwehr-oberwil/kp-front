import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch, ApiError } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { ActionMenu, Select, fmtDate } from './ui'

// ─── types ───────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string
  username: string
  display_name: string
  role: 'editor' | 'viewer'
  color: string | null
  is_active: boolean
  created_at: string
  last_login: string | null
  /** login starts in the Einsatzleiter view (frontend default; device-overridable) */
  el_view_default: boolean
}

const PIN_LEN = 6 // mirrors backend settings.pin_length

// ─── helpers ───────────────────────────────────────────────────────────────

function isValidPin(pin: string): boolean {
  return pin.length === PIN_LEN && /^\d+$/.test(pin)
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.detail
  return appConfig.copy.admin.common2.unknownError
}

function roleLabel(role: string): string {
  const C = appConfig.copy.admin.members
  return role === 'editor' ? C.roleEditor : C.roleViewer
}

// ─── add-member form ───────────────────────────────────────────────────────

function AddMemberForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer')
  const [color, setColor] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const reset = () => {
    setUsername(''); setDisplayName(''); setRole('viewer'); setColor(''); setPin('')
    setErr(null)
  }

  const C = appConfig.copy.admin.members
  const valid =
    username.trim().length > 0 &&
    displayName.trim().length > 0 &&
    isValidPin(pin)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setErr(null)
    try {
      await apiPost('/api/auth/users', {
        username: username.trim(),
        display_name: displayName.trim(),
        role,
        color: color.trim() || null,
        pin,
      })
      reset()
      setOpen(false)
      onCreated()
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="adm-members-addbar">
        <button type="button" className="btn adm-int-btn" onClick={() => setOpen(true)}>
          {C.add}
        </button>
      </div>
    )
  }

  return (
    <form className="adm-card adm-members-form" onSubmit={submit}>
      <header className="adm-card-head">
        <h2 className="adm-card-title">{C.add}</h2>
        <p className="adm-card-cap">
          {fillTemplate(C.addCaption, { n: PIN_LEN })}
        </p>
      </header>
      <div className="adm-card-body">
        <div className="adm-row-2">
          <label className="adm-field">
            <span className="adm-field-label">{C.username}</span>
            <input
              className="adm-input adm-input-mono"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              placeholder={C.usernamePlaceholder}
            />
          </label>
          <label className="adm-field">
            <span className="adm-field-label">{C.displayName}</span>
            <input
              className="adm-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="off"
              placeholder={C.displayNamePlaceholder}
            />
          </label>
        </div>
        <div className="adm-row-2">
          <div className="adm-field">
            <span className="adm-field-label">{C.role}</span>
            <Select
              ariaLabel={C.role}
              value={role}
              onChange={(v) => setRole(v as 'editor' | 'viewer')}
              options={[
                { value: 'viewer', label: C.roleViewer },
                { value: 'editor', label: C.roleEditor },
              ]}
            />
          </div>
          <label className="adm-field">
            <span className="adm-field-label">
              {C.colorLabel} <span className="adm-field-hint">{C.colorOptional}</span>
            </span>
            <div className="adm-color-row">
              <input
                type="color"
                className="adm-color-swatch"
                value={color || '#888888'}
                onChange={(e) => setColor(e.target.value)}
                aria-label={C.pickColor}
              />
              <input
                className="adm-input adm-input-mono"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#888888"
              />
            </div>
          </label>
        </div>
        <label className="adm-field">
          <span className="adm-field-label">
            {C.pinLabel} <span className="adm-field-hint">{fillTemplate(C.pinDigits, { n: PIN_LEN })}</span>
          </span>
          <input
            className="adm-input adm-input-mono"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LEN))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="••••••"
          />
        </label>

        {err && <div className="adm-state adm-state-err">{err}</div>}

        <div className="adm-members-formbtns">
          <button
            type="button"
            className="btn adm-int-btn"
            onClick={() => { reset(); setOpen(false) }}
            disabled={busy}
          >
            {appConfig.copy.admin.common2.cancel}
          </button>
          <button type="submit" className="btn adm-save-btn" disabled={!valid || busy}>
            {busy ? appConfig.copy.admin.common2.saving : appConfig.copy.admin.common2.create}
          </button>
        </div>
      </div>
    </form>
  )
}

// ─── per-row inline edit (rename / recolor) ──────────────────────────────────

function EditRow({ user, onSaved, onCancel }: {
  user: AdminUser
  onSaved: () => void
  onCancel: () => void
}) {
  const [displayName, setDisplayName] = useState(user.display_name)
  const [color, setColor] = useState(user.color ?? '')
  const [elViewDefault, setElViewDefault] = useState(user.el_view_default ?? false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const C = appConfig.copy.admin.members
  const Cc = appConfig.copy.admin.common2

  const save = async () => {
    if (busy || displayName.trim().length === 0) return
    setBusy(true)
    setErr(null)
    try {
      await apiPatch(`/api/auth/users/${user.id}`, {
        display_name: displayName.trim(),
        color: color.trim() || null,
        el_view_default: elViewDefault,
      })
      onSaved()
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <tr className="adm-members-editrow">
      <td colSpan={6}>
        <div className="adm-members-editbox">
          <label className="adm-field">
            <span className="adm-field-label">{C.displayName}</span>
            <input
              className="adm-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="adm-field">
            <span className="adm-field-label">{C.colorLabel}</span>
            <div className="adm-color-row">
              <input
                type="color"
                className="adm-color-swatch"
                value={color || '#888888'}
                onChange={(e) => setColor(e.target.value)}
                aria-label={C.pickColor}
              />
              <input
                className="adm-input adm-input-mono"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#888888"
              />
            </div>
          </label>
          {user.role === 'editor' && (
            <label className="adm-field adm-check">
              <input
                type="checkbox"
                checked={elViewDefault}
                onChange={(e) => setElViewDefault(e.target.checked)}
              />
              <span>
                {C.elViewDefault}
                <span className="adm-field-hint"> — {C.elViewDefaultHint}</span>
              </span>
            </label>
          )}
          {err && <div className="adm-state adm-state-err">{err}</div>}
          <div className="adm-members-formbtns">
            <button type="button" className="btn adm-int-btn" onClick={onCancel} disabled={busy}>
              {Cc.cancel}
            </button>
            <button type="button" className="btn adm-save-btn" onClick={() => void save()} disabled={busy}>
              {busy ? Cc.saving : Cc.save}
            </button>
          </div>
        </div>
      </td>
    </tr>
  )
}

// ─── the view ──────────────────────────────────────────────────────────────

type Async =
  | { kind: 'loading' }
  | { kind: 'ok'; data: AdminUser[] }
  | { kind: 'error'; detail: string }

export function MembersView() {
  const [state, setState] = useState<Async>({ kind: 'loading' })
  const [editing, setEditing] = useState<string | null>(null)
  const [rowErr, setRowErr] = useState<{ id: string; detail: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await apiGet<AdminUser[]>('/api/auth/users')
      setState({ kind: 'ok', data })
    } catch (e) {
      setState({ kind: 'error', detail: errText(e) })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const activeEditors = state.kind === 'ok'
    ? state.data.filter((u) => u.role === 'editor' && u.is_active).length
    : 0

  // Mutate helper: runs a PATCH/POST, shows a per-row error on failure, reloads on success.
  const mutate = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id)
    setRowErr(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setRowErr({ id, detail: errText(e) })
    } finally {
      setBusyId(null)
    }
  }

  const toggleActive = (u: AdminUser) =>
    mutate(u.id, () => apiPatch(`/api/auth/users/${u.id}`, { is_active: !u.is_active }))

  const toggleRole = (u: AdminUser) =>
    mutate(u.id, () => apiPatch(`/api/auth/users/${u.id}`, {
      role: u.role === 'editor' ? 'viewer' : 'editor',
    }))

  const C = appConfig.copy.admin.members

  const resetPin = (u: AdminUser) => {
    const pin = window.prompt(
      fillTemplate(C.newPinPrompt, { name: u.display_name, n: PIN_LEN }),
    )
    if (pin == null) return
    if (!isValidPin(pin)) {
      setRowErr({ id: u.id, detail: fillTemplate(C.pinInvalid, { n: PIN_LEN }) })
      return
    }
    void mutate(u.id, () => apiPost(`/api/auth/users/${u.id}/pin`, { pin }))
  }

  return (
    <div className="adm-editor">
      <AddMemberForm onCreated={() => void load()} />

      <section className="adm-card">
        <header className="adm-card-head">
          <h2 className="adm-card-title">{C.title}</h2>
          <p className="adm-card-cap">
            {C.caption}
          </p>
        </header>
        <div className="adm-card-body">
          {state.kind === 'loading' && <div className="adm-state">{C.loading}</div>}
          {state.kind === 'error' && (
            <div className="adm-state adm-state-err">{state.detail}</div>
          )}
          {state.kind === 'ok' && state.data.length === 0 && (
            <div className="adm-state">{C.none}</div>
          )}
          {state.kind === 'ok' && state.data.length > 0 && (
            <div className="adm-table-wrap">
              <table className="adm-table adm-members-table">
                <thead>
                  <tr>
                    <th>{C.colName}</th>
                    <th>{C.colUsername}</th>
                    <th>{C.colRole}</th>
                    <th>{C.colStatus}</th>
                    <th>{C.colLastLogin}</th>
                    <th className="adm-members-actions-col">{C.colActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.map((u) => {
                    // Admin authority is the secret-backed session (userless), so no row is
                    // "you" — the only dead-end to prevent is removing the last active editor.
                    const isLastCmd = u.role === 'editor' && u.is_active && activeEditors <= 1
                    // Server is the real guard; UI just disables to avoid obvious dead-ends.
                    const blockDeactivate = u.is_active && isLastCmd
                    const blockDemote = u.role === 'editor' && isLastCmd
                    const busy = busyId === u.id
                    if (editing === u.id) {
                      return (
                        <EditRow
                          key={u.id}
                          user={u}
                          onSaved={() => { setEditing(null); void load() }}
                          onCancel={() => setEditing(null)}
                        />
                      )
                    }
                    return (
                      <tr key={u.id} className={u.is_active ? '' : 'adm-members-inactive'}>
                        <td>
                          <span className="adm-members-name">
                            {u.color && (
                              <span
                                className="adm-members-swatch"
                                style={{ background: u.color }}
                                aria-hidden
                              />
                            )}
                            {u.display_name}
                          </span>
                        </td>
                        <td className="adm-mono">{u.username}</td>
                        <td>
                          <span className={`adm-ref-kind adm-members-role ${u.role}`}>
                            {roleLabel(u.role)}
                          </span>
                        </td>
                        <td>
                          <span className={`adm-badge ${u.is_active ? 'on' : 'off'} adm-members-status`}>
                            <span className="adm-badge-dot" aria-hidden />
                            <span className="adm-badge-state">
                              {u.is_active ? C.active : C.inactive}
                            </span>
                          </span>
                        </td>
                        <td className="adm-mono">{fmtDate(u.last_login)}</td>
                        <td className="adm-members-actions-col">
                          <ActionMenu
                            ariaLabel={fillTemplate(C.guardLabel, { name: u.display_name })}
                            disabled={busy}
                            actions={[
                              { label: appConfig.copy.admin.common2.edit, onClick: () => setEditing(u.id) },
                              {
                                label: u.role === 'editor' ? C.toViewer : C.toEditor,
                                onClick: () => void toggleRole(u),
                                disabled: blockDemote,
                                title: blockDemote ? C.guardLastCmdRole : undefined,
                              },
                              {
                                label: u.is_active ? C.deactivate : C.reactivate,
                                onClick: () => void toggleActive(u),
                                disabled: blockDeactivate,
                                title: blockDeactivate ? C.guardLastCmdDeactivate : undefined,
                                danger: u.is_active,
                              },
                              { label: C.resetPin, onClick: () => resetPin(u) },
                            ]}
                          />
                          {rowErr?.id === u.id && (
                            <div className="adm-state adm-state-err adm-members-rowerr">
                              {rowErr.detail}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
