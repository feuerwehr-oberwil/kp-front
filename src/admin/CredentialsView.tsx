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
//
// The page is the settings table (ui.tsx · SettingsSheet): one row per credential,
// Einstellung | Wert | ⓘ, with the integration as a group divider. What each key is FOR is the
// group's ⓘ, where a credential comes from and when it was last touched is the row's — the
// prose that used to stand between the boxes, so «welcher Schlüssel fehlt hier» is one glance
// down a column instead of a scroll past eight paragraphs.
//
// ⚠️ SINCE 2026-09-11 THERE ARE TWO KINDS OF SECRET ON THIS PAGE, and the second one breaks
// rule 1 — so it is kept out of the sheet entirely, in a second one of its own (IncidentLinkKey
// below). The Einsatz-Link minting key is the one secret here that KP Front MINTS instead of
// receiving: it lives on `deployment_config`, the API hands it back on every GET
// (backend · api/incident_link.py · GET /api/incident-link/secret), and it has to, because an
// admin must be able to re-read it months later when the alerting system is reconfigured. Two
// mistakes were available and both are ruled out by giving it its own sheet with its own head:
// a reader must not think this key is as unreadable as the ones above it, and must not think
// the ones above it could be shown.

import { Fragment, useCallback, useEffect, useState } from 'react'
import { apiDelete, apiGet, apiPut } from '../lib/api'
import { appConfig } from '../config/appConfig'
import {
  Card, ConfirmButton, CopyChip, EmptyState, ResultChip, SettingRow, SettingsGroup, SettingsNote,
  SettingsSheet, StatusBadge, fmtDateTime, useSecret,
} from './ui'
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
const GROUPS = ['divera', 'traccar', 'push', 'stt', 'maps', 'webhooks', 'sharepoint', 'monitoring'] as const

/** The credential's state as the row's VALUE — a write-only secret has no other one to show.
 *  Rendered LABEL-LESS (`StatusBadge label=""`): the Einstellung column already names the
 *  credential, and a badge repeating that name would say «Divera Accesskey — Divera Accesskey
 *  gesetzt». Same rule as the connector table on the System page. */
function badgeFor(c: CredentialState): { tone: 'on' | 'off' | 'warn' | 'err'; state: string } {
  const C = appConfig.copy.admin.zugaenge
  if (c.source === 'env') return { tone: 'on', state: C.stateEnv }
  if (c.source === 'stored') return { tone: 'on', state: C.stateStored }
  if (c.source === 'unreadable') return { tone: 'err', state: C.stateUnreadable }
  return { tone: 'off', state: C.stateUnset }
}

/** What the row's ⓘ says about THIS credential: where a server-supplied value comes from, or
 *  when a stored one was last replaced and by whom. What the key is FOR belongs to the group
 *  divider above it, because it is the same answer for every row in that group. */
function tipFor(cred: CredentialState): string | undefined {
  const C = appConfig.copy.admin.zugaenge
  if (cred.source === 'env') return `${C.fromEnv} ${cred.env}`
  if (cred.source === 'stored' && cred.updatedAt) {
    return `${C.changedAt} ${fmtDateTime(cred.updatedAt)}${cred.updatedByName ? ` · ${cred.updatedByName}` : ''}`
  }
  return undefined
}

function CredentialRow({ cred, onChanged }: { cred: CredentialState; onChanged: () => void }) {
  const C = appConfig.copy.admin.zugaenge
  const badge = badgeFor(cred)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

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

  // ⚠️ A Fragment, never a <div>: the sheet is a CSS grid whose rows are `display: contents`,
  // so a wrapper element here would take the row's four cells with it and break every column
  // on the page (ui.tsx · the settings table).
  return (
    <Fragment>
      {/* `span`: a key is long, and an input that scrolls to hide half of itself is an input
          nobody can check. The control takes the Wert AND Standard columns — there is no
          shipped default for a credential, so that column has nothing to say here anyway. */}
      <SettingRow label={cred.label} tip={tipFor(cred)} span>
        <StatusBadge tone={badge.tone} label="" state={badge.state} />
        {cred.source === 'env' ? (
          // No input at all — an editable box that cannot take effect is a lie, and the
          // variable name is what an operator needs to go and change it where it lives.
          // ⚠️ `adm-cred-val` on every shown value, never a bare `adm-mono`: the one credential
          // here that is not a secret is the VAPID public key, 87 characters of base64url with
          // no break opportunity in them (credentials.css · «a value that is READ»).
          <>
            <code className="adm-mono adm-cred-val">{cred.env}</code>
            {!cred.secret && cred.value
              ? <code className="adm-mono adm-cred-val">{cred.value}</code>
              : null}
          </>
        ) : (
          <>
            {!cred.secret && cred.source === 'stored' && cred.value && (
              <code className="adm-mono adm-cred-val">{cred.value}</code>
            )}
            <span className="adm-cred-edit">
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
            </span>
          </>
        )}
      </SettingRow>
      {/* Not an explanation but a consequence in force — this integration is off until somebody
          sets the value again. It stays on the page rather than moving into the row's ⓘ. */}
      {cred.source === 'unreadable' && <SettingsNote tone="warn">{C.unreadableHint}</SettingsNote>}
      {result && (
        <SettingsNote>
          <ResultChip key={result.text} tone={result.tone} onExpire={() => setResult(null)}>
            {result.text}
          </ResultChip>
        </SettingsNote>
      )}
    </Fragment>
  )
}

