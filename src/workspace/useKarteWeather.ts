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

/** Where the «Niederschlag (Radar)» row keeps its on/off and transparency. The Einsatz's Karte
 *  uses `einsatzRadarStore`; «Karte & Objekte» hands in a store of its own, so switching the radar
 *  on there changes no Einsatz (lib/karte/session). */
export interface RadarPrefStore {
  load: () => { on: boolean; opacity: number | undefined }
  save: (patch: { on?: boolean; opacity?: number }) => void
}

/** The Einsatz's store, in the device prefs (lib/prefs). The on/off belongs to ONE Einsatz (owner,
 *  22.10.2026: a radar switched on in an earlier Einsatz opened every later one with its playback
 *  bar): the pref names the Einsatz it was switched on in, so a new Einsatz starts without it and a
 *  reload of the same one keeps it. The transparency stays the device's. */
export const einsatzRadarStore = (incidentId: string): RadarPrefStore => ({
  load: () => { const p = loadPrefs(); return { on: p.weatherRadarIn === incidentId, opacity: p.weatherRadarOpacity } },
  save: (patch) => savePrefs({
    ...loadPrefs(),
    ...(patch.on != null ? { weatherRadarIn: patch.on ? incidentId : undefined } : {}),
    ...(patch.opacity != null ? { weatherRadarOpacity: patch.opacity } : {}),
  }),
})

export function useKarteWeather(active: boolean, store: RadarPrefStore): KarteWeather {
  const { data: layer, now } = useWeatherLayer(active)
  const on = layer?.enabled === true
  const radar = layer?.radar ?? null
  const playback = useRadarPlayback(radar)
  // off by default; where it is remembered is the store's business
  const [radarOn, setRadarOn] = useState(() => store.load().on)
  const [radarOpacity, setOpacityState] = useState(() => store.load().opacity ?? 75)
  const radarStale = !!radar && radarIsStale(radar, now)
  const setRadar = (next: boolean) => {
    if (next === radarOn) return
    setRadarOn(next)
    store.save({ on: next })
    if (!next) playback.reset()
  }
  const setRadarOpacity = (v: number) => {
    setOpacityState(v)
    store.save({ opacity: v })
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
