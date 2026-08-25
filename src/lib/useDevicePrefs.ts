import { useCallback, useState } from 'react'
import { clampSymbolScale, loadPrefs, symbolScales, type RailLabels, type SymbolSurface } from './prefs'
import { appConfig } from '../config/appConfig'
import type { CaptionMode } from '../types'

/** Device-local display prefs shared by the incident workspace and the landing
 *  Einstellungen: tactical-symbol size (one multiplier per surface — Karte / Module),
 *  on-canvas captions (Aus/Auto/Alle), offline cache radius, and keep-screen-on. Each is seeded lazily from the prefs cookie
 *  (loadPrefs()) — NOT the boot-time snapshot — so a change made in the landing sheet
 *  survives opening an incident afterwards. Persistence stays at each call site: the two
 *  differ (the workspace also saves `mode`/`activePlanId` in the same cookie), so a single
 *  shared effect would change behaviour — each caller keeps its own savePrefs effect. */
export function useDevicePrefs() {
  // One multiplier per surface, seeded through symbolScales so a cookie that still carries the
  // legacy S/M/L pref migrates on read (lazily — the cookie itself is left alone).
  const [symbolScale, setScale] = useState<Record<SymbolSurface, number>>(() => symbolScales(loadPrefs()))
  /** Set one surface's symbol multiplier; the value is snapped into that surface's band. */
  const setSymbolScale = useCallback((surface: SymbolSurface, v: number) => {
    setScale((s) => ({ ...s, [surface]: clampSymbolScale(surface, v) }))
  }, [])
  const [symbolCaptions, setSymbolCaptions] = useState<CaptionMode>(() => loadPrefs().symbolCaptions ?? appConfig.symbols.captionDefault as CaptionMode)
  const [offlineRadiusM, setOfflineRadiusM] = useState<number>(() => loadPrefs().offlineRadiusM ?? 1200)
  const [keepScreenOn, setKeepScreenOn] = useState<boolean>(() => loadPrefs().keepScreenOn ?? true)
  const [railLabels, setRailLabels] = useState<RailLabels>(() => loadPrefs().railLabels ?? 'off')
  return {
    symbolScale, setSymbolScale,
    symbolCaptions, setSymbolCaptions,
    offlineRadiusM, setOfflineRadiusM,
    keepScreenOn, setKeepScreenOn,
    railLabels, setRailLabels,
  }
}
