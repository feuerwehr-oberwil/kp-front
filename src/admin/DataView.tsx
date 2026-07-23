import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiGet, apiPost, ApiError } from '../lib/api'
import {
  listObjects,
  listReference,
  getDiveraPool,
  refreshDiveraPool,
} from '../lib/incidents'
import type {
  ObjectWithPlans,
  ReferenceDataset,
  DiveraAlarm,
} from '../lib/incidents'
import type { VehiclePosition } from '../types'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { providerLabel } from '../lib/deploymentConfig'
import { Card, StatusBadge, Table, EmptyState, ResultChip, fmtDate } from './ui'

// The three read-only "Daten" pages — Integrationen, Objekte & Pläne, Geodaten. Each is
// its own nav destination (they used to be stacked cards in one DataView). Every fetch is
// wrapped so one failing endpoint can never crash a page.

// ─── helpers ───────────────────────────────────────────────────────────────

/** Short relative time ("vor 3 Min."), falling back to de-CH date+time; invalid → "—". */
function fmtRelTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const C = appConfig.copy.admin.data
  const diffSec = Math.round((Date.now() - d.getTime()) / 1000)
  if (diffSec < 0) return d.toLocaleString('de-CH')
  if (diffSec < 60) return C.justNow
  if (diffSec < 3600) return fillTemplate(C.relMin, { n: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return fillTemplate(C.relHour, { n: Math.floor(diffSec / 3600) })
  return d.toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** Speed in km/h or "—" when missing. */
function fmtSpeed(kmh: number | null | undefined): string {
  if (kmh == null || !Number.isFinite(kmh)) return '—'
  return `${Math.round(kmh)} km/h`
}

/** Human-readable byte size; null → "—". */
function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// A per-card async resource: 'loading' until the first fetch settles, then either
// the data, an 'unconfigured' neutral state (503 — integration off), or an 'error'
// neutral state (any other failure).
type Async<T> =
  | { kind: 'loading' }
  | { kind: 'ok'; data: T }
  | { kind: 'unconfigured' }
  | { kind: 'error' }

function classify(e: unknown): 'unconfigured' | 'error' {
  // 503 = integration not configured server-side; treat as a neutral "off" state.
  if (e instanceof ApiError && e.status === 503) return 'unconfigured'
  return 'error'
}

// ─── connection-test helpers ──────────────────────────────────────────────────

// Transient result of a "Verbindung testen" probe. Mapped from the HTTP status:
// 200 → ok, 503 → off (nicht konfiguriert), anything else → err (Fehler).
type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'off' }
  | { kind: 'err'; detail: string }

function classifyTest(e: unknown): TestState {
  if (e instanceof ApiError) {
    if (e.status === 503) return { kind: 'off' }
    return { kind: 'err', detail: e.detail }
  }
  return { kind: 'err', detail: appConfig.copy.admin.data.genericError }
}

/** Small inline button + transient result chip for a single integration probe. */
function TestButton({ label, run }: { label: string; run: () => Promise<unknown> }) {
  const [state, setState] = useState<TestState>({ kind: 'idle' })
  const C = appConfig.copy.admin.data

  const onClick = async () => {
    setState({ kind: 'testing' })
    try {
      await run()
      setState({ kind: 'ok' })
    } catch (e) {
      setState(classifyTest(e))
    }
  }

  return (
    <span className="adm-test">
      <button
        type="button"
        className="btn adm-int-btn"
        onClick={() => void onClick()}
        disabled={state.kind === 'testing'}
      >
        {state.kind === 'testing' ? C.testing : C.testConnection}
      </button>
      {state.kind === 'ok' && (
        <ResultChip key="ok" tone="ok" onExpire={() => setState({ kind: 'idle' })}>{C.testOk}</ResultChip>
      )}
      {state.kind === 'off' && (
        <ResultChip key="off" tone="off" onExpire={() => setState({ kind: 'idle' })}>{C.testOff}</ResultChip>
      )}
      {state.kind === 'err' && (
        <ResultChip key="err" tone="err" onExpire={() => setState({ kind: 'idle' })}>{C.testErr}</ResultChip>
      )}
    </span>
  )
}

// ─── Divera ──────────────────────────────────────────────────────────────────
// One focused page per integration (they used to be stacked rows in one Integrationen
// view). Read-only status + a connection probe; the Mannschaft headcount moved to its own
// Personen › Mannschaft page (it isn't a Divera concern even when Divera feeds it).

interface ProviderCapability { provider?: string | null; configured?: boolean; capabilities?: string[] }
interface ConfigShape {
  integrations?: {
    personnel?: ProviderCapability
    alarms?: ProviderCapability
    vehicles?: ProviderCapability
    diveraConfigured?: boolean
    traccarConfigured?: boolean
  }
}

/** Shared status-header row: a connection badge on the left, actions on the right. */
function IntStatus({ badge, children }: { badge: ReactNode; children: ReactNode }) {
  return (
    <div className="adm-int-row">
      <div className="adm-int-badge">{badge}</div>
      <div className="adm-int-meta">{children}</div>
    </div>
  )
}

export function AlarmProviderView() {
  // The generic capability identifies the provider. The current pool adapter is Divera.
  const [cfg, setCfg] = useState<Async<ConfigShape>>({ kind: 'loading' })
  const [pool, setPool] = useState<Async<DiveraAlarm[]>>({ kind: 'loading' })
  const [refreshing, setRefreshing] = useState(false)

  const loadPool = useCallback(async () => {
    setPool({ kind: 'loading' })
    try {
      setPool({ kind: 'ok', data: await getDiveraPool() })
    } catch (e) {
      setPool({ kind: classify(e) })
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      let diveraOn = false
      try {
        const c = await apiGet<ConfigShape>('/api/config')
        if (!alive) return
        setCfg({ kind: 'ok', data: c })
        diveraOn = c.integrations?.alarms?.configured ?? !!c.integrations?.diveraConfigured
      } catch (e) {
        if (!alive) return
        setCfg({ kind: classify(e) })
      }
      if (alive && diveraOn) void loadPool()
      else if (alive) setPool({ kind: 'unconfigured' })
    })()
    return () => { alive = false }
  }, [loadPool])

  const onRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshDiveraPool()
      await loadPool()
    } catch (e) {
      setPool({ kind: classify(e) })
    } finally {
      setRefreshing(false)
    }
  }

  const C = appConfig.copy.admin.data
  const capability = cfg.kind === 'ok' ? cfg.data.integrations?.alarms : undefined
  const providerName = providerLabel(capability?.provider ?? 'divera')
  const configured = cfg.kind === 'ok' && (capability?.configured ?? !!cfg.data.integrations?.diveraConfigured)
  const badge = cfg.kind === 'loading'
    ? <StatusBadge tone="off" label={providerName} state="…" />
    : configured
      ? <StatusBadge tone="on" label={providerName} state={C.stateConnected} />
      : <StatusBadge tone="off" label={providerName} state={cfg.kind === 'error' ? C.stateUnavailable : C.stateNotConfigured} />

  // The pool is ordered received_at desc, so the first row is the most recent alarm.
  const newest = pool.kind === 'ok' ? pool.data[0] : undefined

  return (
    <div className="adm-editor">
      <Card>
        <IntStatus badge={badge}>
          {configured ? (
            <>
              <span className="adm-int-stat">
                {pool.kind === 'loading' && C.poolLoading}
                {pool.kind === 'ok' && fillTemplate(pool.data.length === 1 ? C.poolCount : C.poolCountPlural, { n: pool.data.length })}
                {(pool.kind === 'unconfigured' || pool.kind === 'error') && C.poolUnavailable}
              </span>
              <button
                type="button"
                className="btn adm-int-btn"
                onClick={() => void onRefresh()}
                disabled={refreshing || pool.kind === 'loading'}
              >
                {refreshing ? C.refreshing : C.refresh}
              </button>
              <TestButton label={providerName} run={() => apiPost('/api/divera/pool/refresh')} />
            </>
          ) : (
            <TestButton label={providerName} run={() => apiPost('/api/divera/pool/refresh')} />
          )}
        </IntStatus>

        {configured && pool.kind === 'ok' && (
          <dl className="adm-int-facts">
            <div className="adm-int-fact">
              <dt>{C.lastAlarm}</dt>
              <dd>
                {newest
                  ? <>{newest.title || fillTemplate(C.alarmFallback, { id: newest.divera_number ?? newest.divera_id ?? '' })}
                      {newest.received_at && <span className="adm-int-muted"> · {fmtRelTime(newest.received_at)}</span>}
                    </>
                  : <span className="adm-int-muted">{C.noneInPool}</span>}
              </dd>
            </div>
            {newest?.address && (
              <div className="adm-int-fact">
                <dt>{C.address}</dt>
                <dd>{newest.address}</dd>
              </div>
            )}
          </dl>
        )}
      </Card>
    </div>
  )
}

