import { useState } from 'react'
import { Icon } from '../../lib/icons'
import { toast } from '../../lib/ui'
import { loadPrefs, savePrefs, applyTheme, resolveTheme, SYMBOL_SCALE, type ThemeMode, type RailLabels, type SymbolSurface } from '../../lib/prefs'
import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import type { IncidentSettings } from '../../lib/workspace'
import type { CaptionMode } from '../../types'
import { atemschutzDoctrine, getDeploymentConfig } from '../../lib/deploymentConfig'
import { listPersonnel } from '../../lib/incidents'
import { Modal } from './_shared'
import { Segmented } from '../Segmented'
import { Stepper } from '../Stepper'

/** Percent for a symbol multiplier — «110 %» is a size anyone reads at a glance, «1.1» is not.
 *  No-break space before the sign, so the number and its unit never split across a line. */
const scalePct = (v: number) => `${Math.round(v * 100)}\u00a0%`

/** One Symbolgrösse row: a labelled slider over that surface's band plus its live value.
 *  Continuous under the thumb (0.05 steps) and live — the map and the plan re-render from the
 *  same prop, so the symbols behind the sheet resize while you drag. */
function ScaleRow({ surface, label, sub, value, onChange }: {
  surface: SymbolSurface
  label: string
  sub: string
  value: number
  onChange: (surface: SymbolSurface, v: number) => void
}) {
  const r = SYMBOL_SCALE[surface]
  return (
    <div className="set-row">
      <span className="set-row-l">{label}<small>{sub}</small></span>
      <span className="set-range">
        <input
          type="range" min={r.min} max={r.max} step={r.step} value={value}
          aria-label={label} aria-valuetext={scalePct(value)}
          onChange={(e) => onChange(surface, Number(e.target.value))}
        />
        <b className="set-range-val">{scalePct(value)}</b>
      </span>
    </div>
  )
}

/** Einstellungen: device prefs (theme, symbol size — local cookie) in one section, and
 *  synced per-incident settings (Atemschutz interval — stored in the workspace blob, so
 *  every device sees the same value) in another. The split is intentional: device prefs may
 *  differ per device without harm; the synced safety threshold must not (see IncidentSettings).
 *  Also opens from the landing card with no incident: omit settings/onSettings and the
 *  synced section disappears (device prefs need no workspace). */
