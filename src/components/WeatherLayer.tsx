/**
 * The Karte's weather layer – lazy (components/weatherLazy), so none of this is in the entry
 * chunk. Data: lib/useWeatherLayer (`GET /api/weather/layer`, backend app/weather_layer); rules
 * for judging it: lib/weatherLayer. Ported from kp-rueck (R5, 08.10.2026), dressed in KP Front's
 * floating family (docs/ui-conventions.md · «ONE floating family, ONE floating row»).
 *
 * Three pieces:
 * - `WeatherRadarSource` – the MeteoSwiss radar as a MapLibre image source INSIDE the map. The
 *   backend already resampled every frame onto Web Mercator, so the four corners are an
 *   axis-aligned rectangle and MapLibre only stretches it. ⚠️ It mounts late (lazy, and only
 *   while «Niederschlag» is on), and react-map-gl appends a late layer ON TOP of everything – so
 *   it names `beforeId`: the radar lies under every line, symbol and note, above the basemap.
 * - `WeatherRadarControls` – one floating pill: ▶ over the last hour, the scrubber, the frame's
 *   time and how old it is. Calm by default (paused on the newest frame, lib/useRadarPlayback).
 * - `WeatherWarningChip` – the official warnings covering the Einsatz, one chip: the awareness
 *   lamp, the source's own event word, how long it holds, «+n». A tap opens every warning in
 *   full, EXACTLY as the source wrote it (MetO art. 5). Shown whether the radar is on or not: a
 *   fire ban or an orange storm warning is not decoration you opt into.
 *
 * Never old as current: a stale radar is desaturated and its pill says «Stand hh:mm – veraltet»;
 * a warning whose source went quiet keeps its text, greyed, with «Stand hh:mm». Offline, both
 * simply age – nothing here ever waits on the network.
 */
import { useEffect, useMemo, useRef } from 'react'
import { Layer, Source, type RasterLayerSpecification } from 'react-map-gl/maplibre'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { getLocaleId } from '../config/copy'
import { cx } from '../lib/cx'
import { Icon } from '../lib/icons'
import { Popover } from '../lib/overlays'
import { vis } from '../lib/mapView'
import {
  activeWarnings,
  formatWeatherTime,
  frameAgeMinutes,
  warningHref,
  warningIsStale,
  warningLevelColor,
  warningText,
  type ApiWeatherLayer,
  type WeatherRadar,
  type WeatherWarning,
} from '../lib/weatherLayer'
import { IconButton } from './Button'
import { Slider } from './Slider'
import s from './WeatherLayer.module.css'

const RADAR_BASE = `${(import.meta.env.VITE_KP_RUECK_URL ?? '').replace(/\/$/, '')}/api/weather/radar`
const radarFrameUrl = (key: string) => `${RADAR_BASE}/${encodeURIComponent(key)}.png`

/** The first layer of the drawings (MapView · `s-draw`): the radar goes right under it. */
const WEATHER_RADAR_BEFORE = 'l-draw-atemschutz'

// ── inside the map ────────────────────────────────────────────────────────────────────────────

export function WeatherRadarSource({ radar, frameIndex, opacity, stale }: {
  radar: WeatherRadar
  frameIndex: number
  /** 0–100, the Ebenen row's slider */
  opacity: number
  stale: boolean
}) {
  const frames = radar.frames
  const frame = frames[Math.min(Math.max(frameIndex, 0), frames.length - 1)]

  // Warm the browser cache with the whole hour while the layer is on, so scrubbing and the loop
  // swap images without a fetch (each frame is immutable on the backend, `max-age` a day).
  const frameKeys = frames.map((f) => f.key).join(',')
  useEffect(() => {
    if (!frameKeys) return
    for (const key of frameKeys.split(',')) {
      const image = new Image()
      image.src = radarFrameUrl(key)
    }
  }, [frameKeys])

  const paint = useMemo<RasterLayerSpecification['paint']>(() => ({
    'raster-opacity': opacity / 100,
    'raster-fade-duration': 0,
    'raster-resampling': 'linear',
    // stale = greyed: an old shower must never be read as the current one
    'raster-saturation': stale ? -1 : 0,
  }), [opacity, stale])

  if (!frame || !radar.coordinates || radar.coordinates.length !== 4) return null
  const c = radar.coordinates
  return (
    // No `attribution` here: MapLibre's image source carries none to the ⓘ. The credit is named
    // in the radar pill whenever the radar is on, and in the Ebenen credits (CC BY 4.0).
    <Source id="s-weather-radar" type="image" url={radarFrameUrl(frame.key)}
      coordinates={[c[0], c[1], c[2], c[3]]}>
      <Layer id="l-weather-radar" type="raster" beforeId={WEATHER_RADAR_BEFORE} layout={vis(true)} paint={paint} />
    </Source>
  )
}

