import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { apiGet, apiPut, ApiError } from '../lib/api'
import { appConfig } from '../config/appConfig'
import {
  loadDeploymentConfig,
  applyDeploymentBranding,
  type DeploymentConfig,
} from '../lib/deploymentConfig'

// Shared editing state for the whole Konfiguration ("Station") area. The config is one
// document that the five Station pages each edit a facet of. Edits AUTOSAVE: a change is
// debounced and PUT automatically — there is no manual "Speichern". Dirty-tracking is
// against the last successfully-persisted snapshot, so a server projection that differs
// cosmetically can never wedge the indicator or trigger a save loop.

// ─── nested path helpers ──────────────────────────────────────────────────────

// Immutably set a nested path on the draft, creating intermediate objects as needed.
// Unedited siblings/branches are preserved verbatim (the PUT is a full-document replace).
function setPath(obj: DeploymentConfig, path: (string | number)[], val: unknown): DeploymentConfig {
  const next: any = Array.isArray(obj) ? [...obj] : { ...obj }
  let cur = next
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]
    const child = cur[k]
    cur[k] = Array.isArray(child) ? [...child] : { ...(child ?? {}) }
    cur = cur[k]
  }
  cur[path[path.length - 1]] = val
  return next
}

/** Read a nested path (undefined-safe). */
export function getPath<T = unknown>(obj: unknown, path: (string | number)[]): T | undefined {
  let cur: any = obj
  for (const k of path) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur as T | undefined
}

// ─── context ───────────────────────────────────────────────────────────────────

const AUTOSAVE_DELAY_MS = 700

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string; reauth?: boolean }

interface ConfigCtx {
  draft: DeploymentConfig | null
  loadError: string | null
  dirty: boolean
  save: SaveState
  /** Set a nested path on the draft (autosaves shortly after). */
  set: (path: (string | number)[], val: unknown) => void
  /** Re-try the last failed autosave now. */
  retry: () => void
  /** Re-seed from a fresh server projection (branding upload/remove, config import). */
  applyServerConfig: (cfg: DeploymentConfig) => void
}

const Ctx = createContext<ConfigCtx | null>(null)

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<DeploymentConfig | null>(null)
  // Last snapshot we know the server holds — the baseline for dirty + autosave.
  const [saved, setSaved] = useState<DeploymentConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const savingRef = useRef(false)

  useEffect(() => {
    let alive = true
    apiGet<DeploymentConfig>('/api/config')
      .then((cfg) => {
        if (!alive) return
        const safe = cfg && typeof cfg === 'object' ? cfg : {}
        setDraft(safe)
        setSaved(safe)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setLoadError(e instanceof ApiError ? e.detail : appConfig.copy.admin.autosave.loadFailed)
      })
    return () => { alive = false }
  }, [])

  const dirty = useMemo(() => {
    if (!saved || !draft) return false
    return JSON.stringify(saved) !== JSON.stringify(draft)
  }, [saved, draft])

  // Persist a specific draft snapshot. Dirty/baseline is tracked against `sent` itself
  // (not the server echo), so the indicator settles even if the projection normalises.
  const persist = useCallback(async (sent: DeploymentConfig) => {
    savingRef.current = true
    setSave({ kind: 'saving' })
    // integrations is env-derived / read-only; symbols (quickPick) was dropped from the
    // app. Strip both before the full-document PUT so neither is ever re-sent.
    const { integrations: _ignore, symbols: _dropSymbols, ...payload } =
      sent as DeploymentConfig & { symbols?: unknown }
    try {
      await apiPut<DeploymentConfig>('/api/config', payload)
    } catch (e: unknown) {
      savingRef.current = false
      if (e instanceof ApiError) {
        const reauth = e.status === 401 || e.status === 403
        setSave({
          kind: 'error',
          message: reauth ? appConfig.copy.admin.autosave.sessionExpired : e.detail,
          reauth,
        })
      } else {
        setSave({ kind: 'error', message: appConfig.copy.admin.autosave.saveFailed })
      }
      return
    }
    // Release the lock BEFORE the state updates, so the autosave effect re-runs (on the
    // new `saved`) and picks up any edits made while this save was in flight.
    savingRef.current = false
    setSaved(sent)
    setSave({ kind: 'ok' })
    // Best-effort: re-resolve the singleton + re-apply branding so title/accent update
    // live. A failure here must not flip the (already successful) save to an error.
    try {
      applyDeploymentBranding(await loadDeploymentConfig())
    } catch { /* branding refresh is non-critical */ }
  }, [])

  // Debounced autosave: fire AUTOSAVE_DELAY_MS after the last edit. A save already in
  // flight defers — its completion bumps `saved`, re-running this with any trailing edits.
  useEffect(() => {
    if (loadError || !draft || !saved) return
    if (JSON.stringify(draft) === JSON.stringify(saved)) return
    if (savingRef.current) return
    const t = setTimeout(() => { void persist(draft) }, AUTOSAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [draft, saved, loadError, persist])

  const set = (path: (string | number)[], val: unknown) => {
    setDraft((d) => setPath(d ?? {}, path, val))
  }

  const retry = () => { if (draft && !savingRef.current) void persist(draft) }

  const applyServerConfig = (cfg: DeploymentConfig) => {
    const safe = cfg && typeof cfg === 'object' ? cfg : {}
    setDraft(safe)
    setSaved(safe)
    setSave({ kind: 'idle' })
    applyDeploymentBranding(safe)
  }

  const value: ConfigCtx = { draft, loadError, dirty, save, set, retry, applyServerConfig }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useConfig(): ConfigCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useConfig must be used within ConfigProvider')
  return v
}

/** Gate that shows a load/error state until the config draft is ready. */
export function ConfigGate({ children }: { children: ReactNode }) {
  const { draft, loadError } = useConfig()
  if (loadError) return <div className="adm-state adm-state-err">{loadError}</div>
  if (!draft) return <div className="adm-state">{appConfig.copy.admin.common.configLoading}</div>
  return <>{children}</>
}

/** Compact autosave indicator — replaces the manual save bar across the Station pages. */
export function ConfigAutosaveStatus() {
  const { save, dirty, draft, retry } = useConfig()
  const C = appConfig.copy.admin.autosave
  if (!draft) return null
  if (save.kind === 'error') {
    return (
      <span className="adm-autosave err">
        <span className="adm-autosave-dot" aria-hidden />
        {save.message}
        <button type="button" className="adm-autosave-retry" onClick={retry}>{C.retry}</button>
      </span>
    )
  }
  if (save.kind === 'saving') {
    return <span className="adm-autosave busy"><span className="adm-autosave-dot" aria-hidden />{C.saving}</span>
  }
  if (dirty) {
    return <span className="adm-autosave busy"><span className="adm-autosave-dot" aria-hidden />{C.pending}</span>
  }
  return <span className="adm-autosave ok"><span className="adm-autosave-dot" aria-hidden />{C.saved}</span>
}
