// Zugangsdaten — the station's integration credentials, set from a browser instead of a
// terminal. Backed by GET/PUT/DELETE /api/integrations/credentials (app/api/credentials.py).
//
// Three rules shape this page, and each one is visible in the markup:
//
// 1. WRITE-ONLY. A secret is never rendered, because the API never sends one. The row says
//    «gesetzt · geändert am …» and offers an empty box to replace it. That is deliberate:
//    an admin session must be able to rotate a credential and must not be able to walk off
//    with one.
// 2. `.env` WINS. A field the server supplies shows where it comes from (the variable name)
//    instead of an input. Nothing here can override a deployer's decision, and pretending
//    otherwise would be the «typed it in and nothing happened» failure this page exists to
//    end.
// 3. «unlesbar» IS ITS OWN STATE. A stored value that will not decrypt (SECRET_KEY was
//    rotated) says so and asks to be set again — never «nicht gesetzt», which would send an
//    operator looking for a setting they already made.

import { useCallback, useEffect, useState } from 'react'
import { apiDelete, apiGet, apiPut } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { Card, ConfirmButton, EmptyState, ResultChip, StatusBadge, fmtDateTime } from './ui'
import './credentials.css'

type Source = 'env' | 'stored' | 'unset' | 'unreadable'

interface CredentialState {
  name: string
  group: string
  label: string
  secret: boolean
  source: Source
  configured: boolean
  env: string
  value: string | null
  updatedAt: string | null
  updatedByName: string | null
}

interface AuditEntry {
  id: number
  name: string
  label: string
  action: string
  source: string | null
  at: string
  by: string | null
}

/** Card order = the order a station connects things in, not alphabetical. */
const GROUPS = ['divera', 'traccar', 'push', 'stt', 'webhooks', 'monitoring'] as const

function badgeFor(c: CredentialState): { tone: 'on' | 'off' | 'warn' | 'err'; state: string } {
  const C = appConfig.copy.admin.zugaenge
  if (c.source === 'env') return { tone: 'on', state: C.stateEnv }
  if (c.source === 'stored') return { tone: 'on', state: C.stateStored }
  if (c.source === 'unreadable') return { tone: 'err', state: C.stateUnreadable }
  return { tone: 'off', state: C.stateUnset }
}

function CredentialRow({ cred, onChanged }: { cred: CredentialState; onChanged: () => void }) {
  const C = appConfig.copy.admin.zugaenge
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const badge = badgeFor(cred)

  const save = async () => {
    if (!draft.trim()) return
    setBusy(true)
    try {
      await apiPut(`/api/integrations/credentials/${cred.name}`, { value: draft.trim() })
      setDraft('')
      setResult({ tone: 'ok', text: C.saved })
      onChanged()
    } catch (e) {
      // The server's German refusal is the useful message («… muss mit https:// beginnen»),
      // so it is shown verbatim rather than replaced by a generic failure.
      setResult({ tone: 'err', text: e instanceof Error && e.message ? e.message : C.failed })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await apiDelete(`/api/integrations/credentials/${cred.name}`)
      setResult({ tone: 'ok', text: C.removed })
      onChanged()
    } catch (e) {
      setResult({ tone: 'err', text: e instanceof Error && e.message ? e.message : C.failed })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="adm-cred-row">
      <div className="adm-cred-head">
        <StatusBadge tone={badge.tone} label={cred.label} state={badge.state} />
        {cred.source === 'stored' && cred.updatedAt && (
          <span className="adm-cred-meta">
            {C.changedAt} {fmtDateTime(cred.updatedAt)}
            {cred.updatedByName ? ` · ${cred.updatedByName}` : ''}
          </span>
        )}
      </div>

      {cred.source === 'env' ? (
        // No input at all — an editable box that cannot take effect is a lie, and the
        // variable name is what an operator needs to go and change it where it lives.
        <p className="adm-card-cap adm-cred-env">
          {C.fromEnv} <code className="adm-mono">{cred.env}</code>
          {!cred.secret && cred.value ? <> · <code className="adm-mono">{cred.value}</code></> : null}
        </p>
      ) : (
        <>
          {cred.source === 'unreadable' && <p className="adm-card-cap adm-cred-warn">{C.unreadableHint}</p>}
          {!cred.secret && cred.source === 'stored' && cred.value && (
            <p className="adm-card-cap"><code className="adm-mono">{cred.value}</code></p>
          )}
          <div className="adm-cred-edit">
            <input
              className="adm-input adm-mono"
              type={cred.secret ? 'password' : 'text'}
              value={draft}
              autoComplete="off"
              spellCheck={false}
              placeholder={cred.configured ? C.placeholderReplace : C.placeholderSet}
              aria-label={cred.label}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className="btn adm-save-btn"
              disabled={busy || !draft.trim()}
              onClick={() => void save()}
            >
              {cred.configured ? C.replaceBtn : C.saveBtn}
            </button>
            {cred.source === 'stored' || cred.source === 'unreadable' ? (
              <ConfirmButton
                label={C.removeBtn}
                question={C.removeMsg}
                danger
                disabled={busy}
                onConfirm={() => void remove()}
              />
            ) : null}
          </div>
        </>
      )}
      {result && (
        <ResultChip key={result.text} tone={result.tone} onExpire={() => setResult(null)}>
          {result.text}
        </ResultChip>
      )}
    </div>
  )
}

export function CredentialsView() {
  const C = appConfig.copy.admin.zugaenge
  const [creds, setCreds] = useState<CredentialState[] | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [failed, setFailed] = useState(false)

  const reload = useCallback(async () => {
    try {
      setCreds(await apiGet<CredentialState[]>('/api/integrations/credentials'))
      setAudit(await apiGet<AuditEntry[]>('/api/integrations/credentials-audit?limit=20'))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])
  useEffect(() => { void reload() }, [reload])

  if (failed) return <EmptyState message={C.loadFailed} tone="err" />
  if (creds === null) return null

  return (
    <>
      {GROUPS.map((g) => {
        const rows = creds.filter((c) => c.group === g)
        if (rows.length === 0) return null
        const group = C.groups[g]
        return (
          <Card key={g} title={group.title} caption={group.caption}>
            <div className="adm-cred-list">
              {rows.map((c) => (
                <CredentialRow key={c.name} cred={c} onChanged={() => void reload()} />
              ))}
            </div>
          </Card>
        )
      })}

      {/* The other half of the answer: what a browser deliberately CANNOT set, and why.
          Without this the page reads as an incomplete list of environment variables, and
          the next person goes looking for SECRET_KEY here. */}
      <Card title={C.staysInEnv.title} caption={C.staysInEnv.caption}>
        <ul className="adm-cred-notes">
          {C.staysInEnv.items.map((item) => (
            <li key={item.name}>
              <code className="adm-mono">{item.name}</code> — {item.why}
            </li>
          ))}
        </ul>
      </Card>

      <Card title={C.audit.title} caption={C.audit.caption}>
        {audit.length === 0 ? (
          <EmptyState message={C.audit.empty} />
        ) : (
          <ul className="adm-cred-notes">
            {audit.map((e) => (
              <li key={e.id}>
                {fmtDateTime(e.at)} — {e.label}: {C.audit.actions[e.action] ?? e.action}
                {e.by ? ` · ${e.by}` : ` · ${C.audit.noUser}`}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
