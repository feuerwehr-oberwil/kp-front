import { useEffect, useState } from 'react'
import { Popover, PopoverClose } from '../lib/overlays'
import { fmtMMSS } from '../lib/geo'
import { fmtElapsedHM } from '../lib/format'
import { formatTime, fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { fmtClock, type AtemschutzAlarmState } from '../lib/atemschutz'
import type { Incident, WeatherData } from '../types'
import { appConfig } from '../config/appConfig'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { useHoldEntry } from '../lib/useHoldEntry'
import { condition, fromLabel, fromLabelLong, windArrowRotation } from './WindBadge'

type ClockMode = 'elapsed' | 'now' | 'start'
const CLOCK_MODES: ClockMode[] = ['elapsed', 'now', 'start']
// distinct glyph per mode so the icon itself says which time you're reading: elapsed duration
// (hourglass), current wall time (plain clock), start of the operation (flag).
const CLOCK_ICON: Record<ClockMode, string> = { elapsed: 'hourglass', now: 'clock', start: 'flag' }

interface Props {
  incident: Incident
  /** ISO incident start — drives the running Einsatzuhr next to the wall clock */
  startedAt?: string | null
  /** ISO end of the Einsatz (declared Einsatzende, else the server's closure). Present ⇒ the
   *  Einsatzdauer is FINAL and stops there instead of counting on from `now`. */
  endedAt?: string | null
  recording: boolean
  recStartedAt: number | null
  journalOpen: boolean
  onToggleJournal: () => void
  /** count of open Wiedervorlagen — shown as a small badge on the Verlauf button */
  reminderCount?: number
  /** quick tap on "Eintrag" — open the composer. Omitted hides the button entirely: a
      session that may not write the Verlauf (an Einsatz-Link) must not be offered it. */
  onAddEntry?: () => void
  /** press-and-hold "Eintrag" — start recording a voice memo (latches on release) */
  onHoldStart?: () => void
  /** tap the recording button — stop + save the voice memo */
  onHoldEnd?: () => void
  /** replaces the static incident title/address (e.g. the incident switcher) */
  titleSlot?: React.ReactNode
  /** global undo/redo — re-homed here from the old left Rail so both surfaces reach it */
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  /** viewers (read-only) get inspection but not the editing history controls */
  showHistory?: boolean
  /** phone-only surface controls folded into the bar: a primary view action (locate →
   *  centre on incident on the map; fit → fit-to-view on the plan). Null on desktop,
   *  where these live in the rail footer. */
  mapNav?: { action: { icon: string; label: string; onClick: () => void } } | null
  /** map weather reading, rendered as a readout next to "Eintrag" (replaces the floating
   *  corner badge). Null off the map / while loading. */
  weather?: WeatherData | null
  /** open the MeteoSwiss details for the incident location */
  onOpenWeather?: () => void
  /** live map bearing (deg) — the wind arrow follows the map rotation like the compass */
  bearing?: number
  /** app-wide Atemschutz alarm state — drives the conditional chip (only shown when a Trupp is
   *  fällig/überfällig, so it never crowds the bar in the normal case) */
  azAlarm?: AtemschutzAlarmState
  /** Live GPS feed has gone silent — the vehicles on the map are frozen. */
  gpsStale?: boolean
  /** Age of the last successful GPS poll, for the chip's readout. */
  gpsAgeMs?: number | null
  /** jump to the Atemschutz surface (chip tap) */
  onOpenAtemschutz?: () => void
  /** «Standort teilen» indicator, when THIS device is reporting its holder's position. It
   *  belongs in the bar rather than behind a menu: a device sharing somebody's location has to
   *  say so on the screen they are already looking at, and it is the only such control a
   *  link-scoped session gets (Einstellungen is hidden for those). */
  shareSlot?: React.ReactNode
}

// Single-line top bar: incident identity + clock on the left, global journal +
// undo/redo on the right (the surface switch moved to the left NavRail). The clock
// interval lives here so the per-second tick re-renders only the bar, not the map below.
export function TopBar({ incident, startedAt, endedAt, recording, recStartedAt, journalOpen, onToggleJournal, reminderCount = 0, onAddEntry, onHoldStart, onHoldEnd, titleSlot, onUndo, onRedo, canUndo, canRedo, showHistory, mapNav, weather, onOpenWeather, bearing = 0, azAlarm, onOpenAtemschutz, gpsStale, gpsAgeMs, shareSlot }: Props) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const recSec = recording && recStartedAt ? Math.max(0, Math.round((now - recStartedAt) / 1000)) : 0
  const hasWind = weather?.wind_dir_deg != null

  // Einsatzuhr can show the running duration, the wall clock, or the start time. It's the only
  // clock in the bar (the OS status bar covers wall time), so all three are reachable — from a
  // LABELLED dropdown (each mode named + its value + a check on the active one) rather than a
  // blind tap-to-cycle, so the reading is never ambiguous at 3am. Choice persists per device.
  const [clockMode, setClockMode] = useState<ClockMode>(() => loadPrefs().clockMode ?? 'elapsed')
  const E = appConfig.copy.einsatzuhr
  const startMs = startedAt ? Date.parse(startedAt) : 0
  // An Einsatz that is OVER has a duration, not a stopwatch. It used to keep counting from
  // `now`, so an archived Einsatz opened from the Verlauf claimed «14:22» of Einsatzdauer for
  // something that lasted 40 minutes last Tuesday — the one number on the bar, wrong by days.
  const endMs = endedAt ? Date.parse(endedAt) : 0
  const stoppedAt = Number.isFinite(endMs) && endMs > startMs ? endMs : 0
  const clockValue = (m: ClockMode) =>
    m === 'now' ? formatTime(new Date(now), true)
      : m === 'start' ? formatTime(new Date(startMs))
        : fmtElapsedHM((stoppedAt || now) - startMs)
  const clockLabel: Record<ClockMode, string> = { elapsed: E.modeElapsed, now: E.modeNow, start: E.modeStart }
  const pickClock = (m: ClockMode) => { setClockMode(m); savePrefs({ ...loadPrefs(), clockMode: m }) }
  const clockText = startedAt ? clockValue(clockMode) : ''

  // Eintrag gesture (shared with the mobile FAB so they behave identically). The hook runs
  // unconditionally — hooks can't be skipped — but with the button unrendered nothing ever
  // reaches these handlers, so the no-op fallbacks are only there to satisfy the signature.
  const noop = () => {}
  const { pressing, handlers } = useHoldEntry({
    recording,
    onTap: onAddEntry ?? noop,
    onHoldStart: onHoldStart ?? noop,
    onHoldStop: onHoldEnd ?? noop,
  })

  return (
    <div className="topbar">
      {titleSlot ?? (
        <>
          <div className="ename">{incident.title}</div>
          <span className="eaddr">{incident.address}</span>
        </>
      )}
      <div className="vr" />
      {/* No fixed wall clock in the bar — the OS status bar (iPad navbar) already shows the time,
          and the Einsatzuhr below can be cycled to the wall clock when needed. */}
      {/* Einsatzuhr: the long-incident awareness anchor — tap opens a labelled mode menu */}
      {startedAt && (
        <Popover
          side="bottom"
          align="start"
          popupClassName="tb-uhr-menu"
          ariaLabel={fillTemplate(E.title, { t: formatTime(new Date(startedAt)) })}
          trigger={
            <button
              type="button"
              className="stat tb-einsatzuhr"
              title={fillTemplate(E.title, { t: formatTime(new Date(startedAt)) })}
              aria-label={`${clockLabel[clockMode]}: ${clockText}`}
            >
              <Icon id={CLOCK_ICON[clockMode]} /><b>{clockText}</b><Icon id="chevron-down" className="tb-uhr-chev" />
            </button>
          }
        >
          {CLOCK_MODES.map((m) => (
            <PopoverClose key={m} className={`tb-uhr-row${clockMode === m ? ' on' : ''}`} onClick={() => pickClock(m)}>
              <Icon id={CLOCK_ICON[m]} /><span className="tb-uhr-lbl">{clockLabel[m]}</span>
              <span className="tb-uhr-val">{clockValue(m)}</span><Icon id="check" className="tb-uhr-chk" />
            </PopoverClose>
          ))}
        </Popover>
      )}

      {/* Journal + undo/redo, reachable from both surfaces. Do not open this comment with the
          word "global" — ESLint reads such a block as a globals declaration and then reports
          every word in it as an unused variable. */}
      <div className="tb-actions">
        {mapNav && (
          <>
            <button className="tb-act icon" title={mapNav.action.label} aria-label={mapNav.action.label} onClick={mapNav.action.onClick}><Icon id={mapNav.action.icon} /></button>
            <span className="tb-vr" />
          </>
        )}
        {showHistory && (
          <>
            {/* tb-act-history / tb-vr-history: a name the stylesheet can aim at. On a phone with an
                überfällig chip in the bar these two are what steps aside — see app.css. Positional
                selectors would have picked the wrong buttons, because the mapNav action ahead of
                them is a .tb-act.icon too and comes and goes with the surface. */}
            <button className="tb-act icon tb-act-history" title={appConfig.copy.undo} aria-label={appConfig.copy.undo} disabled={!canUndo} onClick={onUndo}><Icon id="undo" /></button>
            <button className="tb-act icon tb-act-history" title={appConfig.copy.redo} aria-label={appConfig.copy.redo} disabled={!canRedo} onClick={onRedo}><Icon id="redo" /></button>
            <span className="tb-vr tb-vr-history" />
          </>
        )}
        <button className={`tb-act ${journalOpen ? 'on' : ''}`} aria-pressed={journalOpen} onClick={onToggleJournal} title={reminderCount > 0 ? appConfig.copy.journal.openCount.replace('{n}', String(reminderCount)) : appConfig.copy.journal.open}>
          <Icon id="history" /><span>{appConfig.copy.journal.open}</span>
          {reminderCount > 0 && <span className="tb-rem-count" aria-label={appConfig.copy.journal.openCount.replace('{n}', String(reminderCount))}>{reminderCount}</span>}
        </button>
        {onAddEntry && (
          <button
            className={`tb-act tb-act-add ${recording ? 'rec' : ''}`}
            title={recording ? appConfig.copy.journal.recordStop : appConfig.copy.journal.addHint}
            {...handlers}
          >
            {pressing && !recording && <span className="tb-hold" />}
            {recording
              ? <><span className="tb-stop" /><span>{fmtMMSS(recSec)}</span></>
              : <><Icon id="plus" /><span>{appConfig.copy.journal.add}</span></>}
          </button>
        )}
        {/* wrapped in a stable class so the phone rule can lift it out of the bar — see
            .tb-share in app.css. The bar's four 44px actions do not fit a 390px screen. */}
        {shareSlot && <span className="tb-share">{shareSlot}</span>}
        {hasWind && <WeatherBadge weather={weather!} onOpenMeteo={onOpenWeather} bearing={bearing} />}
        {/* GPS-Feed-Chip. Die Fahrzeuge bleiben absichtlich auf der Karte, wenn der Feed
            stirbt — sie verschwinden zu lassen läse sich als «abgerückt» statt als «Feed
            weg». Genau deshalb braucht das Einfrieren einen sichtbaren Vorbehalt: ohne ihn
            sehen stundenalte Positionen exakt so verbindlich aus wie eine Minute alte. */}
        {gpsStale && (
          <span
            className="tb-gps"
            title={appConfig.copy.topBar.gpsFrozenHint}
            role="status"
          >
            {/* the app's own position glyph — a speedometer (`gauge`) named nothing about a
                silent position feed. The amber pill carries the caveat; the icon says WHAT. */}
            <Icon id="locate" />
            <span>{appConfig.copy.topBar.gpsFrozen}</span>
            {gpsAgeMs != null && (
              <span className="tb-gps-age">{Math.round(gpsAgeMs / 60_000)} min</span>
            )}
          </span>
        )}
        {/* Atemschutz alarm chip — pinned at the far right so it never shifts the other controls.
            Only present once a Trupp is ÜBERFÄLLIG (red); the amber "fällig" lead stays on the
            board only. Taps through to the Atemschutz surface. */}
        {azAlarm && azAlarm.peak >= 2 && azAlarm.urgent && (
          <button
            className="tb-az crit"
            onClick={onOpenAtemschutz}
            title={appConfig.copy.atemschutz.chipHint}
            aria-label={`${appConfig.copy.modes.atemschutz}: ${appConfig.copy.atemschutz.clockOverdue} — ${azAlarm.urgent.name}`}
          >
            <Icon id="gauge" />
            <span className="tb-az-name">{azAlarm.urgent.name}</span>
            {/* ticks off the bar's own 1 Hz clock — the alarm state object itself stays
                reference-stable between tier/Trupp transitions (App must not re-render per second) */}
            <span className="tb-az-clock">{fmtClock(Math.round((now - azAlarm.urgent.contactAt) / 1000))}</span>
          </button>
        )}
      </div>
    </div>
  )
}

