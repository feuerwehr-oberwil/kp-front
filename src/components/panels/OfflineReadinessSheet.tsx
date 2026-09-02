import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../lib/icons'
import { SyncGlyph } from '../SyncGlyph'
import { fillTemplate } from '../../lib/format'
import { appConfig } from '../../config/appConfig'
import type { SyncStatus } from '../../lib/incidents'
import { isStorageDegraded, onStorageDegraded } from '../../lib/idb'
import { getInstallPlatform, isStandalone } from '../../lib/installPrompt'
import { installOffered } from '../../lib/installPolicy'
import { estimateStorage, fmtBytes } from '../../lib/storageBudget'
import { Modal } from './_shared'
import { InstallSteps } from '../InstallGuide'

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
  onSyncNow, onLoadAll, onCancel, loading, progress,
}: {
  onClose: () => void
  /** URLs probed against the SW Cache for real offline presence. tiles = the incident-centre
   *  tile across all base subdomains (any hit = cached); references = every vector/raster layer. */
  probeUrls: { tiles: string[]; plan: string | null; references: string[] }
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
  /** abort a running download — what is already stored stays stored, the button returns */
  onCancel: () => void
  loading: boolean
  progress: { done: number; total: number } | null
}) {
  // A browser TAB is not an offline state worth diagnosing: iOS evicts caches after days
  // without use, and the tab has to still exist at the next Einsatz. Probing it and printing
  // «bereit» is exactly the stale reassurance this sheet exists to remove — so outside the
  // installed app it says what is missing and how to fix it, and nothing else.
  const browserOnly = !isStandalone()
  // Probe the Cache Storage for the runtime-cached resources (tiles/plans/geojson). undefined
  // while probing → 'unknown'; re-run after a load via the nonce so the rows update live.
  const [probe, setProbe] = useState<{ tile?: boolean; plan?: boolean; geo?: { cached: number; total: number } }>({})
  const referenceKey = probeUrls.references.join(',')
  useEffect(() => {
    if (browserOnly) return // no readiness list is rendered there — don't probe for it
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
      if (probeUrls.references.length) {
        const hits = await Promise.all(probeUrls.references.map((u) => has(u)))
        geo = { cached: hits.filter(Boolean).length, total: probeUrls.references.length }
      }
      if (alive) setProbe({ tile, plan, geo })
    })()
    return () => { alive = false }
  }, [probeUrls.tiles.join(','), probeUrls.plan, referenceKey, loading, progress?.done])

  // Free space is itself a readiness fact, and the one nothing used to report: a full device
  // caches NOTHING for offline no matter how green every other row is. Re-probed after a load so
  // the figure reflects what «Alles laden» just consumed.
  const [space, setSpace] = useState<{ free: number } | null | undefined>(undefined)
  useEffect(() => {
    if (browserOnly) return
    let alive = true
    void estimateStorage().then((b) => { if (alive) setSpace(b) })
    return () => { alive = false }
  }, [loading, progress?.done])
  // Subscribed, not read once at render: a write can be refused WHILE this sheet is open (the
  // «Alles laden» button is right here), and a readiness sheet that keeps claiming "bereit" after
  // storage gave out would be the very kind of stale reassurance this whole change removes.
  const [degraded, setDegraded] = useState(isStorageDegraded)
  useEffect(() => onStorageDegraded(setDegraded), [])

  // A finished «Alles laden» used to just vanish: the bar hit 100 % and the button was back, with
  // nothing saying it worked. For a moment the bar's place speaks the sync-glyph vocabulary
  // instead — closed ring, tick, «bereit» — before the button returns. The rows above stay the
  // authority on WHAT is ready (a partial download also toasts its own warning); this only closes
  // the gesture. Not persisted: reopening the sheet later shows the rows, not a stale tick.
  const [justLoaded, setJustLoaded] = useState(false)
  const wasLoading = useRef(loading)
  useEffect(() => {
    const was = wasLoading.current
    wasLoading.current = loading
    if (was && !loading) {
      setJustLoaded(true)
      const t = setTimeout(() => setJustLoaded(false), 2500)
      return () => clearTimeout(t)
    }
  }, [loading])

  const o = appConfig.copy.offline
  const probed = (v: boolean | undefined, readyNote: string): { s: ReadyState; n: string } =>
    v === undefined ? { s: 'unknown', n: o.checking } : v ? { s: 'ready', n: readyNote } : { s: 'missing', n: o.notLoaded }

  const tile = probed(probe.tile, o.ready)
  const plan = planCount === 0
    ? { s: 'missing' as ReadyState, n: o.noObject }
    : probed(probe.plan, o.ready)
  // every Leitungs/Hydranten layer: all cached → bereit, some → "X/N geladen", none → nicht geladen
  const geo: { s: ReadyState; n: string } = probeUrls.references.length === 0
    ? { s: 'missing', n: o.noLayer }
    : probe.geo === undefined
      ? { s: 'unknown', n: o.checking }
      : probe.geo.cached === 0
        ? { s: 'missing', n: o.notLoaded }
        : probe.geo.cached >= probe.geo.total
          ? { s: 'ready', n: fillTemplate(o.geoAllReady, { n: probe.geo.total }) }
          : { s: 'online', n: fillTemplate(o.geoSome, { cached: probe.geo.cached, total: probe.geo.total }) }

  const syncMark = syncStatus === 'synced'
    ? <Icon id="check" />
    : syncStatus === 'error' || syncStatus === 'storage' ? <Icon id="warn" /> : <span className="ip-status-dot" />
  const syncText = syncStatus === 'synced'
    ? fillTemplate(o.syncedAgo, { ago: fmtAgo(lastSyncedAt) })
    : syncStatus === 'offline'
      ? o.offline
      : syncStatus === 'pending'
        ? o.pending
        : syncStatus === 'storage'
          ? o.storageFull // must NOT fall through to o.error: nothing failed to sync, the DEVICE is full
          : o.error

  // The sync line stays in BOTH states: it answers «sind meine Einträge weg?», which is a
  // live question in a browser tab too, and it carries the only manual resync there is.
  const syncRow = (
    <div className={`or-stand or-sync-${syncStatus}`}>
      {/* always offered — a manual refresh must be reachable even when the badge claims
          synced, e.g. when the operator suspects another device's edit hasn't landed yet */}
      {syncMark}<span>{syncText}</span>
      <button className="or-resync" onClick={onSyncNow}><Icon id="rotate" /> {o.syncNow}</button>
    </div>
  )

  if (browserOnly) {
    const canInstall = installOffered(getInstallPlatform())
    return (
      <Modal title={o.title} onClose={onClose} fit>
        <div className="or-sheet">
          {syncRow}
          <div className="or-browser">
            <Icon id="info" />
            <div>
              <p className="or-browser-t">{o.browserTitle}</p>
              <p className="or-browser-b">{o.browserBody}</p>
              {!canInstall && <p className="or-browser-b">{o.browserNoInstall}</p>}
            </div>
          </div>
          {/* The steps stand here rather than behind a button into a second modal — this sheet
              is already the answer to "how do I get offline", and four lines do not deserve
              their own screen.
              «Alles für offline laden» is deliberately NOT offered: the card directly above
              says offline needs the installed app, and a download button under that sentence
              contradicts it. It still runs in the installed sheet, where the claim holds. */}
          {canInstall && <div className="or-install"><InstallSteps lead={false} /></div>}
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={o.title} onClose={onClose} fit>
      <div className="or-sheet">
        {syncRow}

        <div className="or-list">
          <ReadyRow label={o.rowSymbols} state={symbolsReady ? 'ready' : 'unknown'} note={symbolsReady ? o.ready : o.loading} />
          <ReadyRow label={o.rowHazmat} state="ready" note={o.ready} />
          <ReadyRow label={`${o.rowMap}${probeUrls.tiles.length ? '' : ` (${o.noLayer})`}`} state={probeUrls.tiles.length ? tile.s : 'unknown'} note={tile.n} />
          <ReadyRow label={planCount > 0 ? `${o.rowPlans} · ${objectLabel ?? `${planCount}`}` : o.rowPlans} state={plan.s} note={plan.n} />
          <ReadyRow label={o.rowLeitung} state={geo.s} note={geo.n} />
          <ReadyRow label={o.rowWeather} state={weatherError ? 'missing' : weatherOk ? 'online' : 'unknown'} note={weatherError ? o.weatherUnreachable : weatherOk ? o.onlineOnly : o.loading} />
          <ReadyRow label={o.rowPersonnel} state={personnelCount > 0 ? 'ready' : 'missing'} note={personnelCount > 0 ? fillTemplate(o.personnelCount, { n: personnelCount }) : o.notLoaded} />
          <ReadyRow label={o.rowObjectSearch} state="online" note={o.onlineOnly} />
          {/* Device storage: 'missing' whenever a write has actually been refused — that outranks
              a healthy-looking free figure, since it's the observed fact rather than an estimate. */}
          <ReadyRow
            label={o.rowStorage}
            state={degraded ? 'missing' : space === undefined ? 'unknown' : space === null ? 'online' : 'ready'}
            note={degraded
              ? o.storageFullShort
              : space === undefined ? o.checking
                : space === null ? o.storageUnknown
                  : fillTemplate(o.storageFree, { size: fmtBytes(space.free) })}
          />
        </div>

        {loading ? (
          <div className="or-prog" role="progressbar"
            aria-valuemin={0} aria-valuemax={progress?.total ?? 0} aria-valuenow={progress?.done ?? 0}>
            <div className="or-prog-track">
              <div className="or-prog-fill" style={{ width: `${progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
            </div>
            <div className="or-prog-meta">
              <span>{o.loadingForOffline}</span>
              <span className="or-prog-end">
                <span className="or-prog-pct">{progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0} %</span>
                {/* the download had no way out until 02.09.: three workers on a dead WLAN ran until
                    their timeouts, and the button under them was gone for the duration */}
                <button type="button" className="ip-btn ghost or-prog-cancel" onClick={onCancel}>{o.cancel}</button>
              </span>
            </div>
          </div>
        ) : justLoaded ? (
          <div className="or-done" role="status">
            <SyncGlyph done label={o.ready} />
            <span>{o.ready}</span>
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
