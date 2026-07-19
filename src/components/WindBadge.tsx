import type { WeatherData } from '../types'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import styles from './WindBadge.module.css'

interface Props {
  /** the reading to show — live `/api/weather` while live, the folded reading while replaying */
  weather: WeatherData | null
  /** open the MeteoSwiss details for the incident location in a new tab */
  onOpenDetails?: () => void
  /** lift clear of the bottom-centre replay scrubber so the two never overlap */
  lifted?: boolean
}

const cardinalIndex = (deg: number) => Math.round((((deg % 360) + 360) % 360) / 45) % 8

/** German cardinal for a FROM bearing, e.g. 225° → "aus SW". */
export function fromLabel(deg: number): string {
  const w = appConfig.copy.weather
  return `${w.from} ${w.cardinals[cardinalIndex(deg)]}`
}

/** Spelled-out German cardinal for a FROM bearing, e.g. 225° → "aus Südwest". */
export function fromLabelLong(deg: number): string {
  const w = appConfig.copy.weather
  return `${w.from} ${w.cardinalsLong[cardinalIndex(deg)]}`
}

/** CSS rotation (deg) for the wind arrow. The arrow's SVG points DOWN at rest (bearing
 *  180°), and we want it pointing where the wind blows TOWARD = the FROM bearing + 180.
 *  toward − 180 = dir, so rotating by `dir` aims the arrow downwind. */
export function windArrowRotation(dir: number): number {
  return dir
}

/** WMO present-weather code → a single condition icon + localized label. */
export function condition(code: number | null): { icon: string; label: string } | null {
  if (code == null) return null
  const c = appConfig.copy.weather.conditions
  if (code === 0) return { icon: 'sun', label: c.clear }
  if (code === 1) return { icon: 'wx-partly', label: c.fair }
  if (code === 2) return { icon: 'wx-partly', label: c.partly }
  if (code === 3) return { icon: 'wx-cloud', label: c.overcast }
  if (code === 45 || code === 48) return { icon: 'wx-fog', label: c.fog }
  if (code >= 51 && code <= 57) return { icon: 'wx-rain', label: c.drizzle }
  if (code >= 61 && code <= 67) return { icon: 'wx-rain', label: c.rain }
  if (code >= 71 && code <= 77) return { icon: 'wx-snow', label: c.snow }
  if (code >= 80 && code <= 82) return { icon: 'wx-rain', label: c.rainShowers }
  if (code === 85 || code === 86) return { icon: 'wx-snow', label: c.snowShowers }
  if (code >= 95) return { icon: 'wx-storm', label: c.thunder }
  return { icon: 'wx-cloud', label: c.cloudy }
}

/**
 * Corner weather badge: a single condition glyph (clear/cloud/rain/snow/fog/storm),
 * the temperature, and an arrow pointing DOWNWIND (where smoke drifts) with the mean
 * wind + gust and a German cardinal. `wind_dir_deg` is the meteorological FROM bearing;
 * see windArrowRotation for how the arrow is aimed downwind. Tapping opens the MeteoSwiss details. Presentational:
 * the reading is supplied by the parent (live poll, or the replay fold). Renders nothing
 * without a usable wind direction.
 */
export function WindBadge({ weather, onOpenDetails, lifted }: Props) {
  if (!weather || weather.wind_dir_deg == null) return null

  const dir = weather.wind_dir_deg
  const speed = weather.wind_speed_kmh
  const gust = weather.wind_gust_kmh
  const temp = weather.temp_c
  const cond = condition(weather.weather_code)
  const downwind = windArrowRotation(dir) // arrow points where the wind/smoke is going (downwind)
  const w = appConfig.copy.weather

  const title = `${cond ? `${cond.label} · ` : ''}${fillTemplate(w.windTitle, { dir: fromLabel(dir), deg: Math.round(dir) })}${onOpenDetails ? w.meteoHint : ''}`

  return (
    <button type="button" className={`${styles.badge}${lifted ? ` ${styles.lifted}` : ''}`} title={title} onClick={onOpenDetails} disabled={!onOpenDetails}>
      {cond && <span className={styles.cond} aria-label={cond.label}><Icon id={cond.icon} /></span>}
      {temp != null && <span className={styles.temp}>{Math.round(temp)}°C</span>}
      <span className={styles.arrow} style={{ transform: `rotate(${downwind}deg)` }} aria-hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 L12 21" />
          <path d="M6 15 L12 21 L18 15" />
        </svg>
      </span>
      <span className={styles.text}>
        <span className={styles.speed}>
          {speed != null ? `${Math.round(speed)} km/h` : '–'}
        </span>
        {gust != null && <span className={styles.gust}>{w.gust} {Math.round(gust)} km/h</span>}
        <span className={styles.dir}>{fromLabel(dir)}</span>
      </span>
    </button>
  )
}