export function SettingsSheet({
  onClose, symbolScale, onSymbolScale, symbolCaptions, onSymbolCaptions, railLabels, onRailLabels, offlineRadiusM, onOfflineRadius, keepScreenOn, onKeepScreenOn, themeCoord, settings, onSettings, canEdit, elView, onElView, onFeedback,
  shareAs, onSharePosition,
}: {
  onClose: () => void
  /** tactical-symbol size per surface, as multipliers (lib/prefs · SYMBOL_SCALE) */
  symbolScale: Record<SymbolSurface, number>
  onSymbolScale: (surface: SymbolSurface, v: number) => void
  /** on-canvas symbol captions (Aus/Auto/Alle) — device pref like the symbol sizes */
  symbolCaptions: CaptionMode
  onSymbolCaptions: (m: CaptionMode) => void
  /** words under the rail glyphs — device pref, off by default (lib/prefs · railLabels). Both
   *  rails at once: they are one decision («soll da Text stehen»), not two. */
  railLabels: RailLabels
  onRailLabels: (v: RailLabels) => void
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
  /** Führungsansicht device toggle — undefined hides the row (viewers: their whole
   *  session is read-only anyway, the toggle would be meaningless). Stays operable in EL
   *  view itself (it must — it's the way back out). */
  elView: boolean
  onElView?: (v: boolean) => void
  /** open the Rückmeldung composer (the caller closes this sheet first — two stacked modals is
   *  not a thing we do). Omitted → the row is hidden. */
  onFeedback?: () => void
  /** Standort teilen: the name this device currently reports as, or null when it is not
   *  sharing. Omitting `onSharePosition` hides the row (no open incident to report into). */
  shareAs?: string | null
  /** true → open the name picker; false → stop sharing and delete the reported position */
  onSharePosition?: (on: boolean) => void
}) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadPrefs().theme ?? 'auto')
  const setTheme = (m: ThemeMode) => {
    setThemeMode(m)
    savePrefs({ ...loadPrefs(), theme: m })
    applyTheme(resolveTheme(m, themeCoord, new Date()))
  }
  const sp = appConfig.copy.sharePosition
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
      const { downloadSheetPdf } = await import('../../admin/capturePdf')
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
              <Segmented<ThemeMode> ariaLabel={cp.colorScheme} value={themeMode} onChange={setTheme}
                options={themeOpts.map(({ m, label }) => ({ value: m, label }))} />
            </div>
            {/* Two sliders, not one S/M/L segment: an unlinked Modul sheet and the Lage never
                wanted the same size. Once the sheet is georeferenced it follows Karte instead;
                the subtitles make that automatic hand-off visible before somebody drags. */}
            <ScaleRow surface="map" label={cp.symbolSizeMap} sub={cp.symbolSizeMapSub}
              value={symbolScale.map} onChange={onSymbolScale} />
            <ScaleRow surface="board" label={cp.symbolSizeBoard} sub={cp.symbolSizeBoardSub}
              value={symbolScale.board} onChange={onSymbolScale} />
            <div className="set-row">
              <span className="set-row-l">{cp.symbolCaptions}<small>{cp.symbolCaptionsSub}</small></span>
              <Segmented<CaptionMode> ariaLabel={cp.symbolCaptions} value={symbolCaptions} onChange={onSymbolCaptions}
                options={captionOpts.map(({ m, label }) => ({ value: m, label }))} />
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.railLabels}<small>{cp.railLabelsSub}</small></span>
              <Segmented<RailLabels> ariaLabel={cp.railLabels} value={railLabels} onChange={onRailLabels}
                options={[{ value: 'off', label: cp.railLabelsOff }, { value: 'short', label: cp.railLabelsOn }]} />
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.offlineRadius}<small>{cp.offlineRadiusSub}</small></span>
              <Stepper value={offlineRadiusM} min={500} max={3000} step={250} format={(v) => (v < 1000 ? `${v} m` : `${v / 1000} km`)} onChange={onOfflineRadius} ariaLabel={cp.offlineRadius} />
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.keepScreenOn}<small>{cp.keepScreenOnSub}</small></span>
              <Segmented<boolean> ariaLabel={cp.keepScreenOn} value={keepScreenOn} onChange={onKeepScreenOn}
                options={[{ value: true, label: cp.keepScreenOnOn }, { value: false, label: cp.keepScreenOnOff }]} />
            </div>
            {onElView && (
              <div className="set-row">
                <span className="set-row-l">{cp.elView}<small>{cp.elViewSub}</small></span>
                <Segmented<boolean> ariaLabel={cp.elView} value={elView} onChange={onElView}
                  options={[{ value: true, label: cp.elViewOn }, { value: false, label: cp.elViewOff }]} />
              </div>
            )}
            {/* Standort verwenden — the standing PERMISSION only, never the act of sharing:
                that is switched on per Einsatz from the compass menu on the map. A device
                preference, so it belongs in this group and NOT in the synced incident settings,
                where a second editor could grant it on somebody else's behalf. */}
            {onSharePosition && (
              <div className="set-row">
                <span className="set-row-l">
                  {sp.settingsLabel}
                  <small>{shareAs ? fillTemplate(sp.settingsAs, { name: shareAs }) : sp.settingsHint}</small>
                </span>
                <Segmented<boolean> ariaLabel={sp.settingsLabel} value={!!shareAs} onChange={onSharePosition}
                  options={[{ value: true, label: sp.settingsOn }, { value: false, label: sp.settingsOff }]} />
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
              <Stepper value={intervalMin} min={1} max={60} format={(v) => `${v} min`} onChange={setIntervalMin} readOnly={!canEdit} ariaLabel={cp.contactIntervalAria} />
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.grace}<small>{cp.graceSub}</small></span>
              <Stepper value={graceSec} min={0} max={300} step={15} format={(v) => `${v} s`} onChange={setGraceSec} readOnly={!canEdit} ariaLabel={cp.grace} />
            </div>
            <div className="set-row">
              <span className="set-row-l">{cp.funkkanal}<small>{cp.funkkanalSub}</small></span>
              <Stepper value={funkkanal} min={az.funkkanalMin} max={az.funkkanalMax} format={(v) => `K ${v}`} onChange={setFunkkanal} readOnly={!canEdit} ariaLabel={cp.funkkanal} />
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
            {onFeedback && (
              <div className="set-row">
                <span className="set-row-l">{cp.feedbackRow}<small>{cp.feedbackRowSub}</small></span>
                <button type="button" className="set-dl" onClick={onFeedback}>
                  <Icon id="mail" /> {cp.feedbackOpen}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}
