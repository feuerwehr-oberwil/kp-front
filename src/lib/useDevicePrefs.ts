import { useState } from 'react'
import { loadPrefs, type SymbolSize } from './prefs'
import { appConfig } from '../config/appConfig'
import type { CaptionMode } from '../types'

/** Device-local display prefs shared by the incident workspace and the landing
 *  Einstellungen: tactical-symbol size (S/M/L), on-canvas captions (Aus/Auto/Alle),
 *  offline cache radius, and keep-screen-on. Each is seeded lazily from the prefs cookie
 *  (loadPrefs()) — NOT the boot-time snapshot — so a change made in the landing sheet
 *  survives opening an incident afterwards. Persistence stays at each call site: the two
 *  differ (the workspace also saves `mode`/`activePlanId` in the same cookie), so a single
 *  shared effect would change behaviour — each caller keeps its own savePrefs effect. */
export function useDevicePrefs() {
  const [symbolSize, setSymbolSize] = useState<SymbolSize>(() => loadPrefs().symbolSize ?? 'M')
  const [symbolCaptions, setSymbolCaptions] = useState<CaptionMode>(() => loadPrefs().symbolCaptions ?? appConfig.symbols.captionDefault as CaptionMode)
  const [offlineRadiusM, setOfflineRadiusM] = useState<number>(() => loadPrefs().offlineRadiusM ?? 1200)
  const [keepScreenOn, setKeepScreenOn] = useState<boolean>(() => loadPrefs().keepScreenOn ?? true)
  return {
    symbolSize, setSymbolSize,
    symbolCaptions, setSymbolCaptions,
    offlineRadiusM, setOfflineRadiusM,
    keepScreenOn, setKeepScreenOn,
  }
}
