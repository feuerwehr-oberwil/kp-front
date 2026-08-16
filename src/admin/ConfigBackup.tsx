import { useEffect, useRef, useState } from 'react'
import { apiGet, apiPut, ApiError } from '../lib/api'
import type { DeploymentConfig } from '../lib/deploymentConfig'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { downloadBlob } from '../lib/download'
import { Sheet } from '../lib/overlays'
import { describeRejectedFields, rejectedFieldLabel } from './ConfigContext'

// Config backup (Batch A · A1): export the current config to a JSON file, import one back,
// and show who last changed it & when. `integrations` is env-derived/read-only so it's
// stripped from both export and import payloads (mirrors ConfigEditor's PUT).

interface ConfigMeta {
  updated_at: string | null
  updated_by_name: string | null
}

const DE_DATE = new Intl.DateTimeFormat('de-CH', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : DE_DATE.format(d)
}

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; message: string }
  /** `fields` = the refused paths as German lines (ConfigContext · describeRejectedFields).
   *  Listed, not run into one sentence: each is a separate edit in the file. */
  | { kind: 'error'; message: string; fields?: string[] }

/** A file waiting on the replace confirmation. Parsed already — the confirmation is about what
 *  the import DOES, so it must not be the place a broken JSON file is discovered. */
interface Pending {
  name: string
  payload: Record<string, unknown>
  /** Sections that HAVE content today and are empty in the file — i.e. what this replace wipes.
   *  Mirrors the server's own `emptied_sections` (backend/app/config_history.py), which is what
   *  «Letzte Änderungen» reports after the fact. Saying it BEFORE is the whole point of a
   *  confirmation. */
  empties: string[]
}

/** True for absence, not for a value somebody chose: `0` and `false` are content.
 *  ⚠️ Keep in step with `empty()` in backend/app/config_history.py. */
function isEmpty(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string' || Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v).length === 0
  return false
}

/** Which populated parts of `current` the imported `next` would leave empty — one level into
 *  the top-level sections, exactly where config_history.emptied_sections looks. */
function emptiedSections(current: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [key, oldVal] of Object.entries(current)) {
    if (key === 'integrations' || key === 'version' || key === 'alarmVocabulary') continue
    const newVal = next[key]
    if (oldVal && typeof oldVal === 'object' && !Array.isArray(oldVal)
        && newVal && typeof newVal === 'object' && !Array.isArray(newVal)) {
      for (const [sub, oldSub] of Object.entries(oldVal as Record<string, unknown>)) {
        if (!isEmpty(oldSub) && isEmpty((newVal as Record<string, unknown>)[sub])) out.push(`${key}.${sub}`)
      }
    } else if (!isEmpty(oldVal) && isEmpty(newVal)) out.push(key)
  }
  return out.map(rejectedFieldLabel)
}

