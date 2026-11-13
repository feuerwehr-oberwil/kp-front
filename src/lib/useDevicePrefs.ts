import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { clampSymbolScale, loadPrefs, railLabelsFor, savePrefs, symbolScales, withDevicePrefsOf, withoutDevicePrefs, type Prefs, type RailLabels, type SymbolSurface } from './prefs'
import { PHONE_QUERY } from './useIsPhone'
import { appConfig } from '../config/appConfig'
import type { CaptionMode } from '../types'

/** fired on `window` when the Einstellungen change «Beschriftung» – `useRailLabels` listens */
const RAIL_LABELS_EVENT = 'kp:rail-labels'
/** fired on `window` when «Gerät auf Standard zurücksetzen» (or its undo) rewrote the device
 *  prefs – every holder of one re-reads the cookie (`onDevicePrefsReset`) */
const DEVICE_PREFS_EVENT = 'kp:device-prefs'

const isPhoneNow = () => typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches

/** Subscribe to a device-prefs reset; returns the unsubscribe. */
export function onDevicePrefsReset(cb: () => void): () => void {
  window.addEventListener(DEVICE_PREFS_EVENT, cb)
  return () => window.removeEventListener(DEVICE_PREFS_EVENT, cb)
}

function writeAndAnnounce(p: Prefs) {
  savePrefs(p)
  window.dispatchEvent(new Event(DEVICE_PREFS_EVENT))
  window.dispatchEvent(new Event(RAIL_LABELS_EVENT))
}

/** «Gerät auf Standard zurücksetzen» (13.11.2026, owner pick PLACE.7): clears this device's
 *  preferences (lib/prefs · DEVICE_PREF_KEYS) so each reads its default, tells every holder, and
 *  returns the undo that puts the previous ones back – the Einstellungen hand it to an undo toast. */
export function resetDevicePrefs(): () => void {
  const before = loadPrefs()
  writeAndAnnounce(withoutDevicePrefs(before))
  return () => writeAndAnnounce(withDevicePrefsOf(loadPrefs(), before))
}

/** Device-local display prefs shared by the incident workspace and the landing
 *  Einstellungen: tactical-symbol size (Karte / standalone Module; linked Module follow Karte),
 *  on-canvas captions (Aus/Auto/Alle), keep-screen-on and rail words. Each is
 *  seeded lazily from the prefs cookie (loadPrefs()) — NOT the boot-time snapshot — so a change
 *  made in the landing sheet survives opening an incident afterwards, and each is seeded again
 *  when the device prefs are reset (`resetDevicePrefs`). Persistence stays at each call site: the
 *  two differ (the workspace also saves `mode`/`activePlanId` in the same cookie), so a single
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
  const [keepScreenOn, setKeepScreenOn] = useState<boolean>(() => loadPrefs().keepScreenOn ?? true)
  // a phone reads the words by default (29.09.2026, sweep T8 — prefs · railLabelsFor); the device
  // class is read once, like the rest of these seeds
  const [railLabels, setLabels] = useState<RailLabels>(() => railLabelsFor(loadPrefs(), isPhoneNow()))
  /** a hand choice in the Einstellungen: marked as one, so the phone default never overrides it */
  const setRailLabels = useCallback((v: RailLabels) => {
    savePrefs({ ...loadPrefs(), railLabels: v, railLabelsChosen: true })
    setLabels(v)
    window.dispatchEvent(new Event(RAIL_LABELS_EVENT))
  }, [])
  // a reset (or its undo) rewrote the cookie: every value here is read from it again
  useEffect(() => onDevicePrefsReset(() => {
    const p = loadPrefs()
    setScale(symbolScales(p))
    setSymbolCaptions(p.symbolCaptions ?? appConfig.symbols.captionDefault as CaptionMode)
    setKeepScreenOn(p.keepScreenOn ?? true)
    setLabels(railLabelsFor(p, isPhoneNow()))
  }), [])
  return {
    symbolScale, setSymbolScale,
    symbolCaptions, setSymbolCaptions,
    keepScreenOn, setKeepScreenOn,
    railLabels, setRailLabels,
  }
}

const onRailLabels = (cb: () => void) => {
  window.addEventListener(RAIL_LABELS_EVENT, cb)
  return () => window.removeEventListener(RAIL_LABELS_EVENT, cb)
}

/** «Beschriftung» as a surface that does not own the Einstellungen reads it – the Karte's rail
 *  (components/karte), under the home's own settings sheet (App · LandingSettings). Live: a change
 *  made there shows on the rail at once, without a remount. */
export function useRailLabels(phone: boolean): RailLabels {
  return useSyncExternalStore(onRailLabels, () => railLabelsFor(loadPrefs(), phone))
}
