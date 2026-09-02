import { useEffect, useRef, useState } from 'react'
import { Popover, PopoverClose } from '../lib/overlays'
import { fmtMMSS } from '../lib/geo'
import { fmtElapsedHM } from '../lib/format'
import { formatTime, fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { fmtClock, type AtemschutzAlarmState } from '../lib/atemschutz'
import type { Incident, ReactivateResult, WeatherData } from '../types'
import { appConfig } from '../config/appConfig'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { useHoldEntry } from '../lib/useHoldEntry'
import { HoldChargeRing, HoldTargets } from './HoldTargets'
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
  /** the hold was released over «Sprachnotiz» (or released without moving) — start the memo */
  onHoldStart?: () => void
  /** tap the recording button — stop + save the voice memo */
  onHoldEnd?: () => void
  /** the hold was released over «Foto» — straight to the camera (see useHoldEntry) */
  onHoldPhoto?: () => void
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
  /** jump to the Atemschutz surface (chip tap) — carries the urgent Trupp's id so the board
   *  can land ON the card the chip names, not merely near it */
  onOpenAtemschutz?: (truppId?: string) => void
  /** «Standort teilen» indicator, when THIS device is reporting its holder's position. It
   *  belongs in the bar rather than behind a menu: a device sharing somebody's location has to
   *  say so on the screen they are already looking at, and it is the only such control a
   *  link-scoped session gets (Einstellungen is hidden for those). */
  shareSlot?: React.ReactNode
  /** The Einsatz is closed and open read-only. It rides HERE, beside its name, rather than as a
   *  banner in the message layer: «Nur ansehen» is a property of the incident, and the incident
   *  lives in the head (23.08.). The chip carries the two deliberate exits with it. */
  archived?: boolean
  /** leave the read-only view — back to the previously active Einsatz / «Alle Einsätze» */
  onBackFromArchive?: () => void
  /** editors only: re-open the closed Einsatz (its own confirm lives upstream) */
  onReactivate?: () => Promise<ReactivateResult>
}

// Single-line top bar: incident identity + clock on the left, global journal +
// undo/redo on the right (the surface switch moved to the left NavRail). The clock
// interval lives here so the per-second tick re-renders only the bar, not the map below.
export function TopBar({ incident, startedAt, endedAt, recording, recStartedAt, journalOpen, onToggleJournal, reminderCount = 0, onAddEntry, onHoldStart, onHoldEnd, onHoldPhoto, titleSlot, onUndo, onRedo, canUndo, canRedo, showHistory, mapNav, weather, onOpenWeather, bearing = 0, azAlarm, onOpenAtemschutz, gpsStale, gpsAgeMs, shareSlot, archived, onBackFromArchive, onReactivate }: Props) {
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
  const clockText = Number.isFinite(startMs) && startMs > 0 ? clockValue(clockMode) : '' // an unparseable start shows nothing, not «Invalid Date»

  // Eintrag gesture (shared with the mobile FAB so they behave identically). The hook runs
  // unconditionally — hooks can't be skipped — but with the button unrendered nothing ever
  // reaches these handlers, so the no-op fallbacks are only there to satisfy the signature.
  const noop = () => {}
  const { pressing, pressedSince, latched, hover, anchor, handlers } = useHoldEntry({
    recording,
    onTap: onAddEntry ?? noop,
    onHoldStart: onHoldStart ?? noop,
    onHoldStop: onHoldEnd ?? noop,
    onHoldPhoto,
  })

  return (
    <div className="topbar">
      {titleSlot ?? (
        <>
          <div className="ename">{incident.title}</div>
          <span className="eaddr">{incident.address}</span>
        </>
      )}
      {archived && <ArchivedChip onBack={onBackFromArchive} onReactivate={onReactivate} />}
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
        {/* ⚠️ `has-rem` tints the BUTTON, not just its corner. The count badge alone is 17px of amber
            hanging off a 44px icon — and on a phone the next thing in the bar is the Atemschutz
            chip, which is painted after it and simply covered it up. What «12 offen» has to do is
            be noticed from across a Schadenplatz, so the control it belongs to carries the colour
            and the number rides along (see .tb-act.has-rem). */}
        <button className={`tb-act ${journalOpen ? 'on' : ''} ${reminderCount > 0 ? 'has-rem' : ''}`} aria-pressed={journalOpen} onClick={onToggleJournal}
          aria-label={reminderCount > 0 ? appConfig.copy.journal.openCount.replace('{n}', String(reminderCount)) : appConfig.copy.journal.open}
          title={reminderCount > 0 ? appConfig.copy.journal.openCount.replace('{n}', String(reminderCount)) : appConfig.copy.journal.open}>
          <Icon id="history" /><span>{appConfig.copy.journal.open}</span>
          {reminderCount > 0 && <span className="tb-rem-count" aria-label={appConfig.copy.journal.openCount.replace('{n}', String(reminderCount))}>{reminderCount}</span>}
        </button>
        {onAddEntry && (
          <button
            className={`tb-act tb-act-add ${recording ? 'rec' : ''} ${latched ? 'cancelling' : ''}`}
            // held at its measured width while it is an ✕, so dropping the label cannot resize it
            style={latched && anchor ? { width: anchor.width } : undefined}
            title={recording ? appConfig.copy.journal.recordStop : appConfig.copy.journal.addHint}
            data-hold-target="cancel"
            {...handlers}
          >
            {/* below: this button lives in the TOP bar, so the targets open downward */}
            {latched && <HoldTargets hover={hover} placement="below" anchor={anchor} />}
            {recording
              ? <><span className="tb-stop" /><span className="tb-act-label">{fmtMMSS(recSec)}</span></>
              : <>
                {/* the charge ring rings the + icon — anchored at the right edge it sat ON the
                    label's last letters and read as clutter over the word it was charging */}
                <span className="tb-act-ic">
                  {/* inline path, not a sprite <use> — same defence as FabEntry (29.08.): the
                      field-logging + must never render as an empty circle when a sprite fails
                      to resolve across remounts */}
                  <svg className="i" viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
                  {pressing && pressedSince != null && <HoldChargeRing since={pressedSince} />}
                </span>
                <span className="tb-act-label">{appConfig.copy.journal.add}</span>
              </>}
          </button>
        )}
        {/* wrapped in a stable class so the phone rule can lift it out of the bar — see
            .tb-share in app.css. The bar's four 44px actions do not fit a 390px screen. */}
        {shareSlot && <span className="tb-share">{shareSlot}</span>}
        {hasWind && <WeatherBadge weather={weather!} onOpenMeteo={onOpenWeather} bearing={bearing} />}
        {/* GPS feed chip. The Fahrzeuge deliberately stay on the map when the feed dies —
            letting them disappear would read as «abgerückt» rather than as «Feed weg». That
            is exactly why the freeze needs a visible caveat: without one, hours-old positions
            look every bit as binding as a position one minute old. */}
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
        {/* Atemschutz chip — pinned at the far right so it never shifts the other controls.
            AMBER from «Kontakt fällig» on (the quiet lead used to stay board-only, so the first
            the top bar said anything was the red alarm), RED once a Trupp is überfällig or at
            its Alarmdruck. Taps through to the Atemschutz surface. */}
        {azAlarm && azAlarm.peak >= 1 && azAlarm.urgent && (() => {
          // ⚠️ TWO reasons this chip can be red, and it has to say which. Out of contact ticks a
          // clock; at or below the Alarmdruck it shows the bar. A chip that showed a contact
          // clock for a Trupp whose air is gone would name the wrong emergency.
          const u = azAlarm.urgent
          const crit = azAlarm.peak >= 2
          const lowPressure = u.reason === 'pressure'
          const what = lowPressure
            ? fillTemplate(appConfig.copy.atemschutz.alarmNote, { bar: String(u.bar ?? '') })
            : crit ? appConfig.copy.atemschutz.clockOverdue : appConfig.copy.atemschutz.clockWarn
          return (
            <button
              className={`tb-az ${crit ? 'crit' : 'warn'}`}
              // the chip names ONE Trupp, so the tap lands on that Trupp's card
              onClick={() => onOpenAtemschutz?.(u.id)}
              title={appConfig.copy.atemschutz.chipHint}
              aria-label={`${appConfig.copy.modes.atemschutz}: ${what} — ${u.name}`}
            >
              <Icon id={lowPressure ? 'drop' : 'gauge'} />
              <span className="tb-az-name">{u.name}</span>
              {/* the clock ticks off the bar's own 1 Hz tick — the alarm state object stays
                  reference-stable between tier/Trupp transitions (App must not re-render per
                  second). A pressure alarm has no clock to tick: it shows the number. */}
              <span className="tb-az-clock">
                {lowPressure ? `${u.bar} bar` : fmtClock(Math.round((now - u.contactAt) / 1000))}
              </span>
            </button>
          )
        })()}
      </div>
    </div>
  )
}