/**
 * The Einsatz-Link minting key — a credential like every other key on this page (it is pasted
 * into the alerting system once), and the only one that can be read back.
 *
 * ⚠️ It is NOT a credential-store entry, so none of the machinery above applies to it. It runs
 * on the shared secret trio instead (ui · useSecret — GET `/api/incident-link/secret`, POST
 * `…/rotate`, DELETE), which is why it is a component of its own rather than a row in the loop.
 *
 * ⚠️ And it does not belong on «Links & Zugänge», where it stood until 2026-09-11: that page is
 * addresses, and this key has none. The alerting system SIGNS a per-incident token with it and
 * puts the result in the alarm (`/l/<token>`) — one token per Einsatz, minted by whoever has the
 * key, exactly as the app itself does from a running Einsatz. So there is no station-level URL
 * to show, only the key, and the key is what gets copied out of here.
 *
 * The actions are the page's own two-step `ConfirmButton`s rather than the ⋮ menu the links
 * table uses: a settings row puts its buttons out in the open (Speichern · Löschen), and there
 * are three of them, not a list worth folding away.
 *
 * ⚠️ They sit in a `SettingsNote` UNDER the row, not in its Wert cell — the house pattern for a
 * row whose actions are buttons (ConfigSections · the GeoJSON upload). `SettingRow` binds its
 * label to the Wert cell's first focusable element, and a `<label for>` pointing at a button
 * both renames it («Einsatz-Links, Schaltfläche») and ACTIVATES it on a click of the label. Here
 * that would have minted a key from a click on the word beside it. The Wert cell keeps the state
 * and the key, so the label binds to the copy chip, where a label click copies and nothing else.
 */
function IncidentLinkKey() {
  const C = appConfig.copy.admin.zugaenge
  const I = appConfig.copy.admin.einsatzlink
  const D = appConfig.copy.admin.docs
  const { state, busy, result, clearResult, rotate, disable } = useSecret(
    '/api/incident-link/secret', { rotated: I.rotated, disabled: I.disabled, failed: I.failed })
  if (state === null) return null
  const token = state.configured ? state.token ?? null : null

  return (
    // The head is the whole distinction: what this sheet holds, and — in one sentence — that
    // the sheet above it can never show a value. Said once, where both halves are in view.
    // Its ⓘ says what an Einsatz-Link IS (einsatzlink.body); the row's ⓘ says what the alerting
    // system does with the key (…hint), which is the sentence that belongs beside the key.
    <SettingsSheet title={C.minted.title} caption={C.minted.caption} tip={I.body}>
      {/* `span`: the key is 43 characters of base64url, and a chip that scrolls to hide half of
          them is a chip nobody can check against what the alerting system holds. */}
      <SettingRow label={I.stateLabel} hint={C.minted.purpose} tip={I.hint} span>
        <StatusBadge tone={state.configured ? 'on' : 'off'} label=""
          state={state.configured ? I.stateOn : I.stateOff} />
        {token && <CopyChip value={token} />}
      </SettingRow>
      <SettingsNote>
        <span className="adm-brand-row">
          {state.configured ? (
            <>
              <ConfirmButton label={I.rotateBtn} question={I.rotateMsg} disabled={busy}
                onConfirm={() => void rotate()} />
              <ConfirmButton label={I.disableBtn} question={I.disableMsg} danger disabled={busy}
                onConfirm={() => void disable()} />
              <button type="button" className="btn adm-int-btn"
                onClick={() => window.open(`${D.repo}${D.incidentLink}`, '_blank', 'noopener,noreferrer')}>
                {I.docsLink}
              </button>
            </>
          ) : (
            <button type="button" className="btn adm-save-btn" disabled={busy}
              onClick={() => void rotate()}>{I.enableBtn}</button>
          )}
        </span>
      </SettingsNote>
      {result && (
        <SettingsNote>
          <ResultChip key={result.text} tone={result.tone} onExpire={clearResult}>
            {result.text}
          </ResultChip>
        </SettingsNote>
      )}
    </SettingsSheet>
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
      {/* One sheet for every integration, not a card each: what an operator comes here to read
          is a COLUMN of states, and eight cards put a heading and a paragraph between every two
          of them. The integration is a group divider now, and its explanation its ⓘ. */}
      <SettingsSheet>
        {GROUPS.map((g) => {
          const rows = creds.filter((c) => c.group === g)
          if (rows.length === 0) return null
          const group = C.groups[g]
          return (
            <Fragment key={g}>
              <SettingsGroup title={group.title} tip={group.caption} />
              {rows.map((c) => (
                <CredentialRow key={c.name} cred={c} onChanged={() => void reload()} />
              ))}
            </Fragment>
          )
        })}
      </SettingsSheet>

      {/* The one key this page hands OUT instead of taking in — its own sheet, because it is
          the one that can be read back and the sheet above must keep meaning «never again». */}
      <IncidentLinkKey />

      {/* The other half of the answer: what a browser deliberately CANNOT set, and why.
          Without this the page reads as an incomplete list of environment variables, and
          the next person goes looking for SECRET_KEY here.
          A list, not settings — so it stays a Card, with its reasoning on the head's ⓘ. */}
      <Card title={C.staysInEnv.title} tip={C.staysInEnv.caption}>
        <ul className="adm-cred-notes">
          {C.staysInEnv.items.map((item) => (
            <li key={item.name}>
              <code className="adm-mono">{item.name}</code> — {item.why}
            </li>
          ))}
        </ul>
      </Card>

      <Card title={C.audit.title} tip={C.audit.caption}>
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
