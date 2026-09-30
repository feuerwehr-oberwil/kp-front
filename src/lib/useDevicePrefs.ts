import { useCallback, useState } from 'react'
import { clampSymbolScale, loadPrefs, railLabelsFor, savePrefs, symbolScales, type RailLabels, type SymbolSurface } from './prefs'
import { PHONE_QUERY } from './useIsPhone'
import { appConfig } from '../config/appConfig'
import type { CaptionMode } from '../types'

/** Device-local display prefs shared by the incident workspace and the landing
 *  Einstellungen: tactical-symbol size (Karte / standalone Module; linked Module follow Karte),
 *  on-canvas captions (Aus/Auto/Alle), offline cache radius, and keep-screen-on. Each is seeded lazily from the prefs cookie
 *  (loadPrefs()) — NOT the boot-time snapshot — so a change made in the landing sheet
 *  survives opening an incident afterwards. Persistence stays at each call site: the two
 *  differ (the workspace also saves `mode`/`activePlanId` in the same cookie), so a single
 *  shared effect would change behaviour — each caller keeps its own savePrefs effect. */
export function useDevicePrefs() {
  // One multiplier per setting, seeded through symbolScales so a cookie that still carries the
  // legacy S/M/L pref migrates on read (lazily — the cookie itself is left alone). Which one a
  // plan uses is resolved from its georeference by prefs · planSymbolScale.
  const [symbolScale, setScale] = useState<Record<SymbolSurface, number>>(() => symbolScales(loadPrefs()))
  /** Set one surface's symbol multiplier; the value is snapped into that surface's band. */
  const setSymbolScale = useCallback((surface: SymbolSurface, v: number) => {
    setScale((s) => ({ ...s, [surface]: clampSymbolScale(surface, v) }))
  }, [])
  const [symbolCaptions, setSymbolCaptions] = useState<CaptionMode>(() => loadPrefs().symbolCaptions ?? appConfig.symbols.captionDefault as CaptionMode)
  const [offlineRadiusM, setOfflineRadiusM] = useState<number>(() => loadPrefs().offlineRadiusM ?? 1200)
  const [offlineAuto, setOfflineAuto] = useState<boolean>(() => loadPrefs().offlineAuto ?? true)
  const [keepScreenOn, setKeepScreenOn] = useState<boolean>(() => loadPrefs().keepScreenOn ?? true)
  // a phone reads the words by default (29.09.2026, sweep T8 — prefs · railLabelsFor); the device
  // class is read once, like the rest of these seeds
  const [railLabels, setLabels] = useState<RailLabels>(() => railLabelsFor(loadPrefs(),
    typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches))
  /** a hand choice in the Einstellungen: marked as one, so the phone default never overrides it */
  const setRailLabels = useCallback((v: RailLabels) => {
    savePrefs({ ...loadPrefs(), railLabels: v, railLabelsChosen: true })
    setLabels(v)
  }, [])
  return {
    symbolScale, setSymbolScale,
    symbolCaptions, setSymbolCaptions,
    offlineRadiusM, setOfflineRadiusM,
    offlineAuto, setOfflineAuto,
    keepScreenOn, setKeepScreenOn,
    railLabels, setRailLabels,
  }
}