/** «Einsatz abgeschlossen» as a mode chip beside the Einsatzname — the state of the incident,
 *  where the incident is named. It replaces the bottom banner that used to say the same thing on
 *  the same 16px as three other cards (and, being painted last, was the only one of the four you
 *  could read). The exits come along: tapping the chip offers «Zurück» and, for editors, «Wieder
 *  öffnen» — so nothing the banner could do got lost with it.
 *  With no exits to offer (a link session) it is a plain, non-interactive chip. */
function ArchivedChip({ onBack, onReactivate }: { onBack?: () => void; onReactivate?: () => Promise<ReactivateResult> }) {
  const C = appConfig.copy.archived
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // ⚠️ A SUCCESSFUL «Wieder öffnen» unmounts this chip — the Einsatz stops being archived — and
  // the promise settles a tick later, so neither state write below may be made unconditionally.
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const label = <><Icon id="lock" />{C.title}</>
  if (!onBack && !onReactivate) return <span className="tb-mode" title={C.hint}>{label}</span>
  return (
    <Popover side="bottom" align="start" popupClassName="tb-uhr-menu" ariaLabel={C.title}
      open={open} onOpenChange={(next) => { if (!busy) setOpen(next) }}
      trigger={<button type="button" className="tb-mode" title={C.hint} aria-label={`${C.title} – ${C.hint}`}>{label}</button>}
    >
      {onBack && (
        <PopoverClose className="tb-uhr-row" onClick={onBack}>
          <Icon id="undo" /><span className="tb-uhr-lbl">{C.back}</span>
        </PopoverClose>
      )}
      {onReactivate && (
        <button type="button" className="tb-uhr-row" disabled={busy} onClick={() => {
          setBusy(true); setOpen(false)
          void onReactivate()
            // ONLY a real failure reopens the menu — a cancelled confirm means the operator
            // is already where they wanted to be.
            .then((r) => { if (r === 'failed' && alive.current) setOpen(true) })
            // ⚠️ …and a CATCH, because reopening is not the only thing that can reject: upstream
            // the incident-list refresh runs OUTSIDE its own try, so an offline refresh throws
            // after the Einsatz has in fact been reopened. Unhandled, that was filed by the error
            // reporter as a client error for an action that succeeded. Genuine failures are
            // already reported by the caller's own toast, so there is nothing to say here.
            .catch(() => {})
            .finally(() => { if (alive.current) setBusy(false) })
        }}>
          <Icon id="pen" /><span className="tb-uhr-lbl">{C.reactivate}</span>
        </button>
      )}
    </Popover>
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
