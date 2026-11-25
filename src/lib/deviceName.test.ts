// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { deviceName, deviceNameAskOpen, setDeviceName, skipDeviceNameAsk } from './deviceName'
import { loadPrefs, savePrefs, withoutDevicePrefs } from './prefs'

// owner pick UX journeys B3·47: a device names itself once – at the first login, or in the
// Einstellungen – and the reset of the display prefs leaves its name alone
describe('deviceName', () => {
  beforeEach(() => savePrefs({}))

  it('asks once: a name answers it, and so does «Später»', () => {
    expect(deviceNameAskOpen()).toBe(true)
    setDeviceName('  Tablet 2  ')
    expect(deviceName()).toBe('Tablet 2')
    expect(deviceNameAskOpen()).toBe(false)

    savePrefs({})
    skipDeviceNameAsk()
    expect(deviceName()).toBeUndefined()
    expect(deviceNameAskOpen()).toBe(false)
  })

  it('keeps a short label, and an empty one clears it', () => {
    setDeviceName('x'.repeat(50))
    expect(deviceName()).toHaveLength(32)
    setDeviceName('')
    expect(deviceName()).toBeUndefined()
  })

  it('is no display pref: «Gerät auf Standard zurücksetzen» keeps it', () => {
    setDeviceName('Tablet 2')
    expect(withoutDevicePrefs(loadPrefs()).deviceName).toBe('Tablet 2')
  })
})