/** The tappable wind/weather readout + its detail popover. Lives in the TopBar on
 *  desktop/tablet; on phones App floats it in the top-right .phone-wx read-out
 *  instead (the bar is too narrow — it clipped at the screen edge). */
export function WeatherBadge({ weather, onOpenMeteo, bearing = 0 }: { weather: WeatherData; onOpenMeteo?: () => void; bearing?: number }) {
  const cond = condition(weather.weather_code)
  if (weather.wind_dir_deg == null) return null
  return (
    <div className="tb-weather-wrap">
      <Popover
        popupClassName="tb-weather-pop"
        ariaLabel={appConfig.copy.weather.details}
        side="bottom"
        align="end"
        sideOffset={8}
        zIndex={201}
        trigger={
          <button className="tb-weather"
            title={`${cond ? `${cond.label} · ` : ''}${fillTemplate(appConfig.copy.weather.windTitle, { dir: fromLabel(weather.wind_dir_deg), deg: Math.round(weather.wind_dir_deg) })}${appConfig.copy.weather.detailsHint}`}
            aria-label={appConfig.copy.weather.label}>
            {cond && <span className="tb-weather-cond" aria-hidden><Icon id={cond.icon} /></span>}
            {weather.temp_c != null && <b className="tb-weather-temp">{Math.round(weather.temp_c)}°</b>}
            {/* arrow points DOWNWIND (where the wind/smoke is going); follows the map rotation */}
            <span className="tb-wind-arr" style={{ transform: `rotate(${windArrowRotation(weather.wind_dir_deg, bearing)}deg)` }} aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 L12 21" /><path d="M6 15 L12 21 L18 15" /></svg>
            </span>
            {weather.wind_speed_kmh != null && <b>{Math.round(weather.wind_speed_kmh)} km/h</b>}
          </button>
        }
      >
        <WeatherDetails weather={weather} cond={cond} onOpenMeteo={onOpenMeteo} />
      </Popover>
    </div>
  )
}

