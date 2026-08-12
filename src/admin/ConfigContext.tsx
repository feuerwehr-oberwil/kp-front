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
  /** ⚠️ Somebody else changed the config since this tab loaded it. NOT an error: nothing failed
   *  and nothing is lost — this tab's edits are still in the draft. It is a state that must
   *  STOP the autosave, because the whole point is that a full-document write no longer wins by
   *  default. «Übernehmen» re-sends on top of the newer document; reloading the page takes it. */
  | { kind: 'conflict' }
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
  /** The version of the document the SERVER holds, as last seen. Sent as `If-Match` on every
   *  save (backend · api/config · put_config) so a stale tab is refused rather than obeyed. */
  const versionRef = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    apiGet<DeploymentConfig>('/api/config')
      .then((cfg) => {
        if (!alive) return
        const safe = cfg && typeof cfg === 'object' ? cfg : {}
        versionRef.current = safe.version ?? null
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
    let echo: DeploymentConfig | undefined
    try {
      echo = await apiPut<DeploymentConfig>(
        '/api/config', payload,
        // omitted only on a document this tab has never read a version for — a fresh, unwritten
        // station, where there is nothing to conflict with
        versionRef.current ? { 'If-Match': versionRef.current } : undefined,
      )
    } catch (e: unknown) {
      savingRef.current = false
      if (e instanceof ApiError) {
        // ⚠️ 409 = the stored document moved on. Stop autosaving and SAY so — the old behaviour
        // (a full-document PUT that always won) is exactly how a tab left open all morning
        // reverted a station's Dienstgrade, Partnerorganisationen and Atemschutz-Doktrin in one
        // write. The draft is kept; re-reading the version lets «Übernehmen» land on top.
        // 428 = this PAGE predates the guard and sent no version at all (api/config · put_config).
        // Same treatment: stop autosaving and say so. «Übernehmen» works because the fresh read
        // below gives this tab the token it was missing — which is also why the message says
        // «neu laden» rather than «nochmals versuchen».
        if (e.status === 409 || e.status === 428) {
          setSave({ kind: 'conflict' })
          try {
            const fresh = await apiGet<DeploymentConfig>('/api/config')
            versionRef.current = fresh.version ?? null
          } catch { /* offline → «Übernehmen» will fail loudly, which is honest */ }
          return
        }
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
    versionRef.current = echo?.version ?? versionRef.current
    // ⚠️ The branding slots come back from the SERVER, which owns them (api/config · _keep_assets):
    // they are written by the upload endpoints and by `admin_branding push`, never typed here, so
    // a draft loaded before a logo was installed carries stale nulls. Folding the echo's assets
    // into both sides keeps this tab showing the logo that actually exists — and keeps `saved`
    // equal to `draft`, so the dirty check still settles instead of re-saving forever.
    const assets = echo?.identity?.assets
    const merged = assets ? { ...sent, identity: { ...(sent.identity ?? {}), assets } } : sent
    setSaved(merged)
    if (merged !== sent) setDraft((d) => (d ? { ...d, identity: { ...(d.identity ?? {}), assets } } : d))
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
    // a refused save must not re-fire on its own — that would be the silent overwrite again,
    // one debounce later. It waits for «Übernehmen» (retry).
    if (save.kind === 'conflict') return
    if (JSON.stringify(draft) === JSON.stringify(saved)) return
    if (savingRef.current) return
    const t = setTimeout(() => { void persist(draft) }, AUTOSAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [draft, saved, loadError, persist, save.kind])

  const set = (path: (string | number)[], val: unknown) => {
    setDraft((d) => setPath(d ?? {}, path, val))
  }

  const retry = () => { if (draft && !savingRef.current) void persist(draft) }

  const applyServerConfig = (cfg: DeploymentConfig) => {
    const safe = cfg && typeof cfg === 'object' ? cfg : {}
    versionRef.current = safe.version ?? versionRef.current
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
  // ⚠️ Its own state, ahead of `error`: nothing failed, and this page's edits are still here.
  // What it must do is STOP looking like a page that saves by itself, because the one thing
  // that must not happen next is this tab writing its hour-old document over the newer one.
  if (save.kind === 'conflict') {
    return (
      <span className="adm-autosave warn" title={C.conflictHint}>
        <span className="adm-autosave-dot" aria-hidden />
        {C.conflict}
        <button type="button" className="adm-autosave-retry" onClick={retry}>{C.conflictApply}</button>
      </span>
    )
  }
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
