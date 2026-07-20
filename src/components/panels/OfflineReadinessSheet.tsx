import { useEffect, useState } from 'react'
import { Icon } from '../../lib/icons'
import { fillTemplate } from '../../lib/format'
import { appConfig } from '../../config/appConfig'
import type { SyncStatus } from '../../lib/incidents'
import { Modal } from './_shared'

// --- Offline-Bereitschaft (readiness diagnostics) ----------------------------------
// A single glance, BEFORE losing coverage, at what field-critical data this device has
// offline. Honest by construction: bundled data (symbols, Gefahrgut) is always ready;
// runtime-cached data (map tiles, plans, Leitungen) is PROBED against the SW Cache so we
// never claim "bereit" for something that isn't actually stored; network-only data
// (Wetter, Mannschaft, Objektsuche) is labelled "nur online" so it's clear it WON'T be
// there at 3am offline. The "Alles laden" action warms everything that can be cached.
type ReadyState = 'ready' | 'online' | 'missing' | 'unknown'

const READY_META: Record<ReadyState, { dot: string; cls: string }> = {
  ready: { dot: '●', cls: 'ready' },     // stored offline — works with no signal
  online: { dot: '◐', cls: 'online' },   // works now, but only while online
  missing: { dot: '○', cls: 'missing' }, // not available
  unknown: { dot: '·', cls: 'unknown' }, // still probing
}

function ReadyRow({ label, state, note }: { label: string; state: ReadyState; note: string }) {
  const m = READY_META[state]
  return (
    <div className="or-row">
      <span className={`or-dot or-${m.cls}`} aria-hidden>{m.dot}</span>
      <span className="or-label">{label}</span>
      <span className={`or-note or-${m.cls}`}>{note}</span>
    </div>
  )
}

function fmtAgo(ms: number | null): string {
  const o = appConfig.copy.offline
  if (ms == null) return o.agoNever
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return o.agoJustNow
  const min = Math.round(s / 60)
  if (min < 60) return fillTemplate(o.agoMin, { n: min })
  const h = Math.round(min / 60)
  return fillTemplate(o.agoHour, { n: h })
}

