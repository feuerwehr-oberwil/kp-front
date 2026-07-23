import { useEffect, useRef, useState } from 'react'
import { apiGet, apiPut, ApiError } from '../lib/api'
import type { DeploymentConfig } from '../lib/deploymentConfig'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { downloadBlob } from '../lib/download'

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
  | { kind: 'error'; message: string }

export function ConfigBackup({ config, onImported }: {
  /** The currently-loaded config (used as the export source). */
  config: DeploymentConfig
  /** Called with the fresh projection after a successful import, to re-seed the editor. */
  onImported: (cfg: DeploymentConfig) => void
}) {
  const [meta, setMeta] = useState<ConfigMeta | null>(null)
  const [state, setState] = useState<State>({ kind: 'idle' })
  const fileRef = useRef<HTMLInputElement>(null)
  const C = appConfig.copy.admin.backup

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

  const onImportFile = async (file: File) => {
    setState({ kind: 'busy' })
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      setState({ kind: 'error', message: C.notJson })
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    if (!parsed || typeof parsed !== 'object') {
      setState({ kind: 'error', message: C.notConfig })
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    if (!window.confirm(C.replaceConfirm)) {
      setState({ kind: 'idle' })
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    // One-click rollback: save the pre-import config before replacing it (3am tenet —
    // nothing that can't be undone). Best-effort; a failed download must not block import.
    try { exportConfig('kp-front-config-vorher.json') } catch { /* rollback file is a safety net */ }
    const { integrations: _ignore, symbols: _drop, ...payload } =
      parsed as Record<string, unknown>
    try {
      const saved = await apiPut<DeploymentConfig>('/api/config', payload)
      onImported(saved && typeof saved === 'object' ? saved : (payload as DeploymentConfig))
      setState({ kind: 'ok', message: C.imported })
      refreshMeta()
    } catch (e: unknown) {
      const msg = e instanceof ApiError
        ? (e.status === 422 ? C.invalidSchema : e.detail)
        : C.importFailed
      setState({ kind: 'error', message: msg })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
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
      {state.kind === 'error' && <span className="adm-save-err">{state.message}</span>}
    </div>
  )
}
