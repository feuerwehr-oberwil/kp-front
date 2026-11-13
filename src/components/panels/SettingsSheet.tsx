import { useCallback, useState, useEffect, type ReactNode } from 'react'
import { Icon } from '../../lib/icons'
import { toast, undoToast } from '../../lib/ui'
import { loadPrefs, savePrefs, applyTheme, resolveTheme, SYMBOL_SCALE, type ThemeMode, type RailLabels, type SymbolSurface } from '../../lib/prefs'
import { appConfig } from '../../config/appConfig'
import type { CaptionMode } from '../../types'
import { getDeploymentConfig } from '../../lib/deploymentConfig'
import { loadRoster } from '../../lib/usePersonnel'
import { Modal } from './_shared'
import { OnOff, Segmented } from '../Segmented'
import { Slider } from '../Slider'
import { Button } from '../Button'
import { ShellLoader } from '../ShellLoader'
import { compareText } from '../../lib/format'
import { AlarmReadinessRows } from '../karte/AlarmReadiness'
import { useAlarmReadiness } from '../karte/useAlarmReadiness'
import { readinessSummary } from '../../lib/alarmReadiness'
import { ListCard, ListRow } from '../ListRow'
import { OfflineStateContext, type DevicePartState } from './deviceState'
import { onDevicePrefsReset, resetDevicePrefs, useDevicePrefs } from '../../lib/useDevicePrefs'

/** Percent for a symbol multiplier — «110 %» is a size anyone reads at a glance, «1.1» is not.
 *  No-break space before the sign, so the number and its unit never split across a line. */
const scalePct = (v: number) => `${Math.round(v * 100)}\u00a0%`

/** One Symbolgrösse row: a labelled slider over that surface's band plus its live value.
 *  Continuous under the thumb (0.05 steps) and live — the map and the plan re-render from the
 *  same prop, so the symbols behind the sheet resize while you drag. The app's own `Slider`, not
 *  a native range (sweep 28.10.2026 #18: the range «didn't function like a normal slider» under the
 *  sheet's scroll lock, and gave a finger a 4px-tall target). */
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
        <Slider value={value} min={r.min} max={r.max} step={r.step} ariaLabel={label} valueText={scalePct(value)}
          onChange={(v) => onChange(surface, v)} />
        <b className="set-range-val">{scalePct(value)}</b>
      </span>
    </div>
  )
}

/** «Einstellungen» (13.11.2026, M9 – owner pick A; named «Dieses Gerät» until round 2b): ONE sheet
 *  for this device, one scroll, on home and inside an Einsatz. It was three: Einstellungen, the
 *  Einsatz's «Offline-Bereitschaft» and home's «Auf diesem Gerät». Top to bottom –
 *   · «Bedienung»: the device prefs (theme, symbol size, captions, rail words, screen wake,
 *     Standort – local cookie) – the settings come first (owner, 13.11.2026: «the settings should
 *     be the settings and not just some info»);
 *   · «Gerät auf Standard zurücksetzen»;
 *   · «Dieses Gerät» FOLDED (`DeviceSection`): one summary row «Alarm ✓ · Offline ✓ · App
 *     installiert» over the Alarm line (AlarmReadinessRows) and the caller's `readiness` block –
 *     the Einsatz's OfflineReadiness or home's KarteDeviceRows. It opens by itself for an opener
 *     that points at it (`focus="offline"`: home's Offline chip, «Keine Basiskarte», the close's
 *     media step – scrolled to) and while a part needs the operator (alarm not set up, nothing
 *     offline yet);
 *   · the per-device utilities (Vorlagen, Rückmeldung).
 *  Three rows left on 13.11.2026 (owner picks PLACE.7): «Tastenkürzel anzeigen» and
 *  «Offline-Vorbereitung» are fixed on, the «Offline-Umkreis» is the station's (/admin › Station &
 *  Karte, `map.offlineRadiusM`). The «Einsatz» doctrine values (Funkkontakt-Intervall, Nachfrist,
 *  Funkkanal) left this sheet 28.08.: station configuration belongs in /admin, where whoever set it
 *  up changes it — not under the finger of an unknowing operator at 3am (per-incident overrides
 *  already written keep working; the doctrine is the source). */
