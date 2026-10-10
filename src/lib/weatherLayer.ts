/**
 * The Karte's weather layer – what the map shows from `GET /api/weather/layer` (backend:
 * app/weather_layer). Ported from kp-rueck (R5, lib/weather.ts, 08.10.2026) so both apps judge
 * the same data the same way.
 *
 * Three rules the helpers here keep:
 * - **Never old as current.** A source is stale once its data is older than the backend's
 *   `stale_after_seconds`, measured on the shared clock (`serverNow()`, lib/serverClock) – so a
 *   tablet with a wrong clock judges like the server does, and when the backend stops answering
 *   (offline) the last answer keeps aging on screen instead of freezing as «fresh».
 * - **Verbatim.** A MeteoSwiss warning may only be passed on unaltered (MetO art. 5): the texts
 *   are picked by language, never shortened or rephrased. The chip shows the source's own
 *   `event` word; the full text is one tap away.
 * - **Expired is gone, not stale.** A warning past its `expires` disappears immediately.
 *
 * Pure: no React, no fetch – the hook is lib/useWeatherLayer, the surfaces
 * components/WeatherLayer (lazy).
 */
import { formatLocale } from './format'

/** The Ebenen row of the radar. Not a `LayerDef`: it is a device pref (lib/prefs ·
 *  weatherRadar) and only exists while the backend serves the layer, so the panel gets it as its
 *  own row and IncidentWorkspace · toggleLayer routes it by this id, like the plan rasters. */
export const WEATHER_RADAR_ROW_ID = 'weather:radar'

export interface WeatherSourceStatus {
  last_attempt_at: string | null
  last_success_at: string | null
  last_error: string | null
  last_error_at: string | null
  stale?: boolean | null
}

export interface WeatherRadarFrame {
  key: string
  time: string
}

export interface WeatherRadar {
  frames: WeatherRadarFrame[]
  /** MapLibre image-source corners: top-left, top-right, bottom-right, bottom-left, [lng, lat]. */
  coordinates: [number, number][] | null
  data_time: string | null
  stale: boolean
  stale_after_seconds: number
  status: WeatherSourceStatus
  legend: { min_mm_h: number; color: string }[]
  attribution: string
  source_url: string
}

export interface WeatherWarningText {
  event: string
  headline: string
  description: string
  instructions: string[]
}

export type WeatherWarningSource = 'meteoswiss' | 'alertswiss'

export interface WeatherWarning {
  id: string
  source: WeatherWarningSource
  /** 1 minor · 2 yellow · 3 orange · 4 red */
  level: number
  color: string | null
  kind: string | null
  sent: string | null
  onset: string | null
  expires: string | null
  sender: string
  link: string | null
  region: string
  texts: Record<string, WeatherWarningText>
  fetched_at: string | null
}

export interface ApiWeatherLayer {
  enabled: boolean
  /** whether the request named a point (the Einsatz) – without one there are no warnings */
  point: boolean
  generated_at: string | null
  radar: WeatherRadar | null
  warnings: {
    items: WeatherWarning[]
    sources: Record<string, WeatherSourceStatus>
    stale_after_seconds: number
  } | null
}

/** MeteoAlarm's awareness colours, the ones the official warning maps use. 1 = information. */
export const WARNING_LEVEL_COLORS: Record<number, string> = {
  1: '#94a3b8',
  2: '#facc15',
  3: '#f97316',
  4: '#dc2626',
}

export function warningLevelColor(level: number): string {
  return WARNING_LEVEL_COLORS[Math.min(4, Math.max(1, Math.round(level)))]
}

/** Is data from `time` older than the source's limit at `now`? No time at all counts as stale. */
export function isStale(time: string | null | undefined, staleAfterSeconds: number, now: number): boolean {
  if (!time) return true
  const at = Date.parse(time)
  if (Number.isNaN(at)) return true
  return now - at > staleAfterSeconds * 1000
}

/** The backend already called it stale, or it has aged past the limit since. */
export function radarIsStale(radar: WeatherRadar, now: number): boolean {
  return radar.stale || isStale(radar.data_time, radar.stale_after_seconds, now)
}

/** The warnings still in force (or still to come) at `now`, highest level first. */
export function activeWarnings(layer: ApiWeatherLayer | null, now: number): WeatherWarning[] {
  const items = layer?.warnings?.items ?? []
  return items
    .filter((warning) => !warning.expires || Date.parse(warning.expires) > now)
    .sort((a, b) => b.level - a.level)
}

export function warningIsStale(layer: ApiWeatherLayer, warning: WeatherWarning, now: number): boolean {
  return isStale(warning.fetched_at, layer.warnings?.stale_after_seconds ?? 0, now)
}

/** The source's own text in the deployment's language – German, then anything, as fallbacks. */
export function warningText(warning: WeatherWarning, lang: string): WeatherWarningText {
  return (
    warning.texts[lang] ??
    warning.texts.de ??
    Object.values(warning.texts)[0] ?? { event: '', headline: '', description: '', instructions: [] }
  )
}

/** The newest frame index, or -1 without frames. */
export function latestFrameIndex(radar: WeatherRadar | null | undefined): number {
  return (radar?.frames.length ?? 0) - 1
}

/** Minutes between a frame and the newest one (0 for the newest itself). */
export function frameAgeMinutes(radar: WeatherRadar, index: number): number {
  const frames = radar.frames
  if (index < 0 || index >= frames.length) return 0
  return Math.round((Date.parse(frames[frames.length - 1].time) - Date.parse(frames[index].time)) / 60000)
}

/** «17:05», or «Fr 08:00» when the moment is not today (device-local, the deployment's locale). */
export function formatWeatherTime(iso: string, now: number, locale: string = formatLocale()): string {
  const date = new Date(iso)
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (new Date(now).toDateString() === date.toDateString()) return time
  const day = date.toLocaleDateString(locale, { weekday: 'short' }).replace(/\.$/, '')
  return `${day} ${time}`
}

/** A warning's link as the source gave it – some carry no scheme («www.meteoswiss.admin.ch»). */
export function warningHref(link: string): string {
  return /^https?:\/\//i.test(link) ? link : `https://${link}`
}

/**
 * Which radar frame is on screen, as a pure step (lib/useRadarPlayback holds it in state).
 * The pick is stored as the frame's KEY, not its position: every 5 minutes the hour shifts by one
 * (oldest out, newest in), and a stored index would silently slide to a frame five minutes later.
 * `null` = follow the newest; a picked frame that has aged out of the hour falls back to «now».
 */
export function pickedFrameIndex(radar: WeatherRadar | null | undefined, pickedKey: string | null): number {
  const latest = latestFrameIndex(radar)
  if (pickedKey === null || !radar) return latest
  const at = radar.frames.findIndex((f) => f.key === pickedKey)
  return at >= 0 ? at : latest
}