export function ConfigBackup({ config, onImported }: {
  /** The currently-loaded config (used as the export source). */
  config: DeploymentConfig
  /** Called with the fresh projection after a successful import, to re-seed the editor. */
  onImported: (cfg: DeploymentConfig) => void
}) {
  const [meta, setMeta] = useState<ConfigMeta | null>(null)
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [pending, setPending] = useState<Pending | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const C = appConfig.copy.admin.backup
  const Cc = appConfig.copy.admin.common2

  const refreshMeta = () => {
    apiGet<ConfigMeta>('/api/config/meta')
      .then((m) => setMeta(m))
      .catch(() => setMeta(null)) // gracefully omit if unavailable
  }
  useEffect(() => { refreshMeta() }, [])

  // Download the current config as a JSON file (integrations stripped — env-derived).
  const exportConfig = (filename: string) => {
    const { integrations: _ignore, ...payload } = config as DeploymentConfig & { integrations?: unknown }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    downloadBlob(blob, filename)
  }

  const onExport = () => exportConfig('kp-front-config.json')

  /** Step 1 — read + parse the file and ASK. Nothing is written here. */
  const onImportFile = async (file: File) => {
    setState({ kind: 'busy' })
    const clearInput = () => { if (fileRef.current) fileRef.current.value = '' }
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      setState({ kind: 'error', message: C.notJson })
      clearInput()
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setState({ kind: 'error', message: C.notConfig })
      clearInput()
      return
    }
    const { integrations: _ignore, symbols: _drop, ...payload } = parsed as Record<string, unknown>
    setState({ kind: 'idle' })
    setPending({
      name: file.name,
      payload,
      empties: emptiedSections(config as unknown as Record<string, unknown>, payload),
    })
    // ⚠️ Cleared HERE, not after the write: the same file picked twice in a row fires no
    // `change` event otherwise, so cancelling once made the button dead until a reload.
    clearInput()
  }

  const cancelImport = () => {
    setPending(null)
    setState({ kind: 'idle' })
  }

  /** Step 2 — the operator confirmed the replace. */
  const runImport = async ({ payload }: Pending) => {
    setPending(null)
    setState({ kind: 'busy' })
    // One-click rollback: save the pre-import config before replacing it (3am tenet —
    // nothing that can't be undone). Best-effort; a failed download must not block import.
    try { exportConfig('kp-front-config-vorher.json') } catch { /* rollback file is a safety net */ }
    try {
      // ⚠️ The version is read FRESH here, not taken from this page's draft. Importing a backup
      // IS «replace the whole document with this file» — the user picked it, confirmed it, and
      // the pre-import config was just downloaded as a rollback — so it must not fail because
      // somebody saved five minutes ago. But it must not ride on a stale token either: the
      // backend now REQUIRES the header from a browser (api/config · put_config), because the
      // tab that does the damage is always an old one. Re-reading immediately before the write
      // keeps the import deliberate without letting an hour-old page overwrite silently.
      const current = await apiGet<DeploymentConfig>('/api/config')
      const saved = await apiPut<DeploymentConfig>(
        '/api/config', payload,
        current.version ? { 'If-Match': current.version } : undefined,
      )
      onImported(saved && typeof saved === 'object' ? saved : (payload as DeploymentConfig))
      setState({ kind: 'ok', message: C.imported })
      refreshMeta()
    } catch (e: unknown) {
      // ⚠️ A 422 carries the exact answer — which field, which entry, what was found — and it
      // used to be dropped for «Konfiguration ungültig (422) – Datei passt nicht zum Schema»,
      // which is a restatement of «it did not work». Say what the server said, in German.
      const fields = e instanceof ApiError && e.status === 422 ? describeRejectedFields(e) : []
      const msg = e instanceof ApiError
        ? (e.status === 422 ? (fields.length ? C.invalidFields : C.invalidSchema) : e.detail)
        : C.importFailed
      setState({ kind: 'error', message: msg, fields: fields.length ? fields : undefined })
    }
  }

  const lastChanged = (() => {
    const date = formatDate(meta?.updated_at ?? null)
    if (!date) return null
    const name = meta?.updated_by_name
    return name
      ? fillTemplate(C.lastChangedBy, { name, date })
      : fillTemplate(C.lastChanged, { date })
  })()

  return (
    <div className="adm-card-body">
      {lastChanged && <p className="adm-card-cap">{lastChanged}</p>}
      <div className="adm-brand-row">
        <button type="button" className="btn adm-int-btn" onClick={onExport}>
          {C.export}
        </button>
        <button
          type="button"
          className="btn adm-int-btn"
          disabled={state.kind === 'busy'}
          onClick={() => fileRef.current?.click()}
        >
          {C.import}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f) }}
        />
      </div>
      {state.kind === 'ok' && <span className="adm-save-ok">{state.message}</span>}
      {state.kind === 'error' && (
        <div className="adm-save-err">
          {state.message}
          {/* one line per refused field — each is its own edit in the file, and a run-on
              sentence is read to the end by nobody */}
          {state.fields && (
            <ul className="adm-import-errs">
              {state.fields.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
        </div>
      )}
      {/* ⚠️ The product's own overlay, not `window.confirm()`. This is the most destructive
          action in Verwaltung — a FULL-DOCUMENT replace — and it was the one still confirming
          with a browser dialog an installed iOS PWA may suppress without a trace (the same
          reason the PIN got its own sheet). `.adm` sits at z-index 100; admin.css lifts
          `.ui-backdrop`/`.ip-sheet.ui-dialog` above it, which is why a Sheet is the primitive
          that works here. */}
      {pending && (
        <Sheet
          open
          onClose={cancelImport}
          title={C.replaceTitle}
          fit
          modal
          footer={
            <>
              <button type="button" className="ip-btn ghost" onClick={cancelImport}>{Cc.cancel}</button>
              <button type="button" className="ip-btn ip-btn-danger" onClick={() => void runImport(pending)}>
                {C.replaceGo}
              </button>
            </>
          }
        >
          <p className="adm-card-cap">{fillTemplate(C.replaceLead, { file: pending.name })}</p>
          {/* Not «is that ok?» but «here is what disappears». The server reports exactly this
              AFTER the fact in «Letzte Änderungen»; before the fact is when it can still be
              acted on. */}
          {pending.empties.length > 0 && (
            <>
              <p className="adm-card-cap">{C.replaceEmpties}</p>
              <ul className="adm-import-errs">
                {pending.empties.map((s) => <li key={s}>{s}</li>)}
              </ul>
            </>
          )}
          <p className="adm-hint">{C.replaceRollback}</p>
        </Sheet>
      )}
    </div>
  )
}