export function SettingsSheet({
  onClose, symbolScale, onSymbolScale, symbolCaptions, onSymbolCaptions, railLabels, onRailLabels, keepScreenOn, onKeepScreenOn, photoPosition, onPhotoPosition, themeCoord, onFeedback,
  shareAs, onSharePosition, onChangeShareName, readiness, focus,
}: {
  onClose: () => void
  /** what this device holds offline, under the Alarm line in «Bereit?» — the caller's, because
   *  only it knows the facts (an Einsatz: OfflineReadiness; home: KarteDeviceRows). Omitted
   *  where there is nothing to probe (the launcher). */
  readiness?: ReactNode
  /** open scrolled to that part instead of the top */
  focus?: 'offline'
  /** tactical-symbol size per surface, as multipliers (lib/prefs · SYMBOL_SCALE) */
  symbolScale: Record<SymbolSurface, number>
  onSymbolScale: (surface: SymbolSurface, v: number) => void
  /** on-canvas symbol captions (Aus/Auto/Alle) — device pref like the symbol sizes */
  symbolCaptions: CaptionMode
  onSymbolCaptions: (m: CaptionMode) => void
  /** words under the rail glyphs — device pref, ON by default on every device (lib/prefs ·
   *  railLabelsFor, 13.11.2026). Both rails at once: they are one decision («soll da Text
   *  stehen»), not two. */
  railLabels: RailLabels
  onRailLabels: (v: RailLabels) => void
  /** keep the screen awake while an incident is open — device pref, default on */
  keepScreenOn: boolean
  onKeepScreenOn: (v: boolean) => void
  /** «Standort zu Fotos» (lib/devicePosition) — a device preference. Omitted where this session
   *  writes no record (viewer, link) → the row is hidden. */
  photoPosition?: boolean
  onPhotoPosition?: (v: boolean) => void
  themeCoord: [number, number] | null
  /** open the Rückmeldung composer (the caller closes this sheet first — two stacked modals is
   *  not a thing we do). Omitted → the row is hidden. */
  onFeedback?: () => void
  /** Standort teilen: the name this device currently reports as, or null when it is not
   *  sharing. Omitting `onSharePosition` hides the row (no open incident to report into). */
  shareAs?: string | null
  /** true → open the name picker; false → stop sharing and delete the reported position */
  onSharePosition?: (on: boolean) => void
  /** open the name picker to change WHO this device reports as — the name row under «Standort
   *  verwenden», shown while the permission stands. Omitted → no name row. */
  onChangeShareName?: () => void
}) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadPrefs().theme ?? 'auto')
  // a reset (or its undo, from the toast) rewrote the theme too
  useEffect(() => onDevicePrefsReset(() => setThemeMode(loadPrefs().theme ?? 'auto')), [])
  const setTheme = (m: ThemeMode) => {
    setThemeMode(m)
    savePrefs({ ...loadPrefs(), theme: m })
    applyTheme(resolveTheme(m, themeCoord, new Date()))
  }
  const sp = appConfig.copy.sharePosition

  const themeOpts: { m: ThemeMode; label: string }[] = [
    { m: 'auto', label: appConfig.copy.nav.autoMode },
    { m: 'device', label: appConfig.copy.nav.deviceMode },
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
  // the jsPDF chunk loads lazily so it stays out of the critical bundle. Offline it prints the
  // last roster this device held (usePersonnel · loadRoster); with none at all it still yields a
  // usable sheet with blank guest lines.
  const [sheetBusy, setSheetBusy] = useState(false)
  const downloadBlankSheet = async () => {
    if (sheetBusy) return
    setSheetBusy(true)
    let names: string[] = []
    try {
      names = (await loadRoster())
        .filter((p) => p.active)
        .map((p) => p.displayName)
        .sort(compareText)
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
    <Modal title={cp.sheetTitle} onClose={onClose}>
      <div className="set-sheet">
        <section className="set-group">
          <h3 className="set-group-t">{cp.handGroup}</h3>
          <div className="set-card">
            <div className="set-row">
              {/* the line under the name says what the selected option does – it is what tells
                  «Automatisch» (time of day) and «Gerät» (the OS setting) apart */}
              <span className="set-row-l">{cp.colorScheme}<small>{cp.colorSchemeHint[themeMode]}</small></span>
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
              {/* a yes/no too («soll da Text stehen»), so the same `OnOff` (28.09.2026) – it said
                  «Aus | Wörter»; the stored value keeps its 'off' | 'short' names */}
              <OnOff ariaLabel={cp.railLabels} value={railLabels === 'short'} onChange={(v) => onRailLabels(v ? 'short' : 'off')} />
            </div>
            {/* The yes/no rows below are the ONE binary idiom, `OnOff` – «Aus | An», in that
                order (28.09.2026). They each built their own pair, «Ein | Aus» or «Erlaubt | Aus»,
                with «on» on the LEFT – the mirror image of every editor sheet's switch, so the same
                thumb-position meant «on» here and «off» there. */}
            <div className="set-row">
              <span className="set-row-l">{cp.keepScreenOn}<small>{cp.keepScreenOnSub}</small></span>
              <OnOff ariaLabel={cp.keepScreenOn} value={keepScreenOn} onChange={onKeepScreenOn} />
            </div>
            {onPhotoPosition && (
              <div className="set-row">
                <span className="set-row-l">{appConfig.copy.photoGeo.settingsLabel}<small>{appConfig.copy.photoGeo.settingsHint}</small></span>
                <OnOff ariaLabel={appConfig.copy.photoGeo.settingsLabel} value={!!photoPosition} onChange={onPhotoPosition} />
              </div>
            )}
            {/* No Führungsansicht row (05.10.2026): it is the LOGIN's, set by the admin
                (Benutzer · «Startet in Führungsansicht»), not a per-device switch. */}
            {/* Standort verwenden — the standing PERMISSION only, never the act of sharing:
                that is switched on per Einsatz from the compass menu on the map. A device
                preference, so it belongs in this group and NOT in the synced incident settings,
                where a second editor could grant it on somebody else's behalf. */}
            {onSharePosition && (
              <div className="set-row">
                <span className="set-row-l">
                  {sp.settingsLabel}
                  <small>{sp.settingsHint}</small>
                </span>
                <OnOff ariaLabel={sp.settingsLabel} value={!!shareAs} onChange={onSharePosition} />
              </div>
            )}
            {/* WHO the device reports as — its own row with the name ON the button, so changing it
                is one tap (05.10.2026, owner: «have the selected person … be immediately
                editable»). It was a grey «Als …» under the switch, and the only way to another
                name was off, on, and the consent sheet all over again. */}
            {onSharePosition && shareAs && onChangeShareName && (
              <div className="set-row">
                <span className="set-row-l">{sp.settingsName}<small>{sp.settingsNameSub}</small></span>
                <Button className="set-name" icon={<Icon id="pen" />} onClick={onChangeShareName}
                  aria-label={`${sp.settingsName}: ${shareAs} – ${sp.change}`}>
                  <span className="set-name-v">{shareAs}</span>
                </Button>
              </div>
            )}
          </div>
          <p className="set-group-foot">{cp.deviceFoot}</p>
        </section>

        {/* The way back (13.11.2026, PLACE.7): a slider pushed to the end at a drill has no mark
            to find 100 % again. The sub names what resets and what stays; the toast takes it
            back (lib/useDevicePrefs · resetDevicePrefs) – a device pref is not on the
            Einsatz's undo timeline (docs/undo.md), so the toast is the only undo. Its own card
            after the prefs it resets (M9 A). */}
        <div className="set-card">
          <div className="set-row">
            <span className="set-row-l">{cp.resetDevice}<small>{cp.resetDeviceSub}</small></span>
            <Button icon={<Icon id="undo" />} onClick={() => undoToast(cp.resetDeviceDone, resetDevicePrefs())}>
              {cp.resetDeviceBtn}
            </Button>
          </div>
        </div>

        <DeviceSection readiness={readiness} focus={focus} />

        {/* The «Einsatz» group (Funkkontakt-Intervall, Nachfrist, Funkkanal) left this sheet
            28.08.: station doctrine belongs in /admin, where whoever set it up changes it — not
            under the finger of an unknowing operator at 3am. The per-incident override plumbing
            (IncidentSettings) stays for values already written; the doctrine is the source. */}

        <section className="set-group">
          <h3 className="set-group-t">{cp.utilityGroup}</h3>
          <div className="set-card">
            <div className="set-row">
              <span className="set-row-l">{cp.blankSheet}<small>{cp.blankSheetSub}</small></span>
              {/* the roster fetch and the PDF chunk take a moment: the loader says it is working (28.10.2026) */}
              <Button icon={sheetBusy ? <ShellLoader /> : <Icon id="doc" />} disabled={sheetBusy} aria-busy={sheetBusy || undefined} onClick={() => void downloadBlankSheet()}>
                {cp.blankSheetDownload}
              </Button>
            </div>
            {onFeedback && (
              <div className="set-row">
                <span className="set-row-l">{cp.feedbackRow}<small>{cp.feedbackRowSub}</small></span>
                <Button icon={<Icon id="mail" />} onClick={onFeedback}>
                  {cp.feedbackOpen}
                </Button>
              </div>
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}

/** One part of the summary row: its word after a ✓ (green) or a dot in its state's colour. */
function SumPart({ state, word }: { state: DevicePartState | null; word: string }) {
  return (
    <span className={`set-sum-part set-sum-${state ?? 'unknown'}`}>
      {state === 'ok' ? <Icon id="check" /> : <span className="set-sum-dot" aria-hidden />}{word}
    </span>
  )
}

/** «Dieses Gerät» as ONE folded section of the Einstellungen (round 2b, owner's pick 13.11.2026):
 *  the summary row «Alarm ✓ · Offline ✓ · App installiert» – a part that is not green in its
 *  state's colour – opens the full rows. The body stays MOUNTED while folded (`hidden`): the
 *  Offline block probes the device to know its own state and reports it up (panels/deviceState),
 *  which is what the summary and the self-opening read. A tap decides for good, once made. */
function DeviceSection({ readiness, focus }: { readiness?: ReactNode; focus?: 'offline' }) {
  const cp = appConfig.copy.settings
  const { rows, available, store, linkSession } = useAlarmReadiness()
  const [offline, setOffline] = useState<DevicePartState | null>(null)
  const report = useCallback((v: DevicePartState) => setOffline(v), [])
  const installed = rows.find((r) => r.key === 'installed')
  const alarm: DevicePartState | null = linkSession ? null
    : available === false || store.optedOut ? 'warn'
      : readinessSummary(rows.filter((r) => r.key !== 'installed')).state
  const needs = alarm === 'red' || offline === 'red'
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? (focus === 'offline' || needs)
  // opened from an offline door: start there. A callback ref – the sheet mounts its body after
  // this component's effects.
  const [scrolled, setScrolled] = useState(false)
  const offlineRef = (el: HTMLDivElement | null) => {
    if (!el || focus !== 'offline' || scrolled) return
    setScrolled(true)
    el.scrollIntoView?.({ block: 'start' })
  }
  const parts = (
    <span className="set-sum">
      {alarm && <SumPart state={alarm} word={cp.deviceSumAlarm} />}
      {readiness && <SumPart state={offline} word={cp.deviceSumOffline} />}
      {installed && <SumPart state={installed.state} word={installed.state === 'ok' ? cp.deviceSumApp : cp.deviceSumNoApp} />}
    </span>
  )
  return (
    <section className="set-group" data-device-section={open ? 'open' : 'folded'}>
      <ListCard>
        <ListRow title={cp.deviceGroup} sub={parts} chevron={false} onClick={() => setChosen(!open)} aria-expanded={open}
          end={<Icon id="chevron-down" className="chev" />} data-device-summary="" />
      </ListCard>
      <div className="set-device-body" hidden={!open}>
        {/* «Alarm auf diesem Gerät» (3am sweep §1, 23.10.2026): would a «Neuer Einsatz» wake this
            device? One line that opens (sweep 28.10.2026, 17A) */}
        <AlarmReadinessRows className="set-alarm" />
        {readiness && (
          <OfflineStateContext.Provider value={report}>
            <div ref={offlineRef} className="set-ready" data-device-part="offline">{readiness}</div>
          </OfflineStateContext.Provider>
        )}
      </div>
    </section>
  )
}

/** «Einstellungen» with no Einsatz open (the launcher, «Karte & Objekte», the Objektbesuche): owns
 *  the pref state itself (mounted only while open, reads/writes the prefs cookie directly). The
 *  Karte home hands it its `readiness` (KarteDeviceRows); the launcher has none to hand. */
export function HomeDeviceSheet({ onClose, onFeedback, readiness, focus }: {
  onClose: () => void
  onFeedback?: () => void
  readiness?: ReactNode
  focus?: 'offline'
}) {
  const { symbolScale, setSymbolScale, symbolCaptions, setSymbolCaptions, keepScreenOn, setKeepScreenOn, railLabels, setRailLabels } = useDevicePrefs()
  useEffect(() => {
    // the legacy `symbolSize` key rides along in the spread untouched — see prefs · symbolScales
    savePrefs({ ...loadPrefs(), symbolScaleMap: symbolScale.map, symbolScaleBoard: symbolScale.board, symbolCaptions, keepScreenOn, railLabels })
  }, [symbolScale, symbolCaptions, keepScreenOn, railLabels])
  return (
    <SettingsSheet
      onClose={onClose}
      symbolScale={symbolScale}
      railLabels={railLabels}
      onRailLabels={setRailLabels}
      onSymbolScale={setSymbolScale}
      symbolCaptions={symbolCaptions}
      onSymbolCaptions={setSymbolCaptions}
      keepScreenOn={keepScreenOn}
      onKeepScreenOn={setKeepScreenOn}
      themeCoord={null}
      onFeedback={onFeedback}
      readiness={readiness}
      focus={focus}
    />
  )
}