/** @deprecated stable export for downstream imports during the provider-neutral rename. */
export const DiveraView = AlarmProviderView

// ─── Traccar (GPS) ───────────────────────────────────────────────────────────

interface TraccarStatus { configured: boolean; host?: string | null }

export function VehicleProviderView() {
  const [traccar, setTraccar] = useState<Async<TraccarStatus>>({ kind: 'loading' })
  const [positions, setPositions] = useState<Async<VehiclePosition[]>>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const st = await apiGet<TraccarStatus>('/api/traccar/status')
        if (!alive) return
        setTraccar({ kind: 'ok', data: st })
        if (st.configured) {
          try {
            const pos = await apiGet<VehiclePosition[]>('/api/traccar/positions')
            if (alive) setPositions({ kind: 'ok', data: pos })
          } catch (e) {
            if (alive) setPositions({ kind: classify(e) })
          }
        } else if (alive) {
          setPositions({ kind: 'unconfigured' })
        }
      } catch (e) {
        if (alive) {
          setTraccar({ kind: classify(e) })
          setPositions({ kind: classify(e) })
        }
      }
    })()
    return () => { alive = false }
  }, [])

  const configured = traccar.kind === 'ok' && traccar.data.configured
  const host = traccar.kind === 'ok' ? traccar.data.host : null
  const onlineCount = positions.kind === 'ok'
    ? positions.data.filter((p) => p.status === 'online').length
    : 0
  const C = appConfig.copy.admin.data
  const badge = traccar.kind === 'loading'
    ? <StatusBadge tone="off" label="Traccar (GPS)" state="…" />
    : configured
      ? <StatusBadge tone="on" label="Traccar (GPS)" state={C.stateConnected} />
      : <StatusBadge tone="off" label="Traccar (GPS)" state={traccar.kind === 'error' ? C.stateUnavailable : C.stateNotConfigured} />

  const hasDevices = configured && positions.kind === 'ok' && positions.data.length > 0
  const sortedPositions = positions.kind === 'ok'
    ? [...positions.data].sort((a, b) => a.device_name.localeCompare(b.device_name, undefined, { numeric: true, sensitivity: 'base' }))
    : []
  // Freshest signal across the fleet — a quick "is the data live?" read.
  const freshest = positions.kind === 'ok' && positions.data.length > 0
    ? positions.data.reduce<string | null>((acc, p) => {
        if (!p.last_update) return acc
        return !acc || new Date(p.last_update) > new Date(acc) ? p.last_update : acc
      }, null)
    : null

  return (
    <div className="adm-editor">
      <Card>
        <IntStatus badge={badge}>
          {configured ? (
            <span className="adm-int-stat">
              {positions.kind === 'loading' && C.vehiclesLoading}
              {positions.kind === 'ok' && (
                <>{fillTemplate(positions.data.length === 1 ? C.vehicleCount : C.vehicleCountPlural, { n: positions.data.length })}
                  {positions.data.length > 0 && (
                    <span className="adm-int-muted"> · {fillTemplate(C.onlineCount, { n: onlineCount })}</span>
                  )}
                </>
              )}
              {(positions.kind === 'unconfigured' || positions.kind === 'error') && C.positionsUnavailable}
            </span>
          ) : null}
          <TestButton label="Traccar" run={() => apiGet('/api/traccar/positions')} />
        </IntStatus>

        {configured && (host || freshest) && (
          <dl className="adm-int-facts">
            {host && (
              <div className="adm-int-fact">
                <dt>{C.server}</dt>
                <dd className="adm-mono">{host}</dd>
              </div>
            )}
            {freshest && (
              <div className="adm-int-fact">
                <dt>{C.freshestSignal}</dt>
                <dd>{fmtRelTime(freshest)}</dd>
              </div>
            )}
          </dl>
        )}

        {hasDevices && positions.kind === 'ok' && (
          <div className="adm-traccar-devices">
            <Table
              columns={[
                { key: 'dev', label: C.colDevice },
                { key: 'status', label: C.colStatus },
                { key: 'signal', label: C.colLastSignal },
                { key: 'speed', label: C.colSpeed, num: true },
              ]}
            >
              {sortedPositions.map((p) => {
                const tone = p.status === 'online' ? 'on' : p.status === 'offline' ? 'err' : 'off'
                const label = p.status === 'online' ? C.online : p.status === 'offline' ? C.offline : C.unknown
                return (
                  <tr key={p.device_id}>
                    <td><span className="adm-members-name">{p.device_name}</span></td>
                    <td>
                      <span className={`adm-badge ${tone} adm-members-status`}>
                        <span className="adm-badge-dot" aria-hidden />
                        <span className="adm-badge-state">{label}</span>
                      </span>
                    </td>
                    <td>{fmtRelTime(p.last_update)}</td>
                    <td className="adm-num adm-mono">{fmtSpeed(p.speed)}</td>
                  </tr>
                )
              })}
            </Table>
          </div>
        )}
      </Card>
    </div>
  )
}

