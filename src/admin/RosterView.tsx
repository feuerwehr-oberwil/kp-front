import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, ApiError } from '../lib/api'
import { PersonnelSyncDialog } from '../components/PersonnelSyncDialog'
import {
  listRoster,
  createPerson,
  updatePerson,
  deactivatePerson,
  importRosterCsv,
  type RosterPerson,
  type RosterImportResult,
} from './rosterApi'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { providerLabel } from '../lib/deploymentConfig'
import { rankAbbr, rankLabel } from '../lib/rank'
import { InfoTip } from './InfoTip'
import { ActionMenu } from './ui'

// ─── helpers ───────────────────────────────────────────────────────────────────

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.detail
  return appConfig.copy.admin.common2.unknownError
}

// ─── add-person form ─────────────────────────────────────────────────────────

// Controlled by RosterView (open state + the trigger live in the shared toolbar), so it
// renders just the form card.
function AddPersonForm({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const C = appConfig.copy.admin.roster
  const Cc = appConfig.copy.admin.common2
  const valid = displayName.trim().length > 0

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setErr(null)
    try {
      await createPerson({ display_name: displayName.trim() })
      onCreated()
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="adm-card adm-members-form" onSubmit={submit}>
      <header className="adm-card-head">
        <h2 className="adm-card-title">{C.addPerson}</h2>
        <p className="adm-card-cap">{C.addPersonCaption}</p>
      </header>
      <div className="adm-card-body">
        <div className="adm-row-2">
          <label className="adm-field">
            <span className="adm-field-label">{C.name}</span>
            <input
              className="adm-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="off"
              placeholder={C.namePlaceholder}
            />
          </label>
        </div>

        {err && <div className="adm-state adm-state-err">{err}</div>}

        <div className="adm-members-formbtns">
          <button type="button" className="btn adm-int-btn" onClick={onClose} disabled={busy}>
            {Cc.cancel}
          </button>
          <button type="submit" className="btn adm-save-btn" disabled={!valid || busy}>
            {busy ? Cc.saving : Cc.create}
          </button>
        </div>
      </div>
    </form>
  )
}

// ─── per-row inline edit ──────────────────────────────────────────────────────

function EditRow({ person, onSaved, onCancel }: {
  person: RosterPerson
  onSaved: () => void
  onCancel: () => void
}) {
  const [displayName, setDisplayName] = useState(person.display_name)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const C = appConfig.copy.admin.roster
  const Cc = appConfig.copy.admin.common2

  const save = async () => {
    if (busy || displayName.trim().length === 0) return
    setBusy(true)
    setErr(null)
    try {
      await updatePerson(person.id, { display_name: displayName.trim() })
      onSaved()
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <tr className="adm-members-editrow">
      <td colSpan={5}>
        <div className="adm-members-editbox">
          <div className="adm-row-2">
            <label className="adm-field">
              <span className="adm-field-label">{C.name}</span>
              <input
                className="adm-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoFocus
              />
            </label>
          </div>
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

// ─── CSV import card ───────────────────────────────────────────────────────────

function CsvImportCard({ onImported }: { onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RosterImportResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const C = appConfig.copy.admin.roster

  // Provider-neutral portable baseline. Provider identities are established by sync.
  const downloadTemplate = () => {
    const csv = 'name,rank\r\nMuster Max,\r\nBeispiel Anna,fw\r\n'
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'mannschaft-vorlage.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setErr(null)
    setResult(null)
    try {
      const res = await importRosterCsv(file)
      setResult(res)
      onImported()
    } catch (e2) {
      setErr(errText(e2))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <section className="adm-card">
      <header className="adm-card-head">
        <h2 className="adm-card-title">
          {C.csvImport}
          <InfoTip label={C.csvImport} text={C.sourceHint} />
        </h2>
        <p className="adm-card-cap">{C.sourceHint}</p>
      </header>
      <div className="adm-card-body">
        <div className="adm-roster-import">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="adm-file-hidden"
            onChange={(e) => void onFile(e)}
            disabled={busy}
          />
          <button type="button" className="btn adm-int-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            {C.csvImport}
          </button>
          {busy && <span className="adm-int-stat">{C.importing}</span>}
          <button type="button" className="btn adm-int-btn adm-roster-template" onClick={downloadTemplate}>
            {C.csvTemplate}
          </button>
        </div>
        {err && <div className="adm-state adm-state-err">{err}</div>}
        {result && (
          <div className="adm-roster-result">
            <span className="adm-badge on">
              <span className="adm-badge-dot" aria-hidden />
              <span className="adm-badge-state">{fillTemplate(C.imported, { n: result.imported })}</span>
            </span>
            {result.skipped > 0 && (
              <span className="adm-badge warn">
                <span className="adm-badge-dot" aria-hidden />
                <span className="adm-badge-state">{fillTemplate(C.skipped, { n: result.skipped })}</span>
              </span>
            )}
            {result.errors.length > 0 && (
              <ul className="adm-roster-errors">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

// ─── the view ──────────────────────────────────────────────────────────────────

type Async =
  | { kind: 'loading' }
  | { kind: 'ok'; data: RosterPerson[] }
  | { kind: 'error'; detail: string }

export function RosterView() {
  const [state, setState] = useState<Async>({ kind: 'loading' })
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [rowErr, setRowErr] = useState<{ id: string; detail: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // undefined while capability discovery is loading; null means no provider is configured.
  const [personnelProvider, setPersonnelProvider] = useState<string | null | undefined>(undefined)
  const [syncOpen, setSyncOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await listRoster(showInactive)
      setState({ kind: 'ok', data })
    } catch (e) {
      setState({ kind: 'error', detail: errText(e) })
    }
  }, [showInactive])

  useEffect(() => { void load() }, [load])

  // Provider capability gates synchronization and CSV import. Manual entry remains available
  // for temporary/external personnel who are not managed by the configured source.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const cfg = await apiGet<{ integrations?: { personnel?: { provider?: string | null; configured?: boolean } } }>('/api/config')
        const provider = cfg.integrations?.personnel
        if (alive) setPersonnelProvider(provider?.configured ? provider.provider ?? null : null)
      } catch {
        if (alive) setPersonnelProvider(null)
      }
    })()
    return () => { alive = false }
  }, [])

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

  const toggleActive = (p: RosterPerson) =>
    p.is_active
      ? mutate(p.id, () => deactivatePerson(p.id))
      : mutate(p.id, () => updatePerson(p.id, { is_active: true }))

  const C = appConfig.copy.admin.roster

  return (
    <div className="adm-editor">
      <div className="adm-toolbar">
        {personnelProvider === null && (
          <span className="adm-int-stat adm-int-muted">{C.providerNotConfigured}</span>
        )}
        {personnelProvider && (
          <button type="button" className="btn adm-int-btn" onClick={() => setSyncOpen(true)}>
            {fillTemplate(C.syncProvider, { provider: providerLabel(personnelProvider) })}
          </button>
        )}
        <button type="button" className="btn adm-int-btn" onClick={() => setAddOpen(true)}>
          {C.addPerson}
        </button>
      </div>

      {addOpen && (
        <AddPersonForm
          onCreated={() => { setAddOpen(false); void load() }}
          onClose={() => setAddOpen(false)}
        />
      )}
      {personnelProvider === null && <CsvImportCard onImported={() => void load()} />}

      <section className="adm-card">
        <header className="adm-card-head">
          <h2 className="adm-card-title">{C.title}</h2>
          <p className="adm-card-cap">
            {C.caption}
          </p>
          <label className="adm-roster-inactive-toggle">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            <span>{C.showInactive}</span>
          </label>
        </header>
        <div className="adm-card-body">
          {state.kind === 'loading' && <div className="adm-state">{C.loading}</div>}
          {state.kind === 'error' && <div className="adm-state adm-state-err">{state.detail}</div>}
          {state.kind === 'ok' && state.data.length === 0 && (
            <div className="adm-state">{C.none}</div>
          )}
          {state.kind === 'ok' && state.data.length > 0 && (
            <div className="adm-table-wrap">
              <table className="adm-table adm-members-table">
                <thead>
                  <tr>
                    <th>{C.colName}</th>
                    <th>{C.colRank}</th>
                    <th>{C.colSource}</th>
                    <th>{C.colStatus}</th>
                    <th className="adm-members-actions-col">{C.colActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.map((p) => {
                    const busy = busyId === p.id
                    if (editing === p.id) {
                      return (
                        <EditRow
                          key={p.id}
                          person={p}
                          onSaved={() => { setEditing(null); void load() }}
                          onCancel={() => setEditing(null)}
                        />
                      )
                    }
                    return (
                      <tr key={p.id} className={p.is_active ? '' : 'adm-members-inactive'}>
                        <td><span className="adm-members-name">{p.display_name}</span></td>
                        <td>
                          <span className="adm-members-rank" title={rankLabel(p.rank ?? undefined)}>
                            {p.rank ? (rankAbbr(p.rank) || rankLabel(p.rank)) : C.rankNone}
                          </span>
                        </td>
                        <td>
                          <span className="adm-ref-kind">{p.external_identities?.[0] ? providerLabel(p.external_identities[0].provider) : C.sourceManual}</span>
                        </td>
                        <td>
                          <span className={`adm-badge ${p.is_active ? 'on' : 'off'} adm-members-status`}>
                            <span className="adm-badge-dot" aria-hidden />
                            <span className="adm-badge-state">{p.is_active ? C.active : C.inactive}</span>
                          </span>
                        </td>
                        <td className="adm-members-actions-col">
                          <ActionMenu
                            ariaLabel={`${C.colActions} — ${p.display_name}`}
                            disabled={busy}
                            actions={[
                              { label: appConfig.copy.admin.common2.edit, onClick: () => setEditing(p.id) },
                              {
                                label: p.is_active ? C.deactivate : C.reactivate,
                                onClick: () => void toggleActive(p),
                                danger: p.is_active,
                              },
                            ]}
                          />
                          {rowErr?.id === p.id && (
                            <div className="adm-state adm-state-err adm-members-rowerr">{rowErr.detail}</div>
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

      {syncOpen && (
        <PersonnelSyncDialog
          provider={providerLabel(personnelProvider ?? '')}
          onClose={() => setSyncOpen(false)}
          onSynced={() => void load()}
        />
      )}
    </div>
  )
}
