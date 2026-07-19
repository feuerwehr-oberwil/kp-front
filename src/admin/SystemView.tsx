import { useCallback, useEffect, useState } from 'react'
import { apiGet } from '../lib/api'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { providerLabel } from '../lib/deploymentConfig'
import { Card, StatusBadge, Metric, UsageBar, EmptyState, ResultChip } from './ui'

// ─── shapes (plain dict from GET /api/system; resilient — sections may be null) ──

interface SystemVersion {
  commit: string
  branch: string | null
  env: string
}
interface SystemDatabase {
  ok: boolean
}
interface SystemCounts {
  incidents: number | null
  incidents_open: number | null
  personnel_active: number | null
  users: number | null
  reference_datasets: number | null
}
interface SystemStorage {
  media_dir: string
  used_bytes: number
  file_count: number
  disk_total_bytes: number | null
  disk_free_bytes: number | null
}
interface SystemIntegrations {
  diveraConfigured: boolean
  traccarConfigured: boolean
  personnel?: { provider: string | null; configured: boolean; capabilities: string[] }
  alarms?: { provider: string | null; configured: boolean; capabilities: string[] }
  vehicles?: { provider: string | null; configured: boolean; capabilities: string[] }
  providers?: Array<{
    provider: string
    domain: 'personnel' | 'alarms' | 'vehicles'
    configured: boolean
    active: boolean
    capabilities: string[]
  }>
}
interface SystemConnector {
  id: string
  direction: 'in' | 'out'
  configured: boolean
  state: 'online' | 'offline' | null
  detail: string | null
}
interface SystemResponse {
  version: SystemVersion | null
  database: SystemDatabase | null
  counts: SystemCounts | null
  storage: SystemStorage | null
  integrations: SystemIntegrations | null
  connectors: SystemConnector[] | null
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Human-readable byte size (KB/MB/GB); null/invalid → "—". */
function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Count or "—" when the COUNT query failed server-side. */
function fmtCount(n: number | null | undefined): string {
  return n == null ? '—' : String(n)
}

/** Clamp a fraction to [0, 100] for bar widths. */
function pct(part: number | null | undefined, whole: number | null | undefined): number {
  if (part == null || whole == null || !Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0
  return Math.max(0, Math.min(100, (part / whole) * 100))
}

// ─── client-side offline cache (this device's PWA storage) ─────────────────────

type CacheInfo = { name: string; entries: number }
type OfflineState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ok'; usage: number | null; quota: number | null; caches: CacheInfo[] }

async function readOfflineCache(): Promise<OfflineState> {
  const hasCaches = typeof caches !== 'undefined'
  const hasEstimate = typeof navigator !== 'undefined' && !!navigator.storage?.estimate
  if (!hasCaches && !hasEstimate) return { kind: 'unavailable' }

  let usage: number | null = null
  let quota: number | null = null
  if (hasEstimate) {
    try {
      const est = await navigator.storage.estimate()
      usage = est.usage ?? null
      quota = est.quota ?? null
    } catch { /* keep nulls */ }
  }

  const cacheList: CacheInfo[] = []
  if (hasCaches) {
    try {
      const keys = await caches.keys()
      await Promise.all(
        keys.map(async (name) => {
          try {
            const c = await caches.open(name)
            const reqs = await c.keys()
            cacheList.push({ name, entries: reqs.length })
          } catch {
            cacheList.push({ name, entries: 0 })
          }
        }),
      )
      cacheList.sort((a, b) => a.name.localeCompare(b.name))
    } catch { /* leave list empty */ }
  }

  return { kind: 'ok', usage, quota, caches: cacheList }
}

function OfflineCacheCard() {
  const [state, setState] = useState<OfflineState>({ kind: 'loading' })
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState(false)

  const reload = useCallback(async () => {
    setState({ kind: 'loading' })
    setState(await readOfflineCache())
  }, [])

  useEffect(() => { void reload() }, [reload])

  const C = appConfig.copy.admin.system

  const onClear = async () => {
    if (typeof caches === 'undefined') return
    const ok = window.confirm(C.clearConfirm)
    if (!ok) return
    setClearing(true)
    setCleared(false)
    try {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
      setCleared(true)
      await reload()
    } catch {
      /* best-effort local maintenance — leave the prior view */
    } finally {
      setClearing(false)
    }
  }

  const totalEntries = state.kind === 'ok'
    ? state.caches.reduce((sum, c) => sum + c.entries, 0)
    : 0

  return (
    <Card
      title={C.offlineCache}
      tip={C.offlineCacheTip}
    >
      {state.kind === 'loading' && <div className="adm-state">{C.cacheReading}</div>}
      {state.kind === 'unavailable' && (
        <div className="adm-state">{C.cacheUnavailable}</div>
      )}
      {state.kind === 'ok' && (
        <>
          {state.usage != null && state.quota != null && state.quota > 0 ? (
            <div className="adm-sys-storage">
              <Metric label={C.usedQuota} value={`${fmtBytes(state.usage)} / ${fmtBytes(state.quota)}`} />
              <UsageBar pctFilled={pct(state.usage, state.quota)} />
            </div>
          ) : (
            <div className="adm-state">{C.storageEstimateUnavailable}</div>
          )}

          <div className="adm-sys-caches">
            <Metric label={C.cacheStorage} value={fillTemplate(C.cacheSummary, { caches: state.caches.length, entries: totalEntries })} />
            {state.caches.length > 0 && (
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>{C.cache}</th>
                      <th className="adm-num">{C.entries}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.caches.map((c) => (
                      <tr key={c.name}>
                        <td><span className="adm-mono">{c.name}</span></td>
                        <td className="adm-num adm-mono">{c.entries}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="adm-sys-actions">
            <button
              type="button"
              className="btn adm-int-btn"
              onClick={() => void onClear()}
              disabled={clearing || typeof caches === 'undefined'}
            >
              {clearing ? C.clearing : C.clearCaches}
            </button>
            {cleared && (
              <ResultChip key="cleared" tone="ok" onExpire={() => setCleared(false)}>{C.cleared}</ResultChip>
            )}
          </div>
          <p className="adm-card-cap">
            {C.offlineCacheCaption}
          </p>
        </>
      )}
    </Card>
  )
}

// ─── server system status ──────────────────────────────────────────────────────

type ServerState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ok'; data: SystemResponse }

export function SystemView() {
  const [state, setState] = useState<ServerState>({ kind: 'loading' })
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const C = appConfig.copy.admin.system

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const data = await apiGet<SystemResponse>('/api/system')
      setState({ kind: 'ok', data })
      setUpdatedAt(new Date())
    } catch {
      setState({ kind: 'error' })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <div className="adm-editor">
      <div className="adm-sys-toolbar">
        <span className="adm-sys-updated">
          {updatedAt ? fillTemplate(C.updatedAt, { time: updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : C.liveSnapshot}
        </span>
        <button type="button" className="btn adm-int-btn" onClick={() => void load()} disabled={state.kind === 'loading'}>
          <Icon id="rotate" />
          {C.refresh}
        </button>
      </div>
      {state.kind === 'loading' && (
        <Card><EmptyState message={C.loading} /></Card>
      )}
      {state.kind === 'error' && (
        <Card><EmptyState tone="err" message={C.error} /></Card>
      )}

      {state.kind === 'ok' && (() => {
        const { version, database, counts, storage } = state.data
        const commitShort = version ? version.commit.slice(0, 7) : '—'
        const isProd = version?.env === 'production'
        return (
          <>
            <div className="adm-sys-summary" aria-label={C.healthSummary}>
              <div>
                <span className="adm-sys-summary-label">{C.server}</span>
                <StatusBadge tone="on" label={C.server} state={C.reachable} />
              </div>
              <div>
                <span className="adm-sys-summary-label">{C.database}</span>
                <StatusBadge tone={database?.ok ? 'on' : 'err'} label={C.database} state={database?.ok ? C.ok : C.error2} />
              </div>
              <div>
                <span className="adm-sys-summary-label">{C.environment}</span>
                <StatusBadge tone={isProd ? 'on' : 'warn'} label={C.environment} state={isProd ? C.production : C.development} />
              </div>
            </div>
            <div className="adm-sys-grid">
            {/* Version */}
            <Card
              title={C.version}
              tip={C.versionTip}
            >
              {version ? (
                <>
                  <Metric label={C.commit} value={version.commit || commitShort} />
                  <Metric label={C.branch} value={version.branch ?? '—'} />
                  <div className="adm-sys-metric">
                    <span className="adm-sys-metric-label">{C.environment}</span>
                    <StatusBadge
                      tone={isProd ? 'on' : 'warn'}
                      label={isProd ? C.production : C.development}
                      state={version.env}
                    />
                  </div>
                </>
              ) : (
                <div className="adm-state">{C.notAvailable}</div>
              )}
            </Card>

            {/* Verbindungen — ONE table for everything this deployment talks to:
                provider integrations (Divera/Traccar) and every consumer/producer
                (print-relay agent with live heartbeat, capture poster, stats export,
                webhooks, web push, STT). Read-only; configured via env/CLI/admin. */}
            <Card title={C.connectors} tip={C.connectorsTip}>
              {state.data.integrations || state.data.connectors?.length ? (
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead>
                      <tr>
                        <th>{C.connection}</th>
                        <th>{C.domain}</th>
                        <th>{C.status}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(state.data.integrations?.providers ?? []).map((provider) => (
                        <tr key={`${provider.domain}:${provider.provider}`}>
                          <td><span className="adm-ref-title">{providerLabel(provider.provider)}</span></td>
                          <td>{provider.domain === 'personnel' ? C.personnelProvider : provider.domain === 'alarms' ? C.alarmProvider : C.vehicleProvider}</td>
                          <td>
                            <StatusBadge
                              tone={provider.active ? 'on' : provider.configured ? 'warn' : 'off'}
                              label={providerLabel(provider.provider)}
                              state={provider.active ? C.active : provider.configured ? C.configured : C.notConfigured}
                            />
                          </td>
                        </tr>
                      ))}
                      {(state.data.connectors ?? []).map((conn) => {
                        const label = ({
                          print_relay: C.connPrintRelay,
                          capture: C.connCapture,
                          stats: C.connStats,
                          divera_webhook: C.connDiveraWebhook,
                          alarm_webhook: C.connAlarmWebhook,
                          push: C.connPush,
                          stt: C.connStt,
                        } as Record<string, string>)[conn.id] ?? conn.id
                        const tone = !conn.configured ? 'off' as const
                          : conn.state === 'offline' ? 'warn' as const : 'on' as const
                        const stateLabel = !conn.configured ? C.notConfigured
                          : conn.state === 'online' ? C.connOnline
                          : conn.state === 'offline' ? C.connOffline : C.configured
                        return (
                          <tr key={conn.id}>
                            <td><span className="adm-ref-title">{label}</span></td>
                            <td>{conn.direction === 'in' ? C.directionIn : C.directionOut}</td>
                            <td>
                              <StatusBadge tone={tone} label={label} state={stateLabel} />
                              {conn.id === 'print_relay' && conn.detail && (
                                <p className="adm-card-cap">
                                  {fillTemplate(C.connLastSeen, { time: new Date(conn.detail).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}
                                </p>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : <div className="adm-state">{C.notAvailable}</div>}
            </Card>

            {/* Datenbank */}
            <Card
              title={C.database}
              tip={C.databaseTip}
            >
              {database ? (
                <StatusBadge
                  tone={database.ok ? 'on' : 'err'}
                  label={C.database}
                  state={database.ok ? C.ok : C.error2}
                />
              ) : (
                <div className="adm-state">{C.notAvailable}</div>
              )}
            </Card>

            {/* Bestand */}
            <Card
              title={C.inventory}
              tip={C.inventoryTip}
            >
              {counts ? (
                <div className="adm-sys-counts">
                  <Metric label={C.incidentsTotal} value={fmtCount(counts.incidents)} />
                  <Metric label={C.incidentsOpen} value={fmtCount(counts.incidents_open)} />
                  <Metric label={C.personnelActive} value={fmtCount(counts.personnel_active)} />
                  <Metric label={C.users} value={fmtCount(counts.users)} />
                  <Metric label={C.referenceData} value={fmtCount(counts.reference_datasets)} />
                </div>
              ) : (
                <div className="adm-state">{C.notAvailable}</div>
              )}
            </Card>

            {/* Speicher */}
            <Card
              title={C.storage}
              tip={C.storageTip}
            >
              {storage ? (
                <>
                  <Metric label={C.mediaUsed} value={fmtBytes(storage.used_bytes)} />
                  <Metric label={C.files} value={String(storage.file_count)} />
                  <Metric label={C.directory} value={storage.media_dir} />
                  {storage.disk_total_bytes != null ? (
                    <div className="adm-sys-storage">
                      <Metric
                        label={C.diskUsed}
                        value={`${fmtBytes((storage.disk_total_bytes ?? 0) - (storage.disk_free_bytes ?? 0))} / ${fmtBytes(storage.disk_total_bytes)}`}
                      />
                      <UsageBar
                        pctFilled={pct(
                          (storage.disk_total_bytes ?? 0) - (storage.disk_free_bytes ?? 0),
                          storage.disk_total_bytes,
                        )}
                        tone="amber"
                      />
                      <p className="adm-card-cap">{fillTemplate(C.free, { size: fmtBytes(storage.disk_free_bytes) })}</p>
                    </div>
                  ) : (
                    <div className="adm-state">{C.diskUnavailable}</div>
                  )}
                </>
              ) : (
                <div className="adm-state">{C.notAvailable}</div>
              )}
            </Card>

            {/* Client-side offline cache (this device) — a half-row card in the grid. */}
            <OfflineCacheCard />
            </div>
          </>
        )
      })()}

      {/* Offline cache stays reachable even when the server fetch fails. */}
      {state.kind !== 'ok' && <OfflineCacheCard />}
    </div>
  )
}
