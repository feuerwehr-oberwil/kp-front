import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from './format'
import { isVehicleSym } from './symbols'
import type { FleetVehicle } from './deploymentConfig'
import type { FahrzeugZeit } from './workspace'
import type { PlakatSeed } from './plakat'
import type { Entity, WeatherData } from '../types'

/** «aus SW» for a FROM bearing — the TopBar's wording (TopBar · fromLabel), from the same copy */
const fromWord = (deg: number) => {
  const w = appConfig.copy.weather
  return `${w.from} ${w.cardinals[Math.round((((deg % 360) + 360) % 360) / 45) % 8]}`
}

export interface PlakatSeedSources {
  title: string
  address?: string | null
  alarmIso?: string | null
  einsatzleiter?: string | null
  weather?: WeatherData | null
  /** the Rapport's Fahrzeugzeiten — a vehicle with any time on it went out on this Einsatz */
  fahrzeuge?: readonly FahrzeugZeit[] | null
  fleet?: readonly FleetVehicle[] | null
  /** the Karte's objects — a placed vehicle (kind or Fahrzeug symbol) names a Formation */
  entities?: readonly Entity[]
}

/**
 * What the «Erstes Plakat» may know at the moment it is inserted — only what the app already
 * holds (08.10.2026): the Einsatz header, the alarm clock, the Einsatzleiter from the Rapport,
 * the wind as a suggestion, and the vehicles the Einsatz has seen. No new integrations.
 */
export function plakatSeedFrom(src: PlakatSeedSources): PlakatSeed {
  const at = src.alarmIso ? new Date(src.alarmIso) : null
  const w = src.weather
  const wind = w?.wind_dir_deg != null && w.wind_speed_kmh != null
    ? fillTemplate(appConfig.copy.tafel.plakat.wind, { dir: fromWord(w.wind_dir_deg), speed: Math.round(w.wind_speed_kmh) })
    : null
  const labels = new Map((src.fleet ?? []).map((v) => [v.id, v.label || v.id]))
  const out = (src.fahrzeuge ?? [])
    .filter((f) => f.ausgerueckt || f.vorOrt || f.zurueck)
    .map((f) => labels.get(f.id) ?? f.id)
  const placed = (src.entities ?? [])
    .filter((e) => e.kind === 'vehicle' || isVehicleSym(e))
    .map((e) => e.label ?? '')
  return {
    title: src.title,
    address: src.address,
    alarm: at && !Number.isNaN(at.getTime()) ? hhmm(at) : null,
    einsatzleiter: src.einsatzleiter,
    wind,
    vehicles: [...out, ...placed].filter(Boolean),
  }
}
