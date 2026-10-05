// Station › Objektbesuche (docs/object-visits.md · «Admin», «Deployment config», «Notification»).
//
// What a station comes back for comes FIRST: the received visits — date, object, «Von», where each
// was filed, the report — and who is told about a new one (owner, 05.10.2026: «where do filled out
// object visits show»). Below them, in the order a station sets the module up: the switch and who
// may capture; the fields a Korrekturvorschlag can name; the filing destination (one SharePoint
// card); the filing status with «Erneut versuchen»; the organizer's integration key. The switch,
// fields and destination are the shared config document (the page autosaves like every Station
// page); the rest talk to /api/admin/object-visits.

import { useCallback, useEffect, useState } from 'react'
import { ApiError, apiGet, apiPut } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { fold } from '../lib/search'
import { downloadUrl } from '../lib/download'
import { Icon } from '../lib/icons'
import type { DeploymentObjectVisits, ObjectVisitDestination } from '../lib/deploymentConfig'
import {
  adminDeliveries, adminExportUrl, adminListVisits, adminNotify, adminRetryDeliveries, adminSetNotify,
  adminTestDestination, getCatalogue, INTEGRATION_KEY_CREDENTIAL, mintIntegrationKey, OV_ROUTES,
} from '../objectVisits/api'
import { DEFAULT_DESTINATION, destinationValid, previewFolder } from '../objectVisits/folders'
import { personName, type DeliveryRow, type NotifyState, type VisitFiling, type VisitSummary, type VisitTemplate } from '../objectVisits/types'
import { getPath, useConfig } from './ConfigContext'
import {
  Card, ConfirmButton, CopyChip, EmptyState, RecordRows, RecordTable, ResultChip, SettingRow, SettingsNote,
  SettingsSheet, StatusBadge, Table, fmtDateTime,
} from './ui'
import './objectVisits.css'

type Role = 'editor' | 'el' | 'viewer'
const ROLES: Role[] = ['editor', 'el', 'viewer']

const C = () => appConfig.copy.admin.objectVisits

