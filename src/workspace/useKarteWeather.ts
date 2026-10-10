// The Karte's weather LAYER (components/WeatherLayer, backend app/weather_layer): the poll
// (lib/useWeatherLayer), the radar's playback (lib/useRadarPlayback) and the «Niederschlag (Radar)»
// row's device prefs, gathered for the three places that show it — the map (MapStage → MapView's
// radar source), the Karte's chip row and Ebenen (MapControls). Live data only: asked for on the
// Karte, never in the replay (whose past it is not). `on` false — WEATHER_LAYER_ENABLED=false, or
// no answer yet — offers nothing at all.
//
// The quick-taps reach it too (10.10.2026, owner: «Standard» must not show the radar): «Standard»
// and «Alle aus» switch it off (IncidentWorkspace · resetLayers / setAllLayers → `setRadar`), and
// while it is on lib/layerPreset reads «Eigene Auswahl» — the panel never lights «Standard» over a
// map with the radar on it. «Alle ein» leaves it alone, like the plan rasters: the radar is
// something you look at on purpose, not one more overlay.

import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import type { WeatherLayerRow } from '../components/LayerPanel'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { useRadarPlayback } from '../lib/useRadarPlayback'
import { useWeatherLayer } from '../lib/useWeatherLayer'
import { radarIsStale, WEATHER_RADAR_ROW_ID, type ApiWeatherLayer, type WeatherRadar } from '../lib/weatherLayer'

export interface KarteWeather {
  /** the backend serves the layer (and has answered) */
  on: boolean
  layer: ApiWeatherLayer | null
  /** the shared clock, ticking (lib/useWeatherLayer) */
  now: number
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
  /** the Ebenen quick-taps «Standard» / «Alle aus» switch it off */
  setRadar: (on: boolean) => void
  setRadarOpacity: (v: number) => void
}

export function useKarteWeather(active: boolean): KarteWeather {
  const { data: layer, now } = useWeatherLayer(active)
  const on = layer?.enabled === true
  const radar = layer?.radar ?? null
  const playback = useRadarPlayback(radar)
  // a device pref like the plan rasters (lib/prefs), persisted beside them, off by default
  const [radarOn, setRadarOn] = useState(() => loadPrefs().weatherRadar === true)
  const [radarOpacity, setOpacityState] = useState(() => loadPrefs().weatherRadarOpacity ?? 75)
  const radarStale = !!radar && radarIsStale(radar, now)
  const setRadar = (next: boolean) => {
    if (next === radarOn) return
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
    toggleRadar: () => setRadar(!radarOn),
    setRadar,
    setRadarOpacity,
  }
}