/** @deprecated stable export for downstream imports during the provider-neutral rename. */
export const TraccarView = VehicleProviderView

// ─── Objekte & Pläne ───────────────────────────────────────────────────────────

const ObjectsMap = lazy(() => import('./ObjectsMap'))

function PlanChips({ obj }: { obj: ObjectWithPlans }) {
  if (obj.plans.length === 0) return <span className="adm-obj-noplans">{appConfig.copy.admin.data.noPlans}</span>
  return (
    <div className="adm-plan-chips">
      {obj.plans.map((plan) => (
        <span key={plan.id} className="adm-plan-chip" title={plan.title ?? plan.module ?? plan.id}>
          <span className="adm-plan-mod">{plan.module ?? plan.kind}</span>
          <span className="adm-plan-ver">v{plan.current_version}</span>
          <span className="adm-plan-date">{fmtDate(plan.updated_at)}</span>
        </span>
      ))}
    </div>
  )
}

export function ObjectsView() {
  const [state, setState] = useState<Async<ObjectWithPlans[]>>({ kind: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const objs = await listObjects()
        if (alive) setState({ kind: 'ok', data: objs })
      } catch (e) {
        if (alive) setState({ kind: classify(e) })
      }
    })()
    return () => { alive = false }
  }, [])

  const C = appConfig.copy.admin.data
  const objs = state.kind === 'ok' ? state.data : []
  // Memoised so the array identity is STABLE across re-renders (e.g. hover changes). Otherwise
  // ObjectsMap's objects-dependent effects re-run every render and the map keeps snapping back
  // to the fit-all view, discarding the selected zoom.
  const mapObjs = useMemo(() => {
    const data = state.kind === 'ok' ? state.data : []
    return data
      .filter((o): o is ObjectWithPlans & { lat: number; lng: number } => o.lat != null && o.lng != null)
      .map((o) => ({ id: o.id, name: o.name, lat: o.lat, lng: o.lng }))
  }, [state])

  return (
    <div className="adm-editor">
      <Card>
        {state.kind === 'loading' && <EmptyState message={C.objectsLoading} />}
        {state.kind === 'unconfigured' && <EmptyState message={C.objectsUnavailable} />}
        {state.kind === 'error' && <EmptyState tone="err" message={C.objectsError} />}
        {state.kind === 'ok' && state.data.length === 0 && (
          <EmptyState
            message={C.objectsNone}
            hint={<>{C.objectsHintBefore}<code>admin_objects</code>{C.objectsHintAfter}</>}
          />
        )}
        {state.kind === 'ok' && state.data.length > 0 && (
          <div className={`adm-obj-split${mapObjs.length === 0 ? ' nomap' : ''}`}>
            {mapObjs.length > 0 && (
              <div className="adm-obj-map">
                <Suspense fallback={<div className="adm-state">{C.mapLoading}</div>}>
                  <ObjectsMap
                    objects={mapObjs}
                    selectedId={selected}
                    onSelect={setSelected}
                    hoveredId={hovered}
                    onHover={setHovered}
                  />
                </Suspense>
              </div>
            )}
            <ul className="adm-obj-list">
              {objs.map((obj) => {
                const onMap = obj.lat != null && obj.lng != null
                return (
                  <li
                    key={obj.id}
                    className={`adm-obj${selected === obj.id ? ' sel' : ''}${hovered === obj.id ? ' hot' : ''}${onMap ? ' clickable' : ''}`}
                    role={onMap ? 'button' : undefined}
                    tabIndex={onMap ? 0 : undefined}
                    aria-pressed={onMap ? selected === obj.id : undefined}
                    onClick={onMap ? () => setSelected(obj.id) : undefined}
                    onKeyDown={onMap ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(obj.id) }
                    } : undefined}
                    onMouseEnter={onMap ? () => setHovered(obj.id) : undefined}
                    onMouseLeave={onMap ? () => setHovered((h) => (h === obj.id ? null : h)) : undefined}
                  >
                    <div className="adm-obj-head">
                      <span className="adm-obj-name">{obj.name}</span>
                      {obj.address && <span className="adm-obj-addr">{obj.address}</span>}
                      {!onMap && <span className="adm-obj-noloc">{C.noLocation}</span>}
                    </div>
                    <PlanChips obj={obj} />
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </Card>
    </div>
  )
}

// ─── Geodaten & Symbole ────────────────────────────────────────────────────────

export function GeodataView() {
  const [state, setState] = useState<Async<ReferenceDataset[]>>({ kind: 'loading' })
  const C = appConfig.copy.admin.data

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const refs = await listReference()
        if (alive) setState({ kind: 'ok', data: refs })
      } catch (e) {
        if (alive) setState({ kind: classify(e) })
      }
    })()
    return () => { alive = false }
  }, [])

  return (
    <div className="adm-editor">
      <Card>
        {state.kind === 'loading' && <EmptyState message={C.geodataLoading} />}
        {state.kind === 'unconfigured' && <EmptyState message={C.geodataUnavailable} />}
        {state.kind === 'error' && <EmptyState tone="err" message={C.geodataError} />}
        {state.kind === 'ok' && state.data.length === 0 && (
          <EmptyState
            message={C.geodataNone}
            hint={<>{C.geodataHintBefore}<code>admin_geodata load</code>{C.geodataHintAfter}</>}
          />
        )}
        {state.kind === 'ok' && state.data.length > 0 && (
          <Table
            columns={[
              { key: 'set', label: C.colDataset },
              { key: 'type', label: C.colType },
              { key: 'ver', label: C.colVersion },
              { key: 'date', label: C.colUpdated },
              { key: 'feat', label: C.colFeatures, num: true },
              { key: 'src', label: C.colSource },
            ]}
          >
            {state.data.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="adm-ref-title">{r.title ?? r.id}</span>
                  {r.title && <span className="adm-ref-id">{r.id}</span>}
                </td>
                <td><span className="adm-ref-kind">{r.kind}</span></td>
                <td className="adm-mono">v{r.current_version}</td>
                <td>{fmtDate(r.updated_at)}</td>
                <td className="adm-num adm-mono">
                  {r.feature_count != null ? r.feature_count : <span className="adm-int-muted">—</span>}
                </td>
                <td>
                  <span className="adm-ref-src">{r.source_type}</span>
                  {r.source_note && <span className="adm-ref-note">{r.source_note}</span>}
                  {r.size_bytes != null && <span className="adm-ref-note">{fmtBytes(r.size_bytes)}</span>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}
