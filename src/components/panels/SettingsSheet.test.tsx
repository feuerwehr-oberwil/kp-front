// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { useReportOfflineState, type DevicePartState } from './deviceState'
import { appConfig } from '../../config/appConfig'

// «Einstellungen» (M9, owner pick A; round 2b): one scroll – «Bedienung» first, the reset after
// the prefs it resets, «Dieses Gerät» folded to one summary row, the utilities last – and an
// offline door, or a part that needs the operator, opens the fold.

vi.mock('../../lib/auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/auth')>()
  const value = { user: null, loading: false, probeUnreachable: false, sessionExpired: false, login: () => Promise.resolve(), logout: () => Promise.resolve() }
  return { ...mod, useAuth: () => value }
})

// the Alarm part's facts: green, or (per test) red – the device's real ones are jsdom's
const alarm = { state: 'ok' as 'ok' | 'red' }
vi.mock('../karte/AlarmReadiness', async (importOriginal) => ({
  ...await importOriginal<typeof import('../karte/AlarmReadiness')>(), AlarmReadinessRows: () => null,
}))
vi.mock('../karte/useAlarmReadiness', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../karte/useAlarmReadiness')>()
  return {
    ...mod,
    useAlarmReadiness: () => ({
      rows: [{ key: 'installed', state: 'ok' }, { key: 'permission', state: alarm.state }],
      available: true, store: { optedOut: false }, linkSession: false,
    }),
  }
})

const { HomeDeviceSheet } = await import('./SettingsSheet')
const cp = appConfig.copy.settings

afterEach(() => { cleanup(); document.cookie = 'kp-front-prefs=; max-age=0; path=/'; vi.restoreAllMocks() })

const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

/** a stand-in for the Offline block: it reports its state as the real ones do */
function Block({ state }: { state: DevicePartState }) {
  useReportOfflineState(state)
  return <p>OFFLINE-BLOCK</p>
}
const section = () => document.querySelector('[data-device-section]')!.getAttribute('data-device-section')

describe('Einstellungen', () => {
  it('reads Bedienung → reset → Dieses Gerät (with the offline block) → Vorlagen', () => {
    render(<HomeDeviceSheet onClose={() => {}} readiness={<Block state="ok" />} />)
    expect(screen.getByRole('dialog', { name: cp.sheetTitle })).toBeTruthy()
    const order = [
      screen.getByRole('heading', { name: cp.handGroup }),
      screen.getByText(cp.colorScheme),
      screen.getByText(cp.resetDevice),
      screen.getByText(cp.deviceGroup),
      screen.getByText('OFFLINE-BLOCK'),
      screen.getByRole('heading', { name: cp.utilityGroup }),
    ]
    order.slice(1).forEach((el, i) => expect(follows(order[i], el)).toBe(true))
  })

  it('folds «Dieses Gerät» to its summary while all is green, and a tap opens it', () => {
    render(<HomeDeviceSheet onClose={() => {}} readiness={<Block state="ok" />} />)
    expect(section()).toBe('folded')
    expect(screen.getByText('OFFLINE-BLOCK').closest('[hidden]')).not.toBeNull()
    expect([...document.querySelectorAll('.set-sum-ok')].map((e) => e.textContent)).toEqual([cp.deviceSumAlarm, cp.deviceSumOffline, cp.deviceSumApp])
    fireEvent.click(screen.getByText(cp.deviceGroup))
    expect(section()).toBe('open')
  })

  it('opens by itself when nothing is offline yet or the alarm is not set up, and scrolled to the block from an offline door', () => {
    render(<HomeDeviceSheet onClose={() => {}} readiness={<Block state="red" />} />)
    expect(section()).toBe('open')
    cleanup()
    alarm.state = 'red'
    render(<HomeDeviceSheet onClose={() => {}} readiness={<Block state="ok" />} />)
    expect(section()).toBe('open')
    expect(document.querySelector('.set-sum-red')?.textContent).toBe(cp.deviceSumAlarm)
    alarm.state = 'ok'
    cleanup()
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    render(<HomeDeviceSheet onClose={() => {}} readiness={<Block state="ok" />} focus="offline" />)
    expect(section()).toBe('open')
    expect(scroll).toHaveBeenCalledOnce()
    expect(scroll.mock.contexts[0]).toBe(screen.getByText('OFFLINE-BLOCK').closest('[data-device-part="offline"]'))
  })
})