/** `owner_contact` from «Kontakt Eigentümer» — the organizer's key, typed once. */
const fieldSlug = (s: string) => fold(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

export function ObjectVisitsView({ onNavigate }: { onNavigate: (id: string) => void }) {
  return (
    <>
      <VisitsCard />
      <NotifyCard onNavigate={onNavigate} />
      <ModuleSheet onNavigate={onNavigate} />
      <ProposalFieldsEditor />
      <DestinationCard onNavigate={onNavigate} />
      <DeliveriesCard />
      <IntegrationKeyCard />
    </>
  )
}

function useOv(): { ov: DeploymentObjectVisits; set: (path: (string | number)[], v: unknown) => void } {
  const { draft, set } = useConfig()
  const ov = getPath<DeploymentObjectVisits>(draft, ['objectVisits']) ?? {}
  return { ov: ov && typeof ov === 'object' ? ov : {}, set }
}

// ─── Modul ─────────────────────────────────────────────────────────────────────────────────

function ModuleSheet({ onNavigate }: { onNavigate: (id: string) => void }) {
  const T = C()
  const { ov, set } = useOv()
  const roles: Role[] = Array.isArray(ov.captureRoles) ? ov.captureRoles : ['editor', 'el']
  const [templates, setTemplates] = useState<VisitTemplate[] | null | 'failed'>(null)
  const [noRole, setNoRole] = useState(false)
  useEffect(() => {
    let alive = true
    // the admin session may read the catalogue even while the module is off
    getCatalogue()
      .then((c) => { if (alive) setTemplates((c.templates ?? []).filter((t) => t.kind === 'visit')) })
      .catch(() => { if (alive) setTemplates('failed') })
    return () => { alive = false }
  }, [])

  const toggleRole = (r: Role, on: boolean) => {
    const next = on ? [...new Set([...roles, r])] : roles.filter((x) => x !== r)
    // nobody may capture is no setting anybody means — the module switch is the way to turn it off
    if (!next.length) { setNoRole(true); return }
    setNoRole(false)
    set(['objectVisits', 'captureRoles'], ROLES.filter((x) => next.includes(x)))
  }

  const checklistText = templates === null ? '…'
    : templates === 'failed' ? T.checklistsUnknown
      : templates.length === 0 ? T.checklistsNone
        : fillTemplate(templates.length === 1 ? T.checklistsOne : T.checklistsSome, {
          n: templates.length, titles: templates.map((t) => `${t.title} v${t.version}`).join(' · '),
        })

  return (
    <SettingsSheet title={T.module} tip={T.moduleTip}>
      <SettingRow label={T.enabled} tip={T.enabledTip}>
        <input className="adm-set-check" type="checkbox" checked={ov.enabled === true}
          onChange={(e) => set(['objectVisits', 'enabled'], e.target.checked)} />
      </SettingRow>
      <SettingRow label={T.captureRoles} tip={T.captureRolesTip} span>
        <span className="adm-brand-row">
          {ROLES.map((r) => (
            <label key={r} className="adm-ov-role">
              <input className="adm-set-check" type="checkbox" checked={roles.includes(r)} onChange={(e) => toggleRole(r, e.target.checked)} />
              {T.roles[r]}
            </label>
          ))}
        </span>
      </SettingRow>
      {noRole && <SettingsNote tone="warn">{T.rolesNone}</SettingsNote>}
      <SettingRow label={T.checklists} tip={T.checklistsTip} span>
        <span>{checklistText}</span>
      </SettingRow>
      <SettingsNote>
        <button type="button" className="btn adm-int-btn" onClick={() => onNavigate('checklisten')}>{T.checklistsManage}</button>
      </SettingsNote>
    </SettingsSheet>
  )
}

// ─── Felder für Vorschläge ─────────────────────────────────────────────────────────────────

function ProposalFieldsEditor() {
  const T = C()
  const { ov, set } = useOv()
  const stored = Array.isArray(ov.proposalFields) ? ov.proposalFields : []
  const [editing, setEditing] = useState<{ id: string; label: string }[] | null>(null)
  const rows = editing ?? stored
  const problem = (f: { id: string; label: string }, i: number, all: { id: string; label: string }[]): string | null => {
    const id = f.id?.trim()
    if (!id || !f.label?.trim()) return T.fieldIncomplete
    return all.findIndex((o) => o.id?.trim() === id) === i ? null : T.fieldDuplicate
  }
  const write = (next: { id: string; label: string }[]) => {
    setEditing(next)
    set(['objectVisits', 'proposalFields'], next.filter((f, i) => problem(f, i, next) === null).map((f) => ({ id: f.id.trim(), label: f.label.trim() })))
  }
  const patch = (i: number, over: Partial<{ id: string; label: string }>) => write(rows.map((r, j) => (j === i ? { ...r, ...over } : r)))
  const setLabel = (i: number, label: string) => {
    const row = rows[i]
    const follows = !row.id?.trim() || row.id === fieldSlug(row.label ?? '')
    patch(i, follows ? { label, id: fieldSlug(label) } : { label })
  }
  return (
    <RecordTable title={T.fields} tip={T.fieldsTip} recordLabel={T.fieldsRecord}>
      {rows.length === 0 && <SettingsNote>{T.fieldsEmpty}</SettingsNote>}
      {rows.map((row, i) => {
        const warn = problem(row, i, rows)
        return (
          <RecordRows
            key={i}
            name={row.label?.trim() || appConfig.copy.admin.common.newEntry}
            meta={row.id?.trim() || undefined}
            action={(
              <ConfirmButton className="adm-formlink-x" ariaLabel={T.fieldRemove} label={<Icon id="trash" />}
                question={T.fieldRemoveConfirm} danger onConfirm={() => write(rows.filter((_, j) => j !== i))} />
            )}
          >
            <SettingRow label={T.fieldLabel}>
              <input className="adm-input" type="text" value={row.label ?? ''} placeholder={T.fieldLabelPlaceholder}
                onChange={(e) => setLabel(i, e.target.value)} />
            </SettingRow>
            <SettingRow label={T.fieldId}>
              <input className="adm-input adm-input-mono" type="text" value={row.id ?? ''} placeholder={T.fieldIdPlaceholder}
                onChange={(e) => patch(i, { id: e.target.value })} />
            </SettingRow>
            {warn && <SettingsNote tone="warn">{warn}</SettingsNote>}
          </RecordRows>
        )
      })}
      <SettingsNote>
        <button type="button" className="adm-formlink-add" onClick={() => write([...rows, { id: '', label: '' }])}>
          <Icon id="plus" />{T.fieldAdd}
        </button>
      </SettingsNote>
    </RecordTable>
  )
}

// ─── Ablageziel · SharePoint ───────────────────────────────────────────────────────────────

function DestinationCard({ onNavigate }: { onNavigate: (id: string) => void }) {
  const T = C()
  const { ov, set } = useOv()
  const all: ObjectVisitDestination[] = Array.isArray(ov.destinations) ? ov.destinations : []
  const at = all.findIndex((d) => d?.kind === 'sharepoint')
  // the card as it is being EDITED: a destination the server would refuse (no https site yet)
  // stays here and is not written — the config PUT is the whole document (folders · destinationValid)
  const [editing, setEditing] = useState<ObjectVisitDestination | null>(null)
  const dest = editing ?? (at >= 0 ? all[at] : null)
  const [test, setTest] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const write = (next: ObjectVisitDestination) => {
    setEditing(next)
    if (!destinationValid(next)) return
    set(['objectVisits', 'destinations'], at >= 0 ? all.map((d, i) => (i === at ? next : d)) : [...all, next])
  }
  const patch = (over: Partial<ObjectVisitDestination>) => { if (dest) write({ ...dest, ...over }) }
  const create = () => setEditing({ ...DEFAULT_DESTINATION })
  const runTest = async () => {
    if (!dest) return
    setBusy(true)
    try {
      const r = await adminTestDestination(dest.id)
      const said = [r?.status != null ? String(r.status) : null, r?.detail || null].filter(Boolean).join(' · ')
      setTest(r?.ok
        ? { tone: 'ok', text: said ? `${T.testOk} · ${said}` : T.testOk }
        : { tone: 'err', text: said ? `${T.testFailed} · ${said}` : T.testFailed })
    } catch (e) {
      setTest({ tone: 'err', text: e instanceof ApiError ? `${T.testFailed} · ${e.detail}` : T.testFailed })
    } finally {
      setBusy(false)
    }
  }

  if (!dest) {
    return (
      <Card title={T.destination} caption={T.destinationCaption} tip={T.destinationTip}>
        <EmptyState message={T.destinationNone}
          action={<button type="button" className="btn adm-int-btn" onClick={create}>{T.destinationAdd}</button>} />
      </Card>
    )
  }

  const example = previewFolder(dest, {
    objectName: T.previewObject, objectAddress: T.previewAddress, date: new Date().toISOString().slice(0, 10),
    checklist: T.previewChecklist, visitId: 'ov0000000000000-7f3a',
  })
  const text = (key: 'siteUrl' | 'library' | 'root' | 'objectFolder' | 'visitFolder', label: string, opts: { mono?: boolean; placeholder?: string; tip?: string } = {}) => (
    <SettingRow label={label} tip={opts.tip} span>
      <input className={`adm-input${opts.mono ? ' adm-input-mono' : ''}`} type="text" value={dest[key] ?? ''}
        placeholder={opts.placeholder} onChange={(e) => patch({ [key]: e.target.value })} />
    </SettingRow>
  )
  return (
    <SettingsSheet title={T.destination} caption={T.destinationCaption} tip={T.destinationTip}>
      <SettingRow label={T.destEnabled}>
        <input className="adm-set-check" type="checkbox" checked={dest.enabled === true} onChange={(e) => patch({ enabled: e.target.checked })} />
      </SettingRow>
      <SettingRow label={T.destTiming} span>
        <span className="adm-brand-row">
          {(['every-sync', 'completed'] as const).map((t) => (
            <label key={t} className="adm-ov-role">
              <input type="radio" name="ov-timing" checked={(dest.timing ?? 'completed') === t} onChange={() => patch({ timing: t })} />
              {t === 'every-sync' ? T.timingEvery : T.timingCompleted}
            </label>
          ))}
        </span>
      </SettingRow>
      {!destinationValid(dest) && <SettingsNote tone="warn">{T.destIncomplete}</SettingsNote>}
      {text('siteUrl', T.siteUrl, { mono: true, placeholder: T.siteUrlPlaceholder })}
      {text('library', T.library)}
      {text('root', T.root, { mono: true })}
      {text('objectFolder', T.objectFolder, { mono: true, tip: T.foldersTip })}
      {text('visitFolder', T.visitFolder, { mono: true, tip: T.foldersTip })}
      <SettingRow label={T.preview} span>
        <code className="adm-mono adm-cred-val">{example}</code>
      </SettingRow>
      <SettingRow label={T.credentials} span>
        <span>{T.credentialsBody}</span>
      </SettingRow>
      <SettingsNote>
        <span className="adm-brand-row">
          <button type="button" className="btn adm-int-btn" onClick={() => onNavigate('zugaenge')}>{T.credentialsGo}</button>
          {at >= 0 && destinationValid(dest) && (
            <button type="button" className="btn adm-int-btn" disabled={busy} onClick={() => void runTest()}>{T.test}</button>
          )}
          {test && <ResultChip key={test.text} tone={test.tone} onExpire={() => setTest(null)} clearAfterMs={12_000}>{test.text}</ResultChip>}
        </span>
      </SettingsNote>
      {all.length > 1 && <SettingsNote>{T.destinationMore}</SettingsNote>}
    </SettingsSheet>
  )
}

// ─── Ablage-Status ─────────────────────────────────────────────────────────────────────────

function DeliveriesCard() {
  const T = C()
  const [rows, setRows] = useState<DeliveryRow[] | null | 'failed'>(null)
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const reload = useCallback(() => {
    adminDeliveries().then(setRows).catch(() => setRows('failed'))
  }, [])
  useEffect(reload, [reload])
  const retry = async (destination: string, visitId?: string) => {
    try {
      await adminRetryDeliveries(destination, visitId)
      setResult({ tone: 'ok', text: T.retried })
      reload()
    } catch (e) {
      setResult({ tone: 'err', text: e instanceof ApiError ? `${T.retryFailed} · ${e.detail}` : T.retryFailed })
    }
  }
  const failedDests = Array.isArray(rows) ? [...new Set(rows.filter((r) => r.state === 'failed').map((r) => r.destination))] : []
  return (
    <Card
      title={T.deliveries}
      tip={T.deliveriesTip}
      action={failedDests.length > 0 ? (
        <span className="adm-brand-row">
          {failedDests.map((d) => (
            <button key={d} type="button" className="btn adm-int-btn" onClick={() => void retry(d)}>
              {failedDests.length > 1 ? `${T.retryAll} · ${d}` : T.retryAll}
            </button>
          ))}
        </span>
      ) : undefined}
    >
      {result && <ResultChip key={result.text} tone={result.tone} onExpire={() => setResult(null)}>{result.text}</ResultChip>}
      {rows === null && <EmptyState loading message={appConfig.copy.admin.common.configLoading} />}
      {rows === 'failed' && <EmptyState tone="err" message={T.loadFailed} />}
      {Array.isArray(rows) && rows.length === 0 && <EmptyState message={T.deliveriesEmpty} />}
      {Array.isArray(rows) && rows.length > 0 && (
        <Table columns={[
          { key: 'visit', label: T.colVisit }, { key: 'dest', label: T.colDestination },
          { key: 'rev', label: T.colRevision, num: true }, { key: 'state', label: T.colState },
          { key: 'att', label: T.colAttempts, num: true }, { key: 'next', label: T.colNext },
          { key: 'err', label: T.colError }, { key: 'act', label: '' },
        ]}>
          {rows.map((r) => (
            <tr key={`${r.destination}:${r.visitId}`}>
              <td>{r.objectName}</td>
              <td className="adm-mono">{r.destination}</td>
              <td className="adm-num">{`${r.deliveredRevision ?? '–'} / ${r.wantedRevision ?? '–'}`}</td>
              <td>
                <StatusBadge label="" state={T.deliveryStates[r.state] ?? r.state}
                  tone={r.state === 'delivered' ? 'on' : r.state === 'failed' ? 'err' : r.state === 'paused' ? 'off' : 'warn'} />
              </td>
              <td className="adm-num">{r.attempts}</td>
              <td>{r.nextAttemptAt ? fmtDateTime(r.nextAttemptAt) : ''}</td>
              <td>{r.lastError ?? ''}</td>
              <td>{r.state === 'failed' && (
                <button type="button" className="btn adm-int-btn" onClick={() => void retry(r.destination, r.visitId)}>{T.retry}</button>
              )}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

// ─── Integration ───────────────────────────────────────────────────────────────────────────

function IntegrationKeyCard() {
  const T = C()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [shown, setShown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const reload = useCallback(() => {
    apiGet<{ name: string; configured: boolean }[]>('/api/integrations/credentials')
      .then((list) => setConfigured(!!list.find((c) => c.name === INTEGRATION_KEY_CREDENTIAL)?.configured))
      .catch(() => setConfigured(false))
  }, [])
  useEffect(reload, [reload])
  const generate = async () => {
    setBusy(true)
    setError(null)
    const key = mintIntegrationKey()
    try {
      await apiPut(`/api/integrations/credentials/${INTEGRATION_KEY_CREDENTIAL}`, { value: key })
      setShown(key)
      setConfigured(true)
    } catch (e) {
      setError(e instanceof ApiError ? `${T.keyFailed} · ${e.detail}` : T.keyFailed)
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsSheet title={T.integration} caption={T.integrationCaption}>
      <SettingRow label={T.keyState} span>
        <span className="adm-cred-state">
          <StatusBadge tone={configured ? 'on' : 'off'} label="" state={configured ? T.keySet : T.keyUnset} />
        </span>
        {shown && <CopyChip value={shown} />}
      </SettingRow>
      {shown && <SettingsNote tone="warn">{T.keyShownOnce}</SettingsNote>}
      <SettingsNote>
        <span className="adm-brand-row">
          {configured
            ? <ConfirmButton label={T.keyRotate} question={T.keyRotateConfirm} disabled={busy} onConfirm={() => void generate()} />
            : <button type="button" className="btn adm-save-btn" disabled={busy || configured === null} onClick={() => void generate()}>{T.keyGenerate}</button>}
        </span>
      </SettingsNote>
      {error && <SettingsNote tone="warn">{error}</SettingsNote>}
    </SettingsSheet>
  )
}

// ─── Besuche ───────────────────────────────────────────────────────────────────────────────

const filingTone = (state: VisitFiling['state']): 'on' | 'off' | 'warn' | 'err' =>
  state === 'delivered' ? 'on' : state === 'failed' ? 'err' : state === 'paused' ? 'off' : 'warn'

/** «…/Hauptstrasse 24 - Gemeindeverwaltung/Objektbesuche/2026-10-05 Kontrolle (7f3a)» — the object's
 *  and the visit's folders; the chip copies the whole path below the library. */
const shortFolder = (path: string) => {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : parts.join('/')
}

/** «Ablage»: the filing state per destination, and once filed the folder it went to (copyable). */
function FilingCell({ filings }: { filings: VisitFiling[] }) {
  const T = C()
  if (!filings.length) return <span className="adm-ov-none">{T.filedNone}</span>
  return (
    <span className="adm-ov-filing">
      {filings.map((f) => (
        <span key={f.destination} className="adm-ov-filing-row">
          <StatusBadge label="" state={T.deliveryStates[f.state] ?? f.state} tone={filingTone(f.state)} />
          {f.folder && <CopyChip value={f.folder} display={shortFolder(f.folder)} />}
          {f.error && <span className="adm-ov-err">{f.error}</span>}
        </span>
      ))}
    </span>
  )
}

function VisitsCard() {
  const T = C()
  const L = appConfig.copy.objectVisits.lifecycle
  const [rows, setRows] = useState<VisitSummary[] | null | 'failed'>(null)
  useEffect(() => {
    let alive = true
    adminListVisits({ limit: 200 }).then((r) => { if (alive) setRows(r) }).catch(() => { if (alive) setRows('failed') })
    return () => { alive = false }
  }, [])
  return (
    <Card
      title={T.visits}
      caption={T.visitsCaption}
      tip={T.visitsTip}
      action={<button type="button" className="btn adm-int-btn" title={T.exportTip} onClick={() => downloadUrl(adminExportUrl())}><Icon id="download" /> {T.exportZip}</button>}
    >
      {rows === null && <EmptyState loading message={appConfig.copy.admin.common.configLoading} />}
      {rows === 'failed' && <EmptyState tone="err" message={T.loadFailed} />}
      {Array.isArray(rows) && rows.length === 0 && <EmptyState message={T.visitsEmpty} />}
      {Array.isArray(rows) && rows.length > 0 && (
        <Table columns={[
          { key: 'date', label: T.colDate }, { key: 'obj', label: T.colObject }, { key: 'by', label: T.colBy },
          { key: 'lc', label: T.colLifecycle }, { key: 'f', label: T.colFindings, num: true },
          { key: 'filed', label: T.colFiled }, { key: 'list', label: T.colList }, { key: 'pdf', label: '' },
        ]}>
          {rows.map((v) => (
              <tr key={v.id}>
                <td>{fmtDateTime(v.visitedAt)}</td>
                <td>{v.objectName}</td>
                {/* «Von»: the people typed on the visit; the (shared) account only as fallback */}
                <td>{v.with?.length ? v.with.join(', ') : personName(v.by)}</td>
                <td>{L[v.lifecycle] ?? v.lifecycle}</td>
                <td className="adm-num">{v.findings ?? ''}</td>
                <td><FilingCell filings={v.deliveries ?? []} /></td>
                <td className="adm-mono">{v.workRef ?? ''}</td>
                <td>
                  {/* the report IS the visit's detail view: answers, notes, photos, proposals */}
                  <a className="adm-link" href={OV_ROUTES.report(v.id)} target="_blank" rel="noreferrer">{T.pdf}</a>
                </td>
              </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

// ─── Benachrichtigung · Neuer Objektbesuch ─────────────────────────────────────────────────

/** Which accounts' devices get «Neuer Objektbesuch» when a visit is completed. Nobody until an
 *  admin ticks somebody (owner, 05.10.2026: «configurable and not all users / downloads»). Saves
 *  on every tick, like the rest of the page. */
function NotifyCard({ onNavigate }: { onNavigate: (id: string) => void }) {
  const T = C()
  const [state, setState] = useState<NotifyState | null | 'failed'>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  useEffect(() => {
    let alive = true
    adminNotify().then((r) => { if (alive) setState(r) }).catch(() => { if (alive) setState('failed') })
    return () => { alive = false }
  }, [])
  const toggle = async (id: string, on: boolean) => {
    if (!state || state === 'failed') return
    const ids = state.accounts.filter((a) => (a.id === id ? on : a.notify)).map((a) => a.id)
    setBusy(true)
    try {
      setState(await adminSetNotify(ids))
      setResult({ tone: 'ok', text: T.notifySaved })
    } catch (e) {
      setResult({ tone: 'err', text: e instanceof ApiError ? `${T.notifyFailed} · ${e.detail}` : T.notifyFailed })
    } finally {
      setBusy(false)
    }
  }
  const devices = (n: number) => (n === 0 ? T.notifyDevicesNone : n === 1 ? T.notifyDevicesOne : fillTemplate(T.notifyDevices, { n }))
  return (
    <SettingsSheet title={T.notify} caption={T.notifyCaption} tip={T.notifyTip}>
      {state === null && <EmptyState loading message={appConfig.copy.admin.common.configLoading} />}
      {state === 'failed' && <EmptyState tone="err" message={T.loadFailed} />}
      {state && state !== 'failed' && (
        <>
          {!state.pushEnabled && (
            <SettingsNote tone="warn">
              <span className="adm-brand-row">
                {T.notifyPushOff}
                <button type="button" className="btn adm-int-btn" onClick={() => onNavigate('zugaenge')}>{T.credentialsGo}</button>
              </span>
            </SettingsNote>
          )}
          {state.accounts.length === 0 && <SettingsNote>{T.notifyNoAccounts}</SettingsNote>}
          {state.accounts.map((a) => (
            <SettingRow key={a.id} label={a.name} hint={a.name !== a.username ? a.username : undefined}>
              <span className="adm-brand-row">
                <input className="adm-set-check" type="checkbox" checked={a.notify} disabled={busy}
                  aria-label={fillTemplate(T.notifyFor, { name: a.name })}
                  onChange={(e) => void toggle(a.id, e.target.checked)} />
                <span className={`adm-ov-devices${a.devices ? '' : ' none'}`}>{devices(a.devices)}</span>
              </span>
            </SettingRow>
          ))}
          {result && (
            <SettingsNote>
              <ResultChip key={result.text} tone={result.tone} onExpire={() => setResult(null)}>{result.text}</ResultChip>
            </SettingsNote>
          )}
        </>
      )}
    </SettingsSheet>
  )
}