// Tap-to-open weather detail popover: spells the wind direction out, surfaces the params we
// already fetch but don't fit in the bar (gusts, precip, station, reading time), and is the
// ONLY place the external MeteoSchweiz radar link lives.
// Content of the weather detail popover (the <Popover> primitive supplies the anchored,
// portalled, dismissible shell): spells the wind direction out, surfaces the params we already
// fetch but don't fit in the bar (gusts, precip, station, reading time), and is the ONLY place
// the external MeteoSchweiz radar link lives.
function WeatherDetails({ weather, cond, onOpenMeteo }: {
  weather: WeatherData
  cond: { icon: string; label: string } | null
  onOpenMeteo?: () => void
}) {
  const dir = weather.wind_dir_deg
  const observed = weather.observed_at ? new Date(weather.observed_at).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : null
  const w = appConfig.copy.weather
  return (
    <>
        <div className="wx-pop-head">
          {cond && <span className="wx-pop-cond" aria-hidden><Icon id={cond.icon} /></span>}
          <div className="wx-pop-head-t">
            <b>{cond?.label ?? w.label}</b>
            {weather.temp_c != null && <span>{Math.round(weather.temp_c)} °C</span>}
          </div>
        </div>
        <dl className="wx-pop-rows">
          {dir != null && (
            <div className="wx-pop-row"><dt>{w.windDir}</dt><dd>{fromLabelLong(dir)} · {Math.round(dir)}°</dd></div>
          )}
          {weather.wind_speed_kmh != null && (
            <div className="wx-pop-row"><dt>{w.windSpeed}</dt><dd>{Math.round(weather.wind_speed_kmh)} km/h</dd></div>
          )}
          {weather.wind_gust_kmh != null && (
            <div className="wx-pop-row"><dt>{w.gust}</dt><dd>{Math.round(weather.wind_gust_kmh)} km/h</dd></div>
          )}
          {weather.precip_mm != null && (
            <div className="wx-pop-row"><dt>{w.precip}</dt><dd>{weather.precip_mm} mm/h</dd></div>
          )}
          {weather.station && (
            <div className="wx-pop-row"><dt>{w.station}</dt><dd>{weather.station}</dd></div>
          )}
          {(observed || weather.source) && (
            <div className="wx-pop-row"><dt>{w.source}</dt><dd>{[weather.source, observed].filter(Boolean).join(' · ')}</dd></div>
          )}
        </dl>
        {onOpenMeteo && (
          <PopoverClose className="wx-pop-link" onClick={onOpenMeteo}>
            <Icon id="eye" /><span>{w.meteoRadar}</span>
          </PopoverClose>
        )}
    </>
  )
}
