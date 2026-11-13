// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'

// «Dieses Gerät» (M9, owner pick A): one scroll – «Bereit?» with the caller's offline block on
// top, «Bedienung» under it, the reset after the prefs it resets, the utilities last – and an
// offline door opens it scrolled to the offline block.

vi.mock('../../lib/auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/auth')>()
  const value = { user: null, loading: false, probeUnreachable: false, sessionExpired: false, login: () => Promise.resolve(), logout: () => Promise.resolve() }
  return { ...mod, useAuth: () => value }
})

const { HomeDeviceSheet } = await import('./SettingsSheet')
const cp = appConfig.copy.settings

afterEach(() => { cleanup(); document.cookie = 'kp-front-prefs=; max-age=0; path=/'; vi.restoreAllMocks() })

const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('Dieses Gerät', () => {
  it('reads Bereit? (with the offline block) → Bedienung → reset → Vorlagen', () => {
    render(<HomeDeviceSheet onClose={() => {}} readiness={<p>OFFLINE-BLOCK</p>} />)
    expect(screen.getByRole('dialog', { name: cp.sheetTitle })).toBeTruthy()
    const order = [
      screen.getByRole('heading', { name: cp.readyGroup }),
      screen.getByText('OFFLINE-BLOCK'),
      screen.getByRole('heading', { name: cp.handGroup }),
      screen.getByText(cp.colorScheme),
      screen.getByText(cp.resetDevice),
      screen.getByRole('heading', { name: cp.utilityGroup }),
    ]
    order.slice(1).forEach((el, i) => expect(follows(order[i], el)).toBe(true))
  })

  it('opens scrolled to the offline block from an offline door, and at the top otherwise', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    render(<HomeDeviceSheet onClose={() => {}} readiness={<p>OFFLINE-BLOCK</p>} />)
    expect(scroll).not.toHaveBeenCalled()
    cleanup()
    render(<HomeDeviceSheet onClose={() => {}} readiness={<p>OFFLINE-BLOCK</p>} focus="offline" />)
    expect(scroll).toHaveBeenCalledOnce()
    expect(scroll.mock.contexts[0]).toBe(screen.getByText('OFFLINE-BLOCK').closest('[data-device-part="offline"]'))
  })
})
