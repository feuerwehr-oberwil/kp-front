// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'

// Sweep 09.11.2026, UX.8: «Keine Alarme auf diesem Gerät» sits beside «Später» on the Karte
// home's card, and a slip turned alarm push off without a word. It answers with the house undo
// toast now, and «Rückgängig» switches push on again.

const { disablePush, enablePush } = vi.hoisted(() => ({
  // never answers, as in a browser with no service worker (navigator.serviceWorker.ready)
  disablePush: vi.fn(() => new Promise<void>(() => {})), enablePush: vi.fn(() => Promise.resolve(true)),
}))
vi.mock('../../lib/push', () => ({
  disablePush, enablePush,
  pushAvailable: () => Promise.resolve(true),
  ensurePushSubscription: vi.fn(), renewPushSubscription: vi.fn(), sendTestPush: vi.fn(),
}))
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../../lib/installPrompt', () => ({
  isStandalone: () => true, getInstallPlatform: () => 'ios', onInstallStateChange: () => () => {},
}))
vi.mock('../InstallGuide', () => ({ InstallGuide: () => null }))

const { AlarmNudgeCard } = await import('./AlarmReadiness')
const { Overlays } = await import('../../lib/ui')
const A = appConfig.copy.karte.device.alarm

beforeEach(() => { localStorage.clear(); disablePush.mockClear(); enablePush.mockClear() })
afterEach(cleanup)

describe('«Keine Alarme auf diesem Gerät» on the readiness card', () => {
  it('says what it did and takes it back on «Rückgängig»', async () => {
    render(<><AlarmNudgeCard inIncident={false} phone /><Overlays /></>)
    fireEvent.click(await screen.findByRole('button', { name: A.optOut }))

    expect(await screen.findByText(A.optOutDone)).toBeTruthy()
    expect(disablePush).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.undo }))
    await vi.waitFor(() => expect(enablePush).toHaveBeenCalledOnce())
  })
})

// owner pick UX journeys B3·6 (25.11.2026): the Karte head says whether alarms still arrive
describe('«Bereit für Alarme» in the Karte head', () => {
  it('shows nothing before a poll answered, green after a good one, red after a failed one', async () => {
    const { AlarmReadyPill } = await import('./AlarmReadiness')
    const { markAlarmPoll } = await import('../../lib/alarmPollHealth')
    const { container } = render(<AlarmReadyPill phone={false} />)
    expect(container.textContent).toBe('')
    act(() => markAlarmPoll(true))
    expect(screen.getByRole('button', { name: A.pillReady })).toBeTruthy()
    act(() => markAlarmPoll(false))
    expect(screen.getByRole('button', { name: A.pillDown })).toBeTruthy()
  })
})
