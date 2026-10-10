// The Karte's weather LAYER for one Einsatz (components/WeatherLayer, backend app/weather_layer):
// the poll (lib/useWeatherLayer), the radar's playback (lib/useRadarPlayback) and the «Niederschlag
// (Radar)» row's device prefs, gathered for the three places that show it — the map (MapStage →
// MapView's radar source), the Karte's chip row and Ebenen (MapControls). Live data only: asked for
// on the Karte, never in the replay (whose past it is not). `on` false — WEATHER_LAYER_ENABLED=false,
// or no answer yet — offers nothing at all.

import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import type { WeatherLayerRow } from '../components/LayerPanel'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { useRadarPlayback } from '../lib/useRadarPlayback'
import { useWeatherLayer } from '../lib/useWeatherLayer'
import { activeWarnings, radarIsStale, WEATHER_RADAR_ROW_ID, type ApiWeatherLayer, type WeatherRadar } from '../lib/weatherLayer'
import type { LngLat } from '../types'

export interface KarteWeather {
  /** the backend serves the layer (and has answered) */
  on: boolean
  layer: ApiWeatherLayer | null
  /** the shared clock, ticking (lib/useWeatherLayer) */
  now: number
  /** any warning in force at the Einsatz — the chip has something to say */
  hasWarnings: boolean
  radar: WeatherRadar | null
  radarOn: boolean
  radarStale: boolean
  radarOpacity: number
  playback: ReturnType<typeof useRadarPlayback>
  /** the Ebenen row, absent while the layer is not served */
  row: WeatherLayerRow | undefined
  /** MapView's radar source while it is on, else null */
  mapRadar: { radar: WeatherRadar; frameIndex: number; opacity: number; stale: boolean } | null
  /** toggleLayer / setOpacity route this row by id, like the plan rasters (lib/georefTwins) */
  handlesLayer: (id: string) => boolean
  toggleRadar: () => void
  setRadarOpacity: (v: number) => void
}

export function useKarteWeather(center: LngLat, active: boolean): KarteWeather {
  const { data: layer, now } = useWeatherLayer(center, active)
  const on = layer?.enabled === true
  const radar = layer?.radar ?? null
  const playback = useRadarPlayback(radar)
  // a device pref like the plan rasters (lib/prefs), persisted beside them, off by default
  const [radarOn, setRadarOn] = useState(() => loadPrefs().weatherRadar === true)
  const [radarOpacity, setOpacityState] = useState(() => loadPrefs().weatherRadarOpacity ?? 75)
  const radarStale = !!radar && radarIsStale(radar, now)
  const toggleRadar = () => {
    const next = !radarOn
    setRadarOn(next)
    savePrefs({ ...loadPrefs(), weatherRadar: next })
    if (!next) playback.reset()
  }
  const setRadarOpacity = (v: number) => {
    setOpacityState(v)
    savePrefs({ ...loadPrefs(), weatherRadarOpacity: v })
  }
  const w = appConfig.copy.weatherLayer
  return {
    on,
    layer,
    now,
    hasWarnings: on && activeWarnings(layer, now).length > 0,
    radar,
    radarOn,
    radarStale,
    radarOpacity,
    playback,
    row: on ? {
      id: WEATHER_RADAR_ROW_ID, group: w.group, label: w.radar, sub: w.radarSub, icon: 'wx-rain',
      visible: radarOn, opacity: radarOpacity, attribution: w.attribution, legend: radar?.legend ?? [],
    } : undefined,
    mapRadar: active && on && radarOn && radar
      ? { radar, frameIndex: playback.frameIndex, opacity: radarOpacity, stale: radarStale } : null,
    handlesLayer: (id) => id === WEATHER_RADAR_ROW_ID,
    toggleRadar,
    setRadarOpacity,
  }
}
