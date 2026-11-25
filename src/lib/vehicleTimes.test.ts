import { describe, expect, it } from 'vitest'
import { gpsDeviceOf, vehicleTimeRows } from './vehicleTimes'

const fleet = [{ id: 'tlf', label: 'TLF' }, { id: 'fwo-mowa-1', label: 'MoWa' }]
const at = (hm: string) => `2026-11-25T${hm}:00`

// owner, batch-3 round #5 (25.11.2026): «Which vehicles are vor Ort?» – in the vehicle's sheet
describe('vehicleTimeRows', () => {
  const times = [
    { id: 'tlf', ausgerueckt: at('13:40'), vorOrt: at('13:48'), gps: { zone: 'scene' as const, device: 7 } },
    { id: 'fwo-mowa-1', ausgerueckt: at('14:08') },
  ]
  it('reads the Rapport clocks of the vehicle the sheet shows – by GPS device or by name', () => {
    const tlf = [{ label: 'Ausgerückt', value: '13:40' }, { label: 'Vor Ort', value: '13:48' }]
    expect(vehicleTimeRows({ device: 7 }, fleet, times)).toEqual(tlf)
    expect(vehicleTimeRows({ name: 'tlf ' }, fleet, times)).toEqual(tlf)
  })
  it('says a vehicle on its way is not there yet', () => {
    expect(vehicleTimeRows({ name: 'MoWa' }, fleet, times)).toEqual([{ label: 'Ausgerückt', value: '14:08' }, { label: 'Vor Ort', value: 'noch nicht' }])
  })
  it('adds nothing for a vehicle without clocks or one the fleet does not know', () => {
    expect(vehicleTimeRows({ name: 'HLF' }, fleet, times)).toEqual([])
    expect(vehicleTimeRows({ name: 'TLF' }, fleet, undefined)).toEqual([])
  })
})

describe('gpsDeviceOf', () => {
  it('reads the Traccar device off a GPS entity id', () => {
    expect(gpsDeviceOf('gps-7')).toBe(7)
    expect(gpsDeviceOf('p_abc')).toBeUndefined()
  })
})
