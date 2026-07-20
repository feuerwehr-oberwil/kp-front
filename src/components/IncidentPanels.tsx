// Incident-management UI for Phases 2–7: the TopBar incident switcher and the
// modal panels for create (4), Divera pool (3), history (5), and Datenquellen (7).
// All talk to the backend via src/lib/incidents.ts. German UI, dark "Karte Minimal".

import { Fragment, useEffect, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { toast, confirmDialog } from '../lib/ui'
import { dismissAlarm, loadDismissedAlarms } from '../lib/diveraDismiss'
import { ApiError } from '../lib/api'
import { initials, roleLabel, fillTemplate, fmtElapsedHM } from '../lib/format'
import { filterIncidents, historyGroupKey, monthLabel } from '../lib/historyGroups'
import { getLocaleId } from '../config/copy'
import { loadPrefs, savePrefs, applyTheme, resolveTheme, type ThemeMode, type SymbolSize } from '../lib/prefs'
import { buildLabel } from '../lib/buildInfo'
import { useGeoPosition } from '../lib/useGeoPosition'
import { useHoldRepeat } from '../lib/useHoldRepeat'
import { useIsPhone } from '../lib/useIsPhone'
import { useTapToType } from '../lib/useTapToType'
import { MapPicker } from './MapPicker'
import { DateTimeField } from './TimeField'
import { Combo } from './Combo'
import { EmptyState } from './EmptyState'
import { appConfig } from '../config/appConfig'
import type { IncidentSettings } from '../lib/workspace'
import type { CaptionMode } from '../types'
import { atemschutzDoctrine, externalMapLinks, getDeploymentConfig, isDemoMode, shortAddress } from '../lib/deploymentConfig'
import {
  createIncident,
  deleteIncident,
  geocodeReverse,
  geocodeSearch,
  getIncident,
  listIncidents,
  listObjects,
  listPersonnel,
  listReference,
  patchIncident,
  reactivateIncident,
  takeDiveraAlarm,
  uploadReference,
  upsertReferenceLayer,
  inspectGeojson,
  type DiveraAlarm,
  type GeoHit,
  type IncidentFull,
  type IncidentMeta,
  type ObjectWithPlans,
  type ReferenceDataset,
  type SyncStatus,
} from '../lib/incidents'

function Modal({ title, onClose, children, wide, fit }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; fit?: boolean }) {
  return (
    <div className="ip-ovl" onClick={onClose}>
      {/* `fit` = height hugs the content (capped), for short one-off modals that would otherwise
          leave a big empty bottom in the uniform 800px frame */}
      <div className={`ip-sheet${wide ? ' ip-wide' : ''}${fit ? ' ip-fit' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="ip-head">
          <h2>{title}</h2>
          <button className="ip-x" onClick={onClose} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
        </div>
        <div className="ip-body">{children}</div>
      </div>
    </div>
  )
}

/** A `.set-step` ±stepper for the Einstellungen sheet: press-and-hold to repeat, and tap the
 *  value to type an exact number (clamped to [min,max]). Disabled greys the whole control. */
function SetStep({ value, min, max, step = 1, format, onChange, disabled, label }: {
  value: number
  min: number
  max: number
  step?: number
  format: (v: number) => string
  onChange: (v: number) => void
  disabled?: boolean
  label: string
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v))
  const dec = useHoldRepeat(() => onChange(clamp(value - step)))
  const inc = useHoldRepeat(() => onChange(clamp(value + step)))
  const edit = useTapToType({ min, max, onCommit: onChange })
  const st = appConfig.copy.stepper
  return (
    <span className="set-step">
      <button {...(disabled ? {} : dec)} disabled={disabled || value <= min} aria-label={`${label} ${st.less}`}><Icon id="minus" /></button>
      {edit.editing ? (
        <input className="set-step-input" {...edit.inputProps} />
      ) : (
        <button className="set-step-val" onClick={() => edit.start(value)} disabled={disabled} title={st.typeToEnter}>{format(value)}</button>
      )}
      <button {...(disabled ? {} : inc)} disabled={disabled || value >= max} aria-label={`${label} ${st.more}`}><Icon id="plus" /></button>
    </span>
  )
}

/** Einstellungen: device prefs (theme, symbol size — local cookie) in one section, and
 *  synced per-incident settings (Atemschutz interval — stored in the workspace blob, so
 *  every device sees the same value) in another. The split is intentional: device prefs may
 *  differ per device without harm; the synced safety threshold must not (see IncidentSettings).
 *  Also opens from the landing card with no incident: omit settings/onSettings and the
 *  synced section disappears (device prefs need no workspace). */
export function SettingsSheet({
  onClose, symbolSize, onSymbolSize, symbolCaptions, onSymbolCaptions, offlineRadiusM, onOfflineRadius, keepScreenOn, onKeepScreenOn, themeCoord, settings, onSettings, canEdit, elView, onElView,
}: {
  onClose: () => void
  symbolSize: SymbolSize
  onSymbolSize: (s: SymbolSize) => void
  /** on-canvas symbol captions (Aus/Auto/Alle) — device pref like symbolSize */
  symbolCaptions: CaptionMode
  onSymbolCaptions: (m: CaptionMode) => void
  /** radius (m) cached around the incident for offline + scope of the Leitungskataster layers */
  offlineRadiusM: number
  onOfflineRadius: (m: number) => void
  /** keep the screen awake while an incident is open — device pref, default on */
  keepScreenOn: boolean
  onKeepScreenOn: (v: boolean) => void
  themeCoord: [number, number] | null
  /** synced per-incident settings — undefined (landing, no incident) hides the section */
  settings?: IncidentSettings
  onSettings?: (next: IncidentSettings) => void
  /** only the Einsatzleiter may change the synced section */
  canEdit?: boolean
  /** Einsatzleiter-Ansicht device toggle — undefined hides the row (viewers: their whole
   *  session is read-only anyway, the toggle would be meaningless). Stays operable in EL
   *  view itself (it must — it's the way back out). */
  elView: boolean
  onElView?: (v: boolean) => void
}) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadPrefs().theme ?? 'auto')
  const setTheme = (m: ThemeMode) => {
    setThemeMode(m)
    savePrefs({ ...loadPrefs(), theme: m })
    applyTheme(resolveTheme(m, themeCoord, new Date()))
  }
  const az = atemschutzDoctrine() // deployment override → appConfig defaults
  const intervalMin = settings?.contactIntervalMin ?? az.contactIntervalMin
  const graceSec = settings?.contactGraceSec ?? az.contactGraceSec
  const setIntervalMin = (v: number) => { if (settings && onSettings) onSettings({ ...settings, contactIntervalMin: Math.max(1, Math.min(60, v)) }) }
  const setGraceSec = (v: number) => { if (settings && onSettings) onSettings({ ...settings, contactGraceSec: Math.max(0, Math.min(300, v)) }) }
  const funkkanal = settings?.defaultFunkkanal ?? az.defaultFunkkanal
  const setFunkkanal = (v: number) => { if (settings && onSettings) onSettings({ ...settings, defaultFunkkanal: Math.max(az.funkkanalMin, Math.min(az.funkkanalMax, v)) }) }

  const themeOpts: { m: ThemeMode; label: string }[] = [
    { m: 'auto', label: appConfig.copy.nav.autoMode },
    { m: 'day', label: appConfig.copy.nav.dayMode },
    { m: 'night', label: appConfig.copy.nav.nightMode },
  ]
  const captionOpts: { m: CaptionMode; label: string }[] = [
    { m: 'off', label: appConfig.copy.settings.captionsOff },
    { m: 'auto', label: appConfig.copy.settings.captionsAuto },
    { m: 'all', label: appConfig.copy.settings.captionsAll },
  ]

  const cp = appConfig.copy.settings

  // Leeres Erfassungsblatt — per-device utility ACTION (not a setting): an AdFU can produce
  // a fresh paper hand-fill sheet in the field. Same generator as the admin's Erfassung view;
  // the jsPDF chunk loads lazily so it stays out of the critical bundle. A failed roster
  // fetch (offline) still yields a usable sheet with blank guest lines.
  const [sheetBusy, setSheetBusy] = useState(false)
  const downloadBlankSheet = async () => {
    if (sheetBusy) return
    setSheetBusy(true)
    let names: string[] = []
    try {
      names = (await listPersonnel())
        .filter((p) => p.active)
        .map((p) => p.displayName)
        .sort((a, b) => a.localeCompare(b, 'de-CH'))
    } catch { /* roster unavailable → the blank guest lines still make a usable sheet */ }
    try {
      const { downloadSheetPdf } = await import('../admin/capturePdf')
      const dc = getDeploymentConfig()
      downloadSheetPdf({
        stationName: dc.identity?.appName ?? 'KP Front',
        names,
        catalogue: dc.mittel?.catalogue ?? appConfig.mittel.catalogue,
        groups: dc.alarms?.groups ?? [],
        vehicles: dc.fleet?.vehicles ?? [],
        partnerOrgs: dc.report?.partnerOrgs ?? [],
      })
    } catch {
      toast(cp.blankSheetFailed, { icon: 'warn', tone: 'warn' })
    } finally { setSheetBusy(false) }
  }

  return (
    <Modal title={cp.title} onClose={onClose}>
      <div className="set-sheet">
        <section className="set-group">
          <h3 className="set-group-t">{cp.deviceGroup}</h3>
          <div className="set-card">
            <div className="set-row">
              <span className="set-row-l">{cp.colorScheme}</span>
              <span className="set-seg" role="group" aria-label={cp.colorScheme}>
                {themeOpts.map(({ m, label }) => (
                  <button key={m} className={`set-seg-btn${themeMode === m ? ' on' : ''}`} aria-pressed={themeMode === m} onClick={() => setTheme(m)}>{label}</button>
                ))}
              </span>
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.symbolSize}</span>
              <span className="set-seg" role="group" aria-label={cp.symbolSize}>
                {(['S', 'M', 'L'] as SymbolSize[]).map((s) => (
                  <button key={s} className={`set-seg-btn${symbolSize === s ? ' on' : ''}`} aria-pressed={symbolSize === s} onClick={() => onSymbolSize(s)}>{s}</button>
                ))}
              </span>
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.symbolCaptions}<small>{cp.symbolCaptionsSub}</small></span>
              <span className="set-seg" role="group" aria-label={cp.symbolCaptions}>
                {captionOpts.map(({ m, label }) => (
                  <button key={m} className={`set-seg-btn${symbolCaptions === m ? ' on' : ''}`} aria-pressed={symbolCaptions === m} onClick={() => onSymbolCaptions(m)}>{label}</button>
                ))}
              </span>
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.offlineRadius}<small>{cp.offlineRadiusSub}</small></span>
              <SetStep value={offlineRadiusM} min={500} max={3000} step={250} format={(v) => (v < 1000 ? `${v} m` : `${v / 1000} km`)} onChange={onOfflineRadius} label={cp.offlineRadius} />
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.keepScreenOn}<small>{cp.keepScreenOnSub}</small></span>
              <span className="set-seg" role="group" aria-label={cp.keepScreenOn}>
                {([['on', true], ['off', false]] as const).map(([k, v]) => (
                  <button key={k} className={`set-seg-btn${keepScreenOn === v ? ' on' : ''}`} aria-pressed={keepScreenOn === v} onClick={() => onKeepScreenOn(v)}>
                    {k === 'on' ? cp.keepScreenOnOn : cp.keepScreenOnOff}
                  </button>
                ))}
              </span>
            </div>
            {onElView && (
              <div className="set-row">
                <span className="set-row-l">{cp.elView}<small>{cp.elViewSub}</small></span>
                <span className="set-seg" role="group" aria-label={cp.elView}>
                  {([['on', true], ['off', false]] as const).map(([k, v]) => (
                    <button key={k} className={`set-seg-btn${elView === v ? ' on' : ''}`} aria-pressed={elView === v} onClick={() => onElView(v)}>
                      {k === 'on' ? cp.elViewOn : cp.elViewOff}
                    </button>
                  ))}
                </span>
              </div>
            )}
          </div>
          <p className="set-group-foot">{cp.deviceFoot}</p>
        </section>

        {settings && onSettings && (
        <section className="set-group">
          <h3 className="set-group-t">{cp.incidentGroup}</h3>
          <div className="set-card">
            <div className="set-row">
              <span className="set-row-l">{cp.contactInterval}<small>{cp.contactIntervalSub}</small></span>
              <SetStep value={intervalMin} min={1} max={60} format={(v) => `${v} min`} onChange={setIntervalMin} disabled={!canEdit} label={cp.contactIntervalAria} />
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.grace}<small>{cp.graceSub}</small></span>
              <SetStep value={graceSec} min={0} max={300} step={15} format={(v) => `${v} s`} onChange={setGraceSec} disabled={!canEdit} label={cp.grace} />
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.funkkanal}<small>{cp.funkkanalSub}</small></span>
              <SetStep value={funkkanal} min={az.funkkanalMin} max={az.funkkanalMax} format={(v) => `K ${v}`} onChange={setFunkkanal} disabled={!canEdit} label={cp.funkkanal} />
            </div>
          </div>
          <p className="set-group-foot">
            {cp.syncedFoot}{!canEdit ? cp.syncedFootViewer : ''}.
          </p>
        </section>
        )}

        <section className="set-group">
          <h3 className="set-group-t">{cp.utilityGroup}</h3>
          <div className="set-card">
            <div className="set-row">
              <span className="set-row-l">{cp.blankSheet}<small>{cp.blankSheetSub}</small></span>
              <button type="button" className="set-dl" disabled={sheetBusy} onClick={() => void downloadBlankSheet()}>
                <Icon id="doc" /> {cp.blankSheetDownload}
              </button>
            </div>
          </div>
        </section>
      </div>
    </Modal>
  )
}

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

function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

// HH:MM for the positive "gespeichert" trust signal next to the sync badge.
function fmtClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// --- TopBar switcher ----------------------------------------------------------------
export function IncidentSwitcher({
  active, incidents, isEditor, syncStatus, lastSyncedAt, user, onSettings, onSwitch, onHistory, onDivera, onReportPrint, onArchive, onHelp, onInstall, onOfflineReadiness, onSyncNow, onLogout, navKey, objectName, onObjectSwitch,
}: {
  active: IncidentMeta | null
  incidents: IncidentMeta[]
  isEditor: boolean
  syncStatus: SyncStatus
  lastSyncedAt: number | null
  user: { display_name: string; color: string | null; role: string }
  /** open the Einstellungen sheet (device prefs + synced incident settings) */
  onSettings: () => void
  onSwitch: (i: IncidentMeta) => void
  onHistory: () => void
  onDivera: () => void
  onDatenquellen: () => void
  onReportPrint: () => void
  /** archive the ACTIVE incident (behind the caller's «wirklich abschliessen?» confirm);
   *  absent for viewers / read-only views / an already-archived incident */
  onArchive?: () => void
  onHelp: () => void
  /** open the "Als App installieren" guide — App passes it only in a plain browser tab */
  onInstall?: () => void
  onOfflineReadiness: () => void
  /** push edits queued while offline (also auto-fires on reconnect) */
  onSyncNow: () => void
  onLogout: () => void
  /** changes whenever the app navigates to another surface — closes a menu that was left
   *  open under a sheet (e.g. Rapport → Anwesenheit must not land back in the menu) */
  navKey?: string
  /** active Einsatzobjekt (manual pick or auto-surfaced nearest); shown on the object row */
  objectName?: string | null
  /** open the PlanPicker («Anderes Objekt») — the row replaces the old NavRail footer item */
  onObjectSwitch?: () => void
}) {
  const cp = appConfig.copy.incidentSwitcher
  const badgeTitle: Record<Exclude<SyncStatus, 'synced'>, string> = {
    pending: cp.badgePending, offline: cp.badgeOffline, error: cp.badgeError,
  }
  const [open, setOpen] = useState(false)
  // Einsatzbeginn/-dauer row in the dropdown (phones hide the TopBar clocks, so the times
  // live here) — tick once a minute while open so the Dauer stays current
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [open])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // clicks inside an overlay sheet/dialog don't count as "outside": on phones the menu
    // deliberately stays open underneath a sheet it opened (see openSheet below)
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Element
      if (ref.current && !ref.current.contains(t) && !t.closest?.('.ip-ovl, .help-scrim, .confirm-backdrop, .toaster')) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  // On phones a sheet opened from the menu keeps the menu open underneath (the overlay
  // covers it), so closing the sheet lands back in the menu instead of on the map — no
  // re-tapping the dropdown between two lookups. Desktop closes as usual (the floating
  // menu would sit beside the sheet there). Incident switch/eröffnen/logout always close.
  const isPhone = useIsPhone()
  const openSheet = (fn: () => void) => { fn(); if (!isPhone) setOpen(false) }
  // …but a sheet action that NAVIGATES (Rapport → Anwesenheit/Mittel/Verlauf) must not
  // leave the menu sitting on the new surface — any surface change closes it
  useEffect(() => { setOpen(false) }, [navKey])

  // Sync state surfaced two ways: a FIXED-WIDTH coloured mark in the header (so the constant
  // saving↔saved flip never shifts the title/chevron — no inline time/label), and the full
  // text + save time in the dropdown the user taps open (hover tooltips don't fire on a tablet).
  const savedText = syncStatus === 'synced'
    ? (lastSyncedAt != null ? fillTemplate(cp.savedAt, { t: fmtClock(lastSyncedAt) }) : cp.saved)
    : badgeTitle[syncStatus]
  const statusMark = syncStatus === 'synced'
    ? <Icon id="check" />
    : syncStatus === 'error'
      ? <Icon id="warn" />
      : <span className="ip-status-dot" />
  return (
    <div className="ip-switch" ref={ref}>
      <button className="ip-switch-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {/* phones: the title is CSS-hidden (a one-letter stump helped nobody) — a doc glyph
            marks the button; the full title heads the dropdown instead */}
        <span className="ip-switch-glyph" aria-hidden><Icon id="doc" /></span>
        <span className="ip-switch-title">{active ? active.title : cp.noIncident}</span>
        {/* persistent ÜBUNG marker in the chrome — a training must never read as a real
            Einsatz mid-use (it also survives the phone's CSS-hidden title) */}
        {active?.is_exercise && <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>}
        {/* Offline and sync-error get a LOUD text chip (not just the tiny mark) — offline
            blocks switching incidents to the server, and a failing sync means edits are
            stranded on this device; the operator needs to recognise both at a glance
            WITHOUT opening the dropdown (there is deliberately no persistent banner). */}
        {active && syncStatus === 'offline' ? (
          <span className="ip-offline-chip" title={savedText} aria-label={savedText}>
            <span className="ip-status-dot" />{cp.offlineShort}
          </span>
        ) : active && syncStatus === 'error' ? (
          <span className="ip-offline-chip ip-error-chip" title={savedText} aria-label={savedText}>
            <Icon id="warn" />{cp.errorShort}
          </span>
        ) : active && (
          <span className={`ip-status ip-status-${syncStatus}`} title={savedText} aria-label={savedText}>
            {statusMark}
          </span>
        )}
        <Icon id="chevron-down" />
      </button>
      {open && (
        <div className="ip-menu">
          {/* Three zones (field feedback 2026-07-09): ① the current incident as a plain
              HEADER card — title (phone-only, the button shows it on larger screens),
              address, two small meta lines, icon-only Sync — plus its actions
              (Einsatzrapport, Einsatz abschliessen); ② Einsätze — the OTHER incidents +
              eröffnen + alle, all as rows; ③ utility rows + user. The round-4 rule was "no
              destructive actions in this menu" (a stray per-row ✕ closed old incidents in
              one tap); the labeled «abschliessen» row below is the sanctioned exception
              (field request 2026-07-12): it goes through the same «wirklich abschliessen?»
              confirm as «Alle Einsätze», and archiving stays reversible via Reaktivieren.
              Closing OTHER incidents still lives only in «Alle Einsätze». */}
          {active && (
            <>
              <div className="ip-menu-head">
                <div className="ip-menu-headmain">
                  <span className="ip-menu-headtitle">
                    {active.title}
                    {active.is_exercise && <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>}
                  </span>
                  {active.address && <span className="ip-menu-sub">{active.address}</span>}
                  <span className={`ip-menu-metaline ip-status-${syncStatus}`}>{statusMark}<span>{savedText}</span></span>
                  {active.started_at && (
                    <span className="ip-menu-metaline"><Icon id="clock" /><span>{fillTemplate(cp.startedRow, { t: fmtClock(Date.parse(active.started_at)), d: fmtElapsedHM(now - Date.parse(active.started_at)) })}</span></span>
                  )}
                </div>
                {/* always offered (not only on offline/error): forces a push AND an immediate
                    pull, the "make everything fresh right now" action when things feel stale */}
                <button className="ip-menu-resync" onClick={() => { onSyncNow(); }} aria-label={cp.syncNow} title={cp.syncNow}>
                  <Icon id="rotate" />
                </button>
              </div>
              {/* Einsatzdaten editing lives inside the Einsatzrapport (its "Bearbeiten" link),
                  not as a second menu entry — see ReportPreflight. */}
              <button className="ip-menu-act" onClick={() => openSheet(onReportPrint)}><Icon id="doc" /> {cp.report}</button>
              {/* Einsatzobjekt row — shows WHICH object's plans are loaded and opens the
                  PlanPicker (replaces the old NavRail footer swap item, 2026-07-14) */}
              {onObjectSwitch && (
                <button className="ip-menu-act" onClick={() => openSheet(onObjectSwitch)}>
                  <Icon id="pen" /> {objectName ? fillTemplate(cp.objectRow, { name: objectName }) : appConfig.copy.whiteboard.otherObject}
                </button>
              )}
              {onArchive && (
                <button className="ip-menu-act" onClick={() => { setOpen(false); onArchive() }}><Icon id="check" /> {cp.archive}</button>
              )}
              <div className="ip-menu-sep" />
            </>
          )}
          <div className="ip-menu-label">{cp.incidents}</div>
          {incidents.length === 0 && !active && <div className="ip-menu-empty">{cp.noOpenIncidents}</div>}
          {incidents.filter((i) => i.id !== active?.id).map((i) => (
            <div key={i.id} className="ip-menu-row">
              <button className="ip-menu-rowmain" onClick={() => { onSwitch(i); setOpen(false) }}>
                <span className="ip-menu-title">
                  {i.title}
                  {i.is_exercise && <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>}
                </span>
                <span className="ip-menu-sub">{shortAddress(i.address) ?? i.status}</span>
              </button>
            </div>
          ))}
          {isEditor && <button className="ip-menu-act" onClick={() => { onDivera(); setOpen(false) }}><Icon id="plus" /> {appConfig.copy.intake.titleNew}</button>}
          <button className="ip-menu-act" onClick={() => openSheet(onHistory)}><Icon id="history" /> {cp.allIncidents}</button>
          <div className="ip-menu-sep" />
          <button className="ip-menu-act" onClick={() => openSheet(onSettings)}><Icon id="gear" /> {appConfig.copy.settings.title}</button>
          {active && <button className="ip-menu-act" onClick={() => openSheet(onOfflineReadiness)}><Icon id="snapshot" /> {appConfig.copy.offline.title}</button>}
          <button className="ip-menu-act" onClick={() => openSheet(onHelp)}><Icon id="info" /> {appConfig.copy.help.menu}</button>
          {onInstall && <button className="ip-menu-act" onClick={() => openSheet(onInstall)}><Icon id="share-ios" /> {appConfig.copy.install.menu}</button>}
          <div className="ip-menu-sep" />
          <div className="ip-menu-user">
            <span className="ip-menu-av" style={{ background: user.color ?? 'var(--ink-faint)' }}>{initials(user.display_name)}</span>
            <span className="ip-menu-userinfo">
              <span className="ip-menu-username">{user.display_name}</span>
              <span className="ip-menu-userrole">{roleLabel(user.role)}</span>
            </span>
            <button className="ip-menu-logout" onClick={() => { onLogout(); setOpen(false) }}><Icon id="logout" /> {cp.logout}</button>
          </div>
          <div className="ip-menu-foot">
            {/* No manual "check for updates" — a fresh deploy surfaces itself via the automatic
                "Neue Version verfügbar" banner (UpdateBanner / swUpdate). Just the build label here. */}
            <span className="ip-menu-ver" title={cp.appVersion}>{buildLabel()}</span>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Einsatz eröffnen (intake wizard, Phase 4) --------------------------------------
// `ix` (appConfig.copy.intake) is read inside each function below rather than captured at
// module-load, so the locale resolved at boot (config/copy) applies.

/** 0/0 = "no location" (Divera's convention; legacy rows stored it verbatim) — treat it
 *  like a missing coordinate everywhere, so the wizard/banner fall back to the address
 *  geocoder and the deployment's default view instead of pinning Null Island. */
function realCoord(lng?: number | null, lat?: number | null): [number, number] | null {
  return lng != null && lat != null && (lng !== 0 || lat !== 0) ? [lng, lat] : null
}

/** Pre-select a VKF category from a Divera Stichwort (first keyword hit wins). */
function guessKategorie(title: string): string | null {
  const up = (title || '').toUpperCase()
  // kategorieGuess is NOT localized (it mirrors the backend's German keyword map), so the
  // value is the same in any locale — but read through the getter for consistency.
  for (const [kw, label] of appConfig.copy.intake.kategorieGuess) if (up.includes(kw)) return label
  return null
}

/** ISO ⇄ <input type="datetime-local"> string (local time, minute precision). */
function dtLocalValue(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function dtIso(local: string): string | undefined {
  if (!local) return undefined
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

// Single guided panel used for both intake paths: a Divera alarm pre-fills every field
// (EL reviews/corrects), or a blank manual create with three location methods (object
// library · address autocomplete · map-pick). 3am tenet: nothing hidden, nothing to
// memorise, everything correctable before the incident is born.
export function EinsatzWizard({ seed, edit, nearCoord, onClose, onCreated }: {
  /** Divera alarm to review/override; null = manual create */
  seed: DiveraAlarm | null
  /** existing incident to correct in place (PATCH) instead of creating; null = create/take */
  edit?: IncidentMeta | null
  /** current incident coord, used to rank the object library by proximity */
  nearCoord?: [number, number] | null
  onClose: () => void
  onCreated: (inc: IncidentFull) => void
}) {
  const ix = appConfig.copy.intake // read per-render so the resolved locale applies
  const [title, setTitle] = useState(seed?.title ?? edit?.title ?? '')
  const [address, setAddress] = useState(seed?.address ?? edit?.address ?? '')
  // Alarmmeldung (= incident.text). On create/take it comes from the alarm; on edit it's
  // fetched from the incident below (IncidentMeta carries no text). `textReady` guards the
  // PATCH so a save before the fetch lands can't blank an existing Meldungstext.
  const [text, setText] = useState(seed?.text ?? '')
  const [textReady, setTextReady] = useState(!edit)
  // Alarmierungszeit (= incident.started_at): correctable in edit mode, and settable on
  // MANUAL create so a fully analog incident (no Divera) can be nachgetragen days later
  // with its real alarm time — that timestamp is what a website/statistics feed reads.
  // Defaults to now, so live creation needs no interaction. Divera take keeps the alarm's
  // own time (field hidden, nothing sent).
  const [alarmiertAt, setAlarmiertAt] = useState(
    dtLocalValue(edit ? edit.started_at : seed ? null : new Date().toISOString()),
  )
  // category defaults to the first VKF type (Brandbekämpfung) so the dropdown is never empty
  const [kategorie, setKategorie] = useState<string | null>(
    seed ? (guessKategorie(seed.title) ?? ix.kategorien[0]) : (edit?.type ?? ix.kategorien[0]),
  )
  // [lng, lat] resolved location (Divera coord / object / address hit / map-pick)
  const [coord, setCoord] = useState<[number, number] | null>(
    realCoord(seed?.lng, seed?.lat) ?? realCoord(edit?.lng, edit?.lat),
  )
  // Übung — stats-excluded + deletable. Manual create & edit only; a Divera take is a real
  // alarm (a taken Probealarm gets retro-tagged via the Einsatzdaten editor).
  const [isExercise, setIsExercise] = useState(!!edit?.is_exercise)
  const [busy, setBusy] = useState(false)

  // address autocomplete
  const [hits, setHits] = useState<GeoHit[]>([])
  const [addrLoading, setAddrLoading] = useState(false)
  const [addrOpen, setAddrOpen] = useState(false)
  const addrSeq = useRef(0)

  // object library picker
  const [objOpen, setObjOpen] = useState(false)
  const [objQuery, setObjQuery] = useState('')
  const [objects, setObjects] = useState<ObjectWithPlans[]>([])

  // map picker (self-contained — works with no active incident yet)
  const [mapOpen, setMapOpen] = useState(false)

  // «Hier» — the PRIMARY location method: the EL usually stands at (or near) the Einsatzort,
  // so one tap takes a GPS fix; object library / map pick are the fallbacks for elsewhere
  const [locating, setLocating] = useState(false)
  const useHere = () => {
    if (locating) return
    if (!navigator.geolocation) { toast(ix.hereFailed, { icon: 'warn', tone: 'warn' }); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (p) => { setLocating(false); applyPicked([p.coords.longitude, p.coords.latitude]) },
      () => { setLocating(false); toast(ix.hereFailed, { icon: 'warn', tone: 'warn' }) },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    )
  }

  // device GPS (watched only while the object picker is open) so "Objekt aus
  // Feuerwehrplänen" ranks by where the responder actually stands, not the incident coord
  const myPos = useGeoPosition(objOpen)

  // a coordinate from the map picker → set it and reverse-geocode the address (so a
  // map-click fills the nearest registered address, not just bare coords)
  const applyPicked = (c: [number, number]) => {
    setCoord(c); setMapOpen(false); setAddrOpen(false)
    geocodeReverse(c[1], c[0]).then((hit) => { if (hit?.label) setAddress(hit.label) }).catch(() => {})
  }

  // debounced swisstopo autocomplete on the address field (skip while a hit is locked in)
  useEffect(() => {
    const q = address.trim()
    if (!addrOpen || q.length < 3) { setHits([]); setAddrLoading(false); return }
    const seq = ++addrSeq.current
    setAddrLoading(true)
    const t = setTimeout(() => {
      geocodeSearch(q).then((r) => { if (addrSeq.current === seq) { setHits(r); setAddrLoading(false) } })
        .catch(() => { if (addrSeq.current === seq) { setHits([]); setAddrLoading(false) } })
    }, 300)
    return () => clearTimeout(t)
  }, [address, addrOpen])

  // load / filter the object library when its picker is open. Rank by the responder's own
  // GPS first (where they stand), falling back to the being-set / incident coord if denied.
  useEffect(() => {
    if (!objOpen) return
    const ref = myPos ?? coord ?? nearCoord
    const near = ref ? `${ref[0]},${ref[1]}` : undefined
    const t = setTimeout(() => {
      listObjects(objQuery.trim() || undefined, near).then(setObjects).catch(() => setObjects([]))
    }, 250)
    return () => clearTimeout(t)
  }, [objOpen, objQuery, myPos, coord, nearCoord])

  // Edit mode: pull the incident's Meldungstext (Alarmmeldung) — it isn't in IncidentMeta.
  useEffect(() => {
    if (!edit) return
    let alive = true
    getIncident(edit.id)
      .then((full) => { if (alive) { setText((t) => (t.trim() ? t : full.text ?? '')); setTextReady(true) } })
      .catch(() => { if (alive) setTextReady(true) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.id])

  const pickHit = (h: GeoHit) => {
    setAddress(h.label); setCoord([h.lng, h.lat]); setAddrOpen(false); setHits([])
  }
  const pickObject = (o: ObjectWithPlans) => {
    if (!title.trim()) setTitle(o.name)
    if (o.address) setAddress(o.address)
    if (o.lng != null && o.lat != null) setCoord([o.lng, o.lat])
    setObjOpen(false); setAddrOpen(false)
  }

  // «Eröffnen» must never be a dead-end: after the primary «Hier»/GPS path the title is often
  // blank, which used to leave the button disabled with no hint. Fall back to the address
  // short-form, then the category label (always set) — there's always a sensible incident name.
  const effectiveTitle =
    title.trim() ||
    (address.trim() ? shortAddress(address.trim()) ?? '' : '') ||
    (ix.kategorienLabels[kategorie ?? ix.kategorien[0]] ?? kategorie ?? ix.kategorien[0])
  // Demo: a visitor may explore the whole wizard, but actually opening a new Einsatz is blocked
  // (it would write to the shared backend). Edit / Divera-take stay allowed; only manual create.
  const demoBlocked = isDemoMode() && !edit && !seed
  const submit = async () => {
    if (!effectiveTitle || busy || demoBlocked) return
    setBusy(true)
    // Meldungstext/Alarmmeldung is sent on create/take, and on edit once the existing text
    // has been fetched (textReady) so a quick save can't blank it. Alarmierungszeit
    // (started_at) goes with edit and manual create (nachtragen); a Divera take keeps the
    // alarm's own time.
    const body = {
      title: effectiveTitle,
      type: kategorie,
      address: address.trim() || null,
      ...(textReady ? { text: text.trim() || null } : {}),
      ...(!seed && dtIso(alarmiertAt) ? { started_at: dtIso(alarmiertAt) } : {}),
      ...(!seed ? { is_exercise: isExercise } : {}),
      ...(coord ? { lng: coord[0], lat: coord[1] } : {}),
    }
    try {
      const inc = edit
        ? await patchIncident(edit.id, body)
        : seed
        ? await takeDiveraAlarm(seed.divera_id, body)
        : await createIncident(body)
      toast(edit ? ix.updated : seed ? ix.taken : ix.created, { icon: 'check', tone: 'success' })
      onCreated(inc)
    } catch (e) {
      const fallback = edit ? ix.errorUpdate : seed ? ix.errorTake : ix.errorCreate
      toast(e instanceof ApiError ? e.detail : fallback, { icon: 'warn', tone: 'warn' })
      setBusy(false)
    }
  }

  // near objects float to the top of the picker when we have a coordinate
  const near = objects.filter((o) => o.distance_m != null && o.distance_m <= 1000)
                       .sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0))
  const nearIds = new Set(near.map((o) => o.id))
  const rest = objects.filter((o) => !nearIds.has(o.id)).sort((a, b) => a.name.localeCompare(b.name))
  const ObjRow = (o: ObjectWithPlans) => (
    <button key={o.id} type="button" className="ip-objrow" onClick={() => pickObject(o)}>
      <span className="ip-objrow-main">
        <span className="ip-objrow-name">{o.name}{o.distance_m != null ? <span className="ip-objrow-dist"> · {Math.round(o.distance_m)} m</span> : null}</span>
        <span className="ip-objrow-sub">{o.address ?? '—'} · {o.plans.length ? ix.objectPlans(o.plans.length) : ix.objectNoPlans}</span>
      </span>
    </button>
  )

  return (
    <>
    {mapOpen && <MapPicker initial={coord} onCancel={() => setMapOpen(false)} onConfirm={applyPicked} />}
    <Modal title={edit ? ix.editTitle : seed ? ix.titleDivera : ix.titleNew} onClose={onClose}>
      {seed && <div className="ip-divera-hint"><Icon id="truck" /> {ix.diveraHint}</div>}

      {/* --- Standort --- */}
      <div className="ip-ix-head">{ix.locationHead}</div>
      <div className="ip-field ip-ac">
        <span>{ix.addressLabel}</span>
        <input
          value={address}
          placeholder={ix.addressPlaceholder}
          onChange={(e) => { setAddress(e.target.value); setAddrOpen(true) }}
          onFocus={() => setAddrOpen(true)}
        />
        {addrOpen && (addrLoading || hits.length > 0 || address.trim().length >= 3) && (
          <div className="ip-ac-menu">
            {addrLoading && <div className="ip-ac-note">{ix.addressSearching}</div>}
            {!addrLoading && hits.length === 0 && <div className="ip-ac-note">{ix.addressNoHits}</div>}
            {hits.map((h, i) => (
              <button key={i} type="button" className="ip-ac-row" onClick={() => pickHit(h)}>
                <Icon id="flag" /> <span>{h.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ip-ix-methods">
        <button type="button" className="ip-btn primary" disabled={locating} onClick={useHere}>
          <Icon id={locating ? 'rotate' : 'locate'} className={locating ? 'spin' : undefined} /> {ix.hereButton}
        </button>
        <button type="button" className={`ip-btn${objOpen ? ' on' : ''}`} onClick={() => setObjOpen((v) => !v)}>
          <Icon id="doc" /> {ix.objectButton}
        </button>
        <button type="button" className="ip-btn" onClick={() => setMapOpen(true)}>
          <Icon id="map" /> {ix.mapPickButton}
        </button>
      </div>

      {objOpen && (
        <div className="ip-objpick">
          <input className="ip-search" value={objQuery} placeholder={ix.objectSearchPlaceholder} onChange={(e) => setObjQuery(e.target.value)} />
          <div className="ip-objlist">
            {objects.length === 0 && <div className="ip-ac-note">{ix.objectNoHits}</div>}
            {near.length > 0 && <div className="ip-objgroup">{ix.objectNear}</div>}
            {near.map(ObjRow)}
            {rest.map(ObjRow)}
          </div>
        </div>
      )}

      <div className={`ip-loc${coord ? ' set' : ''}`}>
        <Icon id={coord ? 'flag' : 'warn'} />
        {coord ? (
          <>
            <span className="ip-loc-txt">{ix.coordSet} · {coord[1].toFixed(5)}, {coord[0].toFixed(5)}</span>
            <button type="button" className="ip-loc-clear" onClick={() => setCoord(null)} aria-label={ix.coordClear}><Icon id="close" /></button>
          </>
        ) : (
          <span className="ip-loc-txt">{ix.coordNone}</span>
        )}
      </div>

      {/* --- Stichwort & Kategorie --- */}
      <div className="ip-ix-head">{ix.keywordHead}</div>
      <label className="ip-field"><span>{ix.titleLabel} *</span>
        {/* no autofocus — the EL usually sets the location (address / object / map) first, so
            opening with the keyboard up over the Stichwort field would be in the way */}
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={ix.titlePlaceholder} />
      </label>
      <div className="ip-field"><span>{ix.categoryLabel}</span>
        {/* themed Combo instead of the OS select; options are display labels, the stored
            value stays the (German) kategorie key — mapped back on change */}
        <Combo
          value={ix.kategorienLabels[kategorie ?? ix.kategorien[0]] ?? kategorie ?? ix.kategorien[0]}
          options={ix.kategorien.map((k) => ix.kategorienLabels[k] ?? k)}
          placeholder={ix.categoryLabel}
          clearable={false}
          onChange={(label) => {
            const key = ix.kategorien.find((k) => (ix.kategorienLabels[k] ?? k) === label) ?? label
            setKategorie(key)
          }}
        />
      </div>
      {!seed && (
        <label className="ip-check">
          <input type="checkbox" checked={isExercise} onChange={(e) => setIsExercise(e.target.checked)} />
          <span>{ix.exerciseToggle}</span>
        </label>
      )}
      {/* create/take: free-text Meldungstext stays under the keyword section */}
      {!edit && (
        <label className="ip-field"><span>{ix.detailsLabel}</span>
          <textarea className="ip-textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={ix.detailsPlaceholder} />
        </label>
      )}
      {/* manual create: Alarmierungszeit, prefilled with now — leave it for a live incident,
          set it back to nachtragen an analog one (paper report keeps the bookkeeping; this
          row is what puts the right date into the catalogue). Divera take: alarm's time. */}
      {!edit && !seed && (
        <label className="ip-field"><span>{ix.alarmTime}</span>
          <DateTimeField ariaLabel={ix.alarmTime} value={dtIso(alarmiertAt)}
            onCommit={(iso) => setAlarmiertAt(dtLocalValue(iso))} />
        </label>
      )}

      {/* --- Alarmierung (edit only) — the dispatch facts, everything before we arrived:
          when we were alarmed + the alarm message. The Rapportangaben hold the rest. --- */}
      {edit && (
        <>
          <div className="ip-ix-head">{ix.alarmierungHead}</div>
          <label className="ip-field"><span>{ix.alarmTime}</span>
            <DateTimeField ariaLabel={ix.alarmTime} value={dtIso(alarmiertAt)}
              onCommit={(iso) => setAlarmiertAt(dtLocalValue(iso))} />
          </label>
          <label className="ip-field"><span>{ix.alarmMessage}</span>
            <textarea className="ip-textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={ix.detailsPlaceholder} />
          </label>
        </>
      )}

      {demoBlocked && <p className="ip-demo-block"><Icon id="info" /> {ix.demoBlocked}</p>}
      <div className="ip-actions">
        {/* manual create is reached from the intake pool — "Zurück" signals it returns there */}
        <button className="ip-btn" onClick={onClose}>{!seed && !edit ? ix.back : ix.cancel}</button>
        <button className="ip-btn primary" disabled={!effectiveTitle || busy || demoBlocked} onClick={submit}>
          {busy ? <><Icon id="rotate" className="spin" /> {edit ? ix.saving : ix.opening}</> : edit ? ix.save : ix.open}
        </button>
      </div>
    </Modal>
    </>
  )
}

// --- Incoming-alarm banner (one-tap take) -------------------------------------------
// Floats over the live map whenever an untaken Divera alarm is in the pool. The whole
// point of the redesign: the dispatch finds the EL. The primary button takes the alarm
// AS-IS (everything Divera carries + backend type/priority/geocode) and drops straight
// onto the map — corrections happen there via the ReviewBanner, not in a gating wizard.
// dismissed alarms are remembered PER DEVICE (localStorage), so a given alarm only ever
// nags once on this device — across reloads, and whether it's X'd or taken.
const ALARM_MAX_AGE_MS = 3 * 60 * 60 * 1000 // only surface dispatches < 3h old

export function IncomingAlarmBanner({ alarms, taking, onTake, onAttach }: {
  alarms: DiveraAlarm[]
  /** divera_id currently being taken (disables its button) */
  taking: number | null
  onTake: (a: DiveraAlarm) => void
  /** attach this alarm to the active incident (split dispatch; the caller confirms) */
  onAttach: (a: DiveraAlarm) => void
}) {
  const ix = appConfig.copy.intake
  const [dismissed, setDismissed] = useState<Set<number>>(loadDismissedAlarms)
  const dismiss = (id: number) => setDismissed(dismissAlarm(id))
  const now = Date.now()
  const live = alarms.filter((a) => {
    if (dismissed.has(a.divera_id)) return false
    // age < 3h; no lower bound so minor server/device clock skew can't hide a fresh alarm
    const age = now - new Date(a.received_at).getTime()
    return Number.isFinite(age) && age < ALARM_MAX_AGE_MS
  })
  if (live.length === 0) return null
  // pool is newest-first; the banner shows ONE alarm — dismissing it (per device)
  // surfaces the next, and the landing launch list always carries the whole pool
  const top = live[0]
  const busy = taking === top.divera_id
  return (
    <div className="dv-banner" role="alert">
      <div className="dv-banner-pulse"><Icon id="bell" /></div>
      <div className="dv-banner-main">
        <div className="dv-banner-kicker">{ix.newDiveraAlarm}</div>
        <div className="dv-banner-title">{top.title}</div>
        <div className="dv-banner-sub">{shortAddress(top.address) ?? ix.addressUnknown} · {fmtWhen(top.received_at)}</div>
      </div>
      <div className="dv-banner-act">
        <button className="ip-btn primary" disabled={busy} onClick={() => onTake(top)}>
          <Icon id={busy ? 'rotate' : 'truck'} className={busy ? 'spin' : undefined} /> {busy ? ix.alarmOpening : ix.alarmOpen}
        </button>
        {/* split dispatch: this alarm may be the Einsatz that's already open — join it */}
        <button className="ip-btn ghost" disabled={busy} onClick={() => onAttach(top)} title={ix.attach}>
          <Icon id="swap" /> {ix.attachShort}
        </button>
        <button className="dv-banner-x" aria-label={ix.hide} onClick={() => dismiss(top.divera_id)}>
          <Icon id="close" />
        </button>
      </div>
    </div>
  )
}

// --- New-incident banner (announce, never switch) ------------------------------------
// With alarm auto-open, an Einsatz can appear with no human in the loop (Divera auto-take,
// generic /api/alarms intake, or a colleague's take on another device). This announces the
// arrival wherever the operator is; switching stays a deliberate tap — a working editor is
// never yanked off their incident. Dismissal is per device (useIncidentWatch).
export function NewIncidentBanner({ inc, active, onSwitch, onDismiss }: {
  inc: IncidentMeta
  /** whether another incident is currently active (labels the button Wechseln vs. Öffnen) */
  active: boolean
  onSwitch: () => void
  onDismiss: () => void
}) {
  const c = appConfig.copy.incidentAlert
  return (
    <div className="dv-banner" role="alert">
      <div className="dv-banner-pulse"><Icon id="bell" /></div>
      <div className="dv-banner-main">
        <div className="dv-banner-kicker">{c.kicker}</div>
        <div className="dv-banner-title">{inc.title}</div>
        <div className="dv-banner-sub">{shortAddress(inc.address) ?? appConfig.copy.intake.addressUnknown} · {fmtWhen(inc.started_at)}</div>
      </div>
      <div className="dv-banner-act">
        <button className="ip-btn primary" onClick={onSwitch}>
          <Icon id="truck" /> {active ? c.switch : c.open}
        </button>
        <button className="dv-banner-x" aria-label={c.later} onClick={onDismiss}>
          <Icon id="close" />
        </button>
      </div>
    </div>
  )
}

// --- In-map review banner (correct-in-place) ----------------------------------------
// Shown on a freshly one-tap-taken Divera incident so the EL is operational immediately
// and refines without a blocking step: the dispatch reads top-down like the pager message
// (Stichwort, Adresse, Meldung — verify at a glance, tap «Passt», done); the Einsatzart is
// a compact Combo, and the edit panel stays one tap away for address/location fixes.
// Warns loudly when no coordinate could be resolved.
export function ReviewBanner({ meta, categories, onPatchType, onEdit, onDone }: {
  /** meta comes from getIncident/takeDiveraAlarm (IncidentFull), so the Meldung is present */
  meta: IncidentMeta & { text?: string | null }
  categories: string[]
  onPatchType: (type: string) => void
  onEdit: () => void
  onDone: () => void
}) {
  const ix = appConfig.copy.intake
  const hasLoc = realCoord(meta.lng, meta.lat) != null
  return (
    <div className={`rv-banner${hasLoc ? '' : ' rv-warn'}`} role="status">
      <div className="rv-head">
        <Icon id={hasLoc ? 'flag' : 'warn'} />
        <span className="rv-kicker">{ix.fromDivera}</span>
      </div>
      <div className="rv-title">{meta.title}</div>
      <div className="rv-addr">{hasLoc ? (meta.address ?? ix.locationSet) : ix.noLocationOnMap}</div>
      {!!meta.text?.trim() && <div className="rv-msg">{meta.text}</div>}
      <div className="rv-body">
        {/* same themed Combo as the wizard: options are display labels, the stored value
            stays the (German) kategorie key — mapped back on change */}
        <div className="rv-type">
          <Combo
            value={meta.type ? (ix.kategorienLabels[meta.type] ?? meta.type) : ''}
            options={categories.map((k) => ix.kategorienLabels[k] ?? k)}
            placeholder={ix.categoryLabel}
            clearable={false}
            onChange={(label) => onPatchType(categories.find((k) => (ix.kategorienLabels[k] ?? k) === label) ?? label)}
          />
        </div>
        <div className="rv-act">
          <button className="ip-btn" onClick={onEdit}><Icon id="pen" /> {appConfig.copy.edit}</button>
          <button className="ip-btn primary" onClick={onDone}><Icon id="check" /> {ix.ok}</button>
        </div>
      </div>
    </div>
  )
}

// --- History (Phase 5) --------------------------------------------------------------
const statusLabel = (i: IncidentMeta): string => {
  const h = appConfig.copy.history
  return i.is_archived ? h.statusArchived : i.status === 'offen' ? h.statusOpen : i.status === 'in_arbeit' ? h.statusInProgress : i.status
}
const statusKey = (i: IncidentMeta): string => (i.is_archived ? 'arch' : i.status === 'in_arbeit' ? 'work' : 'open')

// All incidents in one list with a status badge — active and archived together, so you can
// switch to any of them. Clicking opens it (archived → read-only); a reactivate restores
// edit. Open incidents get the «Abschliessen» action HERE (not in the switcher menu — the
// dropdown carries no destructive actions; the caller confirms + archives).
export function HistoryPanel({ onClose, onOpen, onArchive }: {
  onClose: () => void
  onOpen: (id: string, readOnly: boolean) => void
  /** confirm + archive an open incident (editors only; omit for viewers) */
  onArchive?: (id: string) => Promise<void>
}) {
  const [items, setItems] = useState<IncidentMeta[]>([])
  const reload = () => { void listIncidents().then(setItems).catch(() => setItems([])) }
  useEffect(reload, [])
  // reactivate is as deliberate as archive (its mirror confirm): the dialog also teaches
  // what it means — later edits land as Nachträge, a done Rapport flips to «geändert».
  const reactivate = async (id: string) => {
    const h = appConfig.copy.history
    const ok = await confirmDialog({
      title: h.reactivateConfirmTitle,
      message: h.reactivateConfirmMsg,
      confirmLabel: h.reactivateConfirmBtn,
      cancelLabel: appConfig.copy.cancel,
    })
    if (!ok) return
    await reactivateIncident(id)
    onOpen(id, false)
  }
  const archive = async (id: string) => { await onArchive?.(id); reload() }
  // hard delete — Übungen only (server-enforced). Deliberately NOT undoable, so it gets the
  // danger confirm instead of confirm-with-undo; real Einsätze never show the button.
  const removeExercise = async (i: IncidentMeta) => {
    const h = appConfig.copy.history
    const ok = await confirmDialog({
      title: h.deleteConfirmTitle,
      message: h.deleteConfirmMsg,
      confirmLabel: h.deleteConfirmBtn,
      cancelLabel: appConfig.copy.cancel,
      danger: true,
    })
    if (!ok) return
    try {
      await deleteIncident(i.id)
      toast(h.deleted, { icon: 'check', tone: 'success' })
      reload()
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : h.deleteFailed, { icon: 'warn', tone: 'warn' })
    }
  }
  // active first, then by start time (newest first)
  const sorted = [...items].sort(
    (a, b) => Number(a.is_archived) - Number(b.is_archived) || (a.started_at < b.started_at ? 1 : -1),
  )
  const h = appConfig.copy.history
  // the list grows by one row per Einsatz forever — search + time-group headers keep an
  // old incident findable months later (the reopen/ansehen path). Sorted active-first then
  // newest, so group keys change monotonically and a header renders on every key change.
  const [query, setQuery] = useState('')
  const shown = filterIncidents(sorted, query)
  const now = new Date()
  const groupTitle = (key: string) =>
    key === 'open' ? h.groupOpen : key === 'today' ? h.groupToday : key === 'week' ? h.groupWeek : monthLabel(key, getLocaleId())
  const rows = shown.map((i, idx) => {
    const key = historyGroupKey(i, now)
    const prev = idx > 0 ? historyGroupKey(shown[idx - 1], now) : null
    return { i, header: key !== prev ? groupTitle(key) : null }
  })
  return (
    <Modal title={h.title} onClose={onClose} wide>
      {sorted.length === 0 && <EmptyState icon="history" title={h.empty} sub={h.emptySub} />}
      {sorted.length > 0 && (
        <label className="ip-hist-search">
          <Icon id="search" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={h.searchPlaceholder} aria-label={h.searchPlaceholder} />
        </label>
      )}
      {sorted.length > 0 && shown.length === 0 && <p className="ip-hist-nores">{h.noMatches}</p>}
      {rows.map(({ i, header }) => {
        return (
          <Fragment key={i.id}>
            {header && <div className="ip-hist-group">{header}</div>}
            <div className="ip-hist">
              <button className="ip-hist-main" onClick={() => onOpen(i.id, i.is_archived)}>
                <div className="ip-hist-title">
                  <span className="ip-hist-name">{i.title}</span>
                  {i.is_exercise && <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>}
                  <span className={`ip-badge ip-badge-${statusKey(i)}`}>{statusLabel(i)}</span>
                </div>
                <div className="ip-hist-sub">{shortAddress(i.address) ?? h.noLocation} · {fmtWhen(i.started_at)}</div>
              </button>
              {i.is_archived
                ? <button className="ip-btn" onClick={() => reactivate(i.id)}>{h.reactivate}</button>
                : onArchive && <button className="ip-btn" onClick={() => void archive(i.id)}>{h.archiveConfirmBtn}</button>}
              {/* delete only for ARCHIVED exercises (editor-gated via onArchive) — an open
                  Übung is first abgeschlossen like any incident, then deletable */}
              {i.is_exercise && i.is_archived && onArchive && (
                <button className="ip-btn ip-btn-danger" onClick={() => void removeExercise(i)} aria-label={h.deleteConfirmTitle}>
                  <Icon id="trash" /> {h.deleteExercise}
                </button>
              )}
            </div>
          </Fragment>
        )
      })}
    </Modal>
  )
}

// --- Datenquellen (Phase 7) ---------------------------------------------------------
export function DatenquellenPanel({ isEditor, incidentCoord, onClose }: {
  isEditor: boolean
  incidentCoord: [number, number] | null
  onClose: () => void
}) {
  const ds = appConfig.copy.datenquellen
  const [refs, setRefs] = useState<ReferenceDataset[]>([])
  const [objects, setObjects] = useState<ObjectWithPlans[]>([])
  const reload = async () => {
    try { setRefs(await listReference()) } catch { /* ignore */ }
    try { setObjects(await listObjects(undefined, incidentCoord ? `${incidentCoord[0]},${incidentCoord[1]}` : undefined)) } catch { /* ignore */ }
  }
  useEffect(() => { void reload() }, [])

  const upload = async (id: string, f: File) => {
    try { await uploadReference(id, f, f.name); toast(ds.uploaded, { icon: 'check', tone: 'success' }); void reload() }
    catch (e) { toast(e instanceof ApiError ? e.detail : ds.uploadFailed, { icon: 'warn', tone: 'warn' }) }
  }

  // --- add a new GeoJSON reference layer (file → store + render config) ---
  const [addOpen, setAddOpen] = useState(false)
  const [nf, setNf] = useState<File | null>(null)
  const [nLabel, setNLabel] = useState('')
  const [nGroup, setNGroup] = useState<string>(ds.defaultGroup)
  const [nKind, setNKind] = useState<'line' | 'point'>('line')
  const [nColor, setNColor] = useState('#0f52b5')
  const [busy, setBusy] = useState(false)
  // store slug from the file name: a-z0-9 only, so the dataset id geo:<slug> is URL-clean.
  const slug = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const resetAdd = () => { setNf(null); setNLabel(''); setNGroup(ds.defaultGroup); setNKind('line'); setNColor('#0f52b5'); setAddOpen(false) }

  const addLayer = async () => {
    if (!nf || !nLabel.trim()) return
    const id = slug(nf.name)
    if (!id) { toast(ds.invalidFilename, { icon: 'warn', tone: 'warn' }); return }
    setBusy(true)
    try {
      const check = await inspectGeojson(nf)
      if (!check.ok) { toast(check.msg, { icon: 'warn', tone: 'warn' }); return }
      await uploadReference(`geo:${id}`, nf, nf.name)
      await upsertReferenceLayer({
        id, group: nGroup.trim() || ds.defaultGroup, label: nLabel.trim(), icon: 'map',
        kind: 'geojson', geojson: `/api/reference/geo:${id}`, vectorKind: nKind, color: nColor,
      })
      toast(fillTemplate(ds.layerAdded, { name: nLabel.trim() }), { icon: 'check', tone: 'success' })
      resetAdd(); void reload()
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : ds.addLayerFailed, { icon: 'warn', tone: 'warn' })
    } finally { setBusy(false) }
  }

  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matches = (o: ObjectWithPlans) =>
    !q || o.name.toLowerCase().includes(q) || (o.address ?? '').toLowerCase().includes(q)
  const filtered = objects.filter(matches)
  // With coords: split into "nearby" (≤1 km, by distance) + the rest (alphabetical). The
  // full list (155+) is collapsed by default so the panel isn't an unwieldy wall of rows.
  const near = incidentCoord
    ? filtered.filter((o) => o.distance_m != null && o.distance_m <= 400).sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0))
    : []
  const nearIds = new Set(near.map((o) => o.id))
  const rest = filtered.filter((o) => !nearIds.has(o.id)).sort((a, b) => a.name.localeCompare(b.name))
  const totalPlans = objects.reduce((n, o) => n + o.plans.length, 0)

  const ObjectRow = (o: ObjectWithPlans) => (
    <div key={o.id} className="ip-ds ip-ds-compact">
      <div className="ip-ds-main">
        <div className="ip-ds-title">{o.name}{o.distance_m != null ? <span className="ip-ds-dist"> · {Math.round(o.distance_m)} m</span> : null}</div>
        <div className="ip-ds-sub">{o.address ?? '—'}{o.plans.length ? ` · ${o.plans.map((p) => (p.module ?? '?').replace('modul', 'M')).join(' ')}` : ` · ${appConfig.copy.intake.objectNoPlans}`}</div>
      </div>
    </div>
  )

  return (
    <Modal title={ds.title} onClose={onClose} wide>
      {incidentCoord && externalMapLinks(incidentCoord[0], incidentCoord[1]).length > 0 && (
        <div className="ip-row-actions">
          {externalMapLinks(incidentCoord[0], incidentCoord[1]).map((l) => (
            <a key={l.href} className="ip-btn" href={l.href} target="_blank" rel="noreferrer">
              <Icon id="map" /> {l.label}
            </a>
          ))}
        </div>
      )}

      <details className="ip-group" open>
        <summary className="ip-group-head">{ds.globalDatasets} <span className="ip-group-count">{refs.length}</span></summary>
        {refs.map((d) => (
          <div key={d.id} className="ip-ds">
            <div className="ip-ds-main">
              <div className="ip-ds-title">{d.title ?? d.id}</div>
              <div className="ip-ds-sub">
                {d.kind}{d.feature_count != null ? ` · ${d.feature_count} ${ds.objectsCount}` : ''}
                {d.size_bytes != null ? ` · ${Math.round(d.size_bytes / 1024)} kB` : ''} · v{d.current_version} · {fmtWhen(d.updated_at)}
              </div>
              {d.source_note && <div className="ip-ds-note">{d.source_note}</div>}
            </div>
            {isEditor && (
              <label className="ip-btn ghost">
                {ds.replace}
                <input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(d.id, f) }} />
              </label>
            )}
          </div>
        ))}
        {isEditor && !addOpen && (
          <button type="button" className="ip-btn ghost" style={{ marginTop: 6 }} onClick={() => setAddOpen(true)}>
            <Icon id="area" /> {ds.newGeoLayer}
          </button>
        )}
        {isEditor && addOpen && (
          <div className="ip-addlayer">
            <label className="ip-btn ghost">
              {nf ? nf.name : ds.chooseGeojson}
              <input type="file" accept=".geojson,.json,application/geo+json,application/json" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) { setNf(f); if (!nLabel) setNLabel(f.name.replace(/\.[^.]+$/, '')) } }} />
            </label>
            <input className="ip-search" placeholder={ds.labelPlaceholder} value={nLabel} onChange={(e) => setNLabel(e.target.value)} />
            <input className="ip-search" placeholder={ds.groupPlaceholder} value={nGroup} onChange={(e) => setNGroup(e.target.value)} />
            <div className="ip-addlayer-row">
              <div className="set-seg" role="group" aria-label={ds.kindLines}>
                {([['line', ds.kindLines], ['point', ds.kindPoints]] as const).map(([k, label]) => (
                  <button key={k} type="button" className={`set-seg-btn${nKind === k ? ' on' : ''}`}
                    aria-pressed={nKind === k} onClick={() => setNKind(k)}>{label}</button>
                ))}
              </div>
              <input type="color" value={nColor} onChange={(e) => setNColor(e.target.value)} aria-label={ds.color} />
              <button type="button" className="ip-btn" disabled={!nf || !nLabel.trim() || busy} onClick={() => void addLayer()}>
                {busy ? ds.adding : ds.add}
              </button>
              <button type="button" className="ip-btn ghost" disabled={busy} onClick={resetAdd}>{appConfig.copy.cancel}</button>
            </div>
            <div className="ip-ds-note">{ds.geojsonNoteBefore}<code>geo:…</code>{ds.geojsonNoteAfter}</div>
          </div>
        )}
      </details>

      <div className="ip-group-head ip-objects-head">
        {ds.incidentObjects} <span className="ip-group-count">{objects.length} · {totalPlans} {ds.plansWord}</span>
      </div>
      <input
        className="ip-search"
        placeholder={appConfig.copy.intake.objectSearchPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {near.length > 0 && (
        <>
          <h4 className="ip-sub2">{fillTemplate(ds.nearby, { n: near.length })}</h4>
          {near.map(ObjectRow)}
        </>
      )}
      {/* the full list is heavy (155+) — collapsed unless searching or there are no nearby hits */}
      <details className="ip-group" open={!!q || near.length === 0}>
        <summary className="ip-group-head">
          {near.length > 0 ? ds.allOther : ds.allObjects} <span className="ip-group-count">{rest.length}</span>
        </summary>
        {rest.length === 0 && <div className="ip-ds-note" style={{ padding: '6px 2px' }}>{appConfig.copy.noSymbolMatches}</div>}
        {rest.map(ObjectRow)}
      </details>
    </Modal>
  )
}