// ── the floating pieces ───────────────────────────────────────────────────────────────────────

export function WeatherRadarControls({ radar, frameIndex, playing, onPick, onTogglePlaying, stale, now }: {
  radar: WeatherRadar | null
  frameIndex: number
  playing: boolean
  onPick: (index: number) => void
  onTogglePlaying: () => void
  stale: boolean
  now: number
}) {
  const w = appConfig.copy.weatherLayer
  const frames = radar?.frames ?? []
  const frame = frames[frameIndex]
  if (!radar || frames.length === 0 || !frame) {
    return (
      <div className={cx(s.pill, s.radar, s.quiet)} role="status">
        <span className={s.lead} aria-hidden><Icon id="wx-rain" /></span>
        <span className={s.note}>{radar?.status.last_error ? w.radarUnavailable : w.radarPending}</span>
      </div>
    )
  }
  const age = frameAgeMinutes(radar, frameIndex)
  const when = formatWeatherTime(frame.time, now)
  const sub = stale && radar.data_time
    ? fillTemplate(w.stale, { time: formatWeatherTime(radar.data_time, now) })
    : age > 0 ? fillTemplate(w.frameAgo, { minutes: age }) : w.latest
  return (
    <div className={cx(s.pill, s.radar, stale && s.stale)} role="group" aria-label={w.radarTitle}
      // map chrome: dragging the scrubber must never pan the map underneath
      onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <IconButton label={playing ? w.pause : w.play} className={s.play} onClick={onTogglePlaying} disabled={frames.length < 2}>
        <Icon id={playing ? 'pause' : 'play'} />
      </IconButton>
      <div className={s.scrub}>
        <Slider value={frameIndex} min={0} max={Math.max(frames.length - 1, 1)} step={1} onChange={onPick}
          ariaLabel={w.frameSlider} valueText={`${when} · ${sub}`} />
      </div>
      <div className={s.when} aria-live={playing ? 'off' : 'polite'}>
        <b>{when}</b>
        <small>{sub}</small>
        {/* CC BY 4.0: the source is named whenever the radar is on */}
        <small className={s.credit}>{radar.attribution}</small>
      </div>
    </div>
  )
}

/** «ab 14:00» before it starts, «bis 06:00» while it holds, «bis auf Widerruf» without an end. */
function validity(warning: WeatherWarning, now: number): string {
  const w = appConfig.copy.weatherLayer
  const onset = warning.onset ? Date.parse(warning.onset) : null
  if (onset !== null && onset > now) return fillTemplate(w.from, { time: formatWeatherTime(warning.onset!, now) })
  if (warning.expires) return fillTemplate(w.until, { time: formatWeatherTime(warning.expires, now) })
  return w.untilRevoked
}

function levelWord(warning: WeatherWarning): string {
  const w = appConfig.copy.weatherLayer
  // The colour words are MeteoAlarm's scale. Alertswiss has none of its own here, so its alerts
  // are named for what they are – we do not invent a level for them.
  if (warning.source === 'alertswiss') return w.authorityNotice
  return warning.level >= 4 ? w.level4 : warning.level === 3 ? w.level3 : warning.level === 2 ? w.level2 : w.level1
}

function Lamp({ level, stale }: { level: number; stale?: boolean }) {
  return <span aria-hidden className={cx(s.lamp, stale && s.lampStale)} style={{ background: warningLevelColor(level) }} />
}

