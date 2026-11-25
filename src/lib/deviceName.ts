import { useSyncExternalStore } from 'react'
import { loadPrefs, savePrefs } from './prefs'

/*
 * «Name dieses Geräts» – «Tablet 2» (owner pick UX journeys B3·47, 25.11.2026: no Verlauf row said
 * who or which tablet wrote it, so a handover could not be traced). A DEVICE pref in the prefs
 * cookie: set once in the Einstellungen, or at the first login on the device (DeviceNameAsk).
 * The journal store stamps it on every row this device writes (journalStore · append, `device`);
 * the row's detail line and the printed Einsatzjournal show it. Rows written before 25.11.2026,
 * or on a device without a name, have none – never guessed.
 */

/** the longest name kept – a label, not a description («Tablet 2», «KP-Laptop Süd») */
export const DEVICE_NAME_MAX = 32

const EVENT = 'kp:device-name'

/** This device's name, trimmed – undefined while none is set. */
export function deviceName(): string | undefined {
  const n = loadPrefs().deviceName?.trim()
  return n ? n.slice(0, DEVICE_NAME_MAX) : undefined
}

/** Set (or with '' clear) this device's name; also answers the first-login ask. */
export function setDeviceName(name: string): void {
  const n = name.trim().slice(0, DEVICE_NAME_MAX)
  savePrefs({ ...loadPrefs(), deviceName: n || undefined, deviceNameAsked: true })
  window.dispatchEvent(new Event(EVENT))
}

/** «Später» at the first-login ask: no name, and no second ask (the Einstellungen still set one). */
export function skipDeviceNameAsk(): void {
  savePrefs({ ...loadPrefs(), deviceNameAsked: true })
  window.dispatchEvent(new Event(EVENT))
}

/** Should the first-login ask show? Only while it was never answered and no name is set. */
export function deviceNameAskOpen(): boolean {
  const p = loadPrefs()
  return !p.deviceNameAsked && !p.deviceName?.trim()
}

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}

/** The name and whether the ask is open, live across every holder on this page. */
export function useDeviceName(): { name: string | undefined; askOpen: boolean } {
  const name = useSyncExternalStore(subscribe, () => deviceName() ?? '')
  const askOpen = useSyncExternalStore(subscribe, deviceNameAskOpen)
  return { name: name || undefined, askOpen }
}