export function OfflineReadinessSheet({
  onClose, probeUrls, symbolsReady, planCount, objectLabel,
  weatherOk, weatherError, personnelCount, syncStatus, lastSyncedAt,
  onSyncNow, onLoadAll, loading, progress,
}: {
  onClose: () => void
  /** URLs probed against the SW Cache for real offline presence. tiles = the incident-centre
   *  tile across all base subdomains (any hit = cached); geojsons = every Leitungs layer. */
  probeUrls: { tiles: string[]; plan: string | null; geojsons: string[] }
  symbolsReady: boolean
  planCount: number
  objectLabel: string | null
  weatherOk: boolean
  weatherError: boolean
  personnelCount: number
  syncStatus: SyncStatus
  lastSyncedAt: number | null
  /** push any edits queued while offline (also fires automatically on reconnect) */
  onSyncNow: () => void
  /** warm everything cacheable (tiles, plans, symbols, geojson) + refresh the roster */
  onLoadAll: () => void
  loading: boolean
  progress: { done: number; total: number } | null
}) {
  // Probe the Cache Storage for the runtime-cached resources (tiles/plans/geojson). undefined
  // while probing → 'unknown'; re-run after a load via the nonce so the rows update live.
  const [probe, setProbe] = useState<{ tile?: boolean; plan?: boolean; geo?: { cached: number; total: number } }>({})
  const geoKey = probeUrls.geojsons.join(',')
  useEffect(() => {
    let alive = true
    const has = async (url: string | null): Promise<boolean | undefined> => {
      if (!url || typeof caches === 'undefined') return undefined
      try { return !!(await caches.match(url)) } catch { return undefined }
    }
    void (async () => {
      const [tileHits, plan] = await Promise.all([
        Promise.all(probeUrls.tiles.map((u) => has(u))),
        has(probeUrls.plan),
      ])
      const tile = probeUrls.tiles.length ? tileHits.some(Boolean) : undefined
      let geo: { cached: number; total: number } | undefined
      if (probeUrls.geojsons.length) {
        const hits = await Promise.all(probeUrls.geojsons.map((u) => has(u)))
        geo = { cached: hits.filter(Boolean).length, total: probeUrls.geojsons.length }
      }
      if (alive) setProbe({ tile, plan, geo })
    })()
    return () => { alive = false }
  }, [probeUrls.tiles.join(','), probeUrls.plan, geoKey, loading, progress?.done])

  const o = appConfig.copy.offline
  const probed = (v: boolean | undefined, readyNote: string): { s: ReadyState; n: string } =>
    v === undefined ? { s: 'unknown', n: o.checking } : v ? { s: 'ready', n: readyNote } : { s: 'missing', n: o.notLoaded }

  const tile = probed(probe.tile, o.ready)
  const plan = planCount === 0
    ? { s: 'missing' as ReadyState, n: o.noObject }
    : probed(probe.plan, o.ready)
  // every Leitungs/Hydranten layer: all cached → bereit, some → "X/N geladen", none → nicht geladen
  const geo: { s: ReadyState; n: string } = probeUrls.geojsons.length === 0
    ? { s: 'missing', n: o.noLayer }
    : probe.geo === undefined
      ? { s: 'unknown', n: o.checking }
      : probe.geo.cached === 0
        ? { s: 'missing', n: o.notLoaded }
        : probe.geo.cached >= probe.geo.total
          ? { s: 'ready', n: fillTemplate(o.geoAllReady, { n: probe.geo.total }) }
          : { s: 'online', n: fillTemplate(o.geoSome, { cached: probe.geo.cached, total: probe.geo.total }) }

  const syncMark = syncStatus === 'synced' ? <Icon id="check" /> : syncStatus === 'error' ? <Icon id="warn" /> : <span className="ip-status-dot" />
  const syncText = syncStatus === 'synced'
    ? fillTemplate(o.syncedAgo, { ago: fmtAgo(lastSyncedAt) })
    : syncStatus === 'offline'
      ? o.offline
      : syncStatus === 'pending'
        ? o.pending
        : o.error

  return (
    <Modal title={o.title} onClose={onClose} fit>
      <div className="or-sheet">
        <div className={`or-stand or-sync-${syncStatus}`}>
          {/* always offered — a manual refresh must be reachable even when the badge claims
              synced, e.g. when the operator suspects another device's edit hasn't landed yet */}
          {syncMark}<span>{syncText}</span>
          <button className="or-resync" onClick={onSyncNow}><Icon id="rotate" /> {o.syncNow}</button>
        </div>

        <div className="or-list">
          <ReadyRow label={o.rowSymbols} state={symbolsReady ? 'ready' : 'unknown'} note={symbolsReady ? o.ready : o.loading} />
          <ReadyRow label={o.rowHazmat} state="ready" note={o.ready} />
          <ReadyRow label={`${o.rowMap}${probeUrls.tiles.length ? '' : ` (${o.noLayer})`}`} state={probeUrls.tiles.length ? tile.s : 'unknown'} note={tile.n} />
          <ReadyRow label={planCount > 0 ? `${o.rowPlans} · ${objectLabel ?? `${planCount}`}` : o.rowPlans} state={plan.s} note={plan.n} />
          <ReadyRow label={o.rowLeitung} state={geo.s} note={geo.n} />
          <ReadyRow label={o.rowWeather} state={weatherError ? 'missing' : weatherOk ? 'online' : 'unknown'} note={weatherError ? o.weatherUnreachable : weatherOk ? o.onlineOnly : o.loading} />
          <ReadyRow label={o.rowPersonnel} state={personnelCount > 0 ? 'ready' : 'missing'} note={personnelCount > 0 ? fillTemplate(o.personnelCount, { n: personnelCount }) : o.notLoaded} />
          <ReadyRow label={o.rowObjectSearch} state="online" note={o.onlineOnly} />
        </div>

        {loading ? (
          <div className="or-prog" role="progressbar"
            aria-valuemin={0} aria-valuemax={progress?.total ?? 0} aria-valuenow={progress?.done ?? 0}>
            <div className="or-prog-track">
              <div className="or-prog-fill" style={{ width: `${progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
            </div>
            <div className="or-prog-meta">
              <span>{o.loadingForOffline}</span>
              <span className="or-prog-pct">{progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0} %</span>
            </div>
          </div>
        ) : (
          <button className="or-load" onClick={onLoadAll}>
            <Icon id="map" /> {o.loadAll}
          </button>
        )}
        <p className="or-foot">
          {o.foot}
        </p>
      </div>
    </Modal>
  )
}