export function WeatherWarningChip({ layer, now, side = 'bottom' }: {
  layer: ApiWeatherLayer
  now: number
  /** where the text opens: up from the floating row, down from the phone's top-right */
  side?: 'top' | 'bottom'
}) {
  const w = appConfig.copy.weatherLayer
  // the text opens at its TOP, whatever is focusable further down (overlays · Popover · initialFocus)
  const topRef = useRef<HTMLUListElement>(null)
  const warnings = activeWarnings(layer, now)
  if (warnings.length === 0) return null
  const lang = (getLocaleId() || 'de').slice(0, 2)
  const top = warnings[0]
  const topText = warningText(top, lang)
  const anyStale = warnings.some((x) => warningIsStale(layer, x, now))
  const name = topText.event || topText.headline
  const summary = `${name} · ${validity(top, now)}`
  return (
    <Popover
      popupClassName={s.pop}
      ariaLabel={fillTemplate(w.chipAria, { count: warnings.length, summary })}
      side={side}
      align={side === 'top' ? 'start' : 'end'}
      zIndex={201}
      initialFocus={topRef}
      trigger={
        <button type="button" className={cx(s.pill, s.chip, anyStale && s.stale, 'wx-chip')}
          aria-label={fillTemplate(w.chipAria, { count: warnings.length, summary })} title={summary}>
          <Lamp level={top.level} stale={anyStale} />
          <span className={s.event}>{name}</span>
          <span className={s.valid}>· {validity(top, now)}</span>
          {warnings.length > 1 && <span className={s.more}>{fillTemplate(w.more, { count: warnings.length - 1 })}</span>}
        </button>
      }
    >
      <ul className={s.list} ref={topRef} tabIndex={-1}>
        {warnings.map((warning) => {
          const text = warningText(warning, lang)
          const stale = warningIsStale(layer, warning, now)
          return (
            <li key={warning.id} className={cx(s.item, stale && s.itemStale)}>
              <div className={s.head}>
                <Lamp level={warning.level} stale={stale} />
                <div>
                  <p className={s.headline}>{text.headline || text.event}</p>
                  <p className={s.level}>{levelWord(warning)}{warning.region ? ` · ${warning.region}` : ''}</p>
                </div>
              </div>
              <dl className={s.facts}>
                <dt>{w.validity}</dt>
                <dd>
                  {warning.onset ? `${formatWeatherTime(warning.onset, now)} – ` : ''}
                  {warning.expires ? formatWeatherTime(warning.expires, now) : w.untilRevoked}
                </dd>
                <dt>{w.source}</dt>
                <dd>{warning.source === 'meteoswiss' ? w.sourceMeteoswiss : fillTemplate(w.sourceAlertswiss, { publisher: warning.sender })}</dd>
              </dl>
              {/* Verbatim: line breaks as the source set them, nothing cut. */}
              {text.description && <p className={s.body}>{text.description}</p>}
              {text.instructions.length > 0 && (
                <ul className={s.instructions}>
                  {text.instructions.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              )}
              {stale && warning.fetched_at && (
                <p className={s.staleNote}>{fillTemplate(w.warningStale, { time: formatWeatherTime(warning.fetched_at, now) })}</p>
              )}
              {warning.link && (
                <a className={s.link} href={warningHref(warning.link)} target="_blank" rel="noreferrer">
                  <span>{w.moreInfo}</span><Icon id="external" />
                </a>
              )}
            </li>
          )
        })}
      </ul>
      <p className={s.verbatim}>{w.verbatimNote}</p>
    </Popover>
  )
}

/** Both floating pieces, placed by device (docs/ui-conventions.md · the floating row):
 *  - tablet / desktop: ONE row bottom-left, beside the nav rail – the warning, then the radar;
 *  - phone: the radar on THE floating row (left of the Eintrag FAB), the warning top-right under
 *    the wind read-out, where the phone keeps its weather. */
export function WeatherFloats({ layer, now, isPhone, radarOn, radarStale, frameIndex, playing, onPick, onTogglePlaying }: {
  layer: ApiWeatherLayer
  now: number
  isPhone: boolean
  radarOn: boolean
  radarStale: boolean
  frameIndex: number
  playing: boolean
  onPick: (index: number) => void
  onTogglePlaying: () => void
}) {
  const chip = <WeatherWarningChip layer={layer} now={now} side={isPhone ? 'bottom' : 'top'} />
  const controls = radarOn ? (
    <WeatherRadarControls radar={layer.radar} frameIndex={frameIndex} playing={playing}
      onPick={onPick} onTogglePlaying={onTogglePlaying} stale={radarStale} now={now} />
  ) : null
  if (isPhone) {
    return (
      <>
        <div className={s.phoneTop}>{chip}</div>
        {controls && <div className={cx(s.foot, 'wx-foot')}>{controls}</div>}
      </>
    )
  }
  return <div className={cx(s.foot, 'wx-foot')}>{chip}{controls}</div>
}
