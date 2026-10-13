/**
 * The Karte's weather layer – lazy (components/weatherLazy), so none of this is in the entry
 * chunk. Data: lib/useWeatherLayer (`GET /api/weather/layer`, backend app/weather_layer); rules
 * for judging it: lib/weatherLayer. Ported from kp-rueck (R5, 08.10.2026), dressed in KP Front's
 * floating family (docs/ui-conventions.md · «ONE floating family, ONE floating row»).
 *
 * Two pieces:
 * - `WeatherRadarSource` – the MeteoSwiss radar as a MapLibre image source INSIDE the map. The
 *   backend already resampled every frame onto Web Mercator, so the four corners are an
 *   axis-aligned rectangle and MapLibre only stretches it. ⚠️ It mounts late (lazy, and only
 *   while «Niederschlag» is on), and react-map-gl appends a late layer ON TOP of everything – so
 *   it names `beforeId`: the radar lies under every line, symbol and note, above the basemap.
 * - `WeatherRadarControls` – one floating pill: ▶ over the last hour, the scrubber, the frame's
 *   time and how old it is. Calm by default (paused on the newest frame, lib/useRadarPlayback).
 *   It stands in the Karte's ONE chip row (workspace/MapControls · `.wb-botleft`, the Plan's row
 *   too) after the Gebäude chip – never a row of its own. On a phone that row is one line beside
 *   the FAB, and the radar pill is the piece that gives way.
 *
 * Never old as current: a stale radar is desaturated and its pill says «Stand hh:mm – veraltet».
 * Offline it simply ages – nothing here ever waits on the network.
 *
 * (The official warnings chip – MeteoAlarm / Alertswiss, «Feuerverbot» – is gone, 10.10.2026,
 * owner: «drop the swissalarm thing – we don't need it».)
 */
import { useEffect, useMemo } from 'react'
import { Layer, Source, type RasterLayerSpecification } from 'react-map-gl/maplibre'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { cx } from '../lib/cx'
import { Icon } from '../lib/icons'
import { vis } from '../lib/mapView'
import { formatWeatherTime, frameAgeMinutes, type WeatherRadar } from '../lib/weatherLayer'
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
