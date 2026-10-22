// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({ apiGet: vi.fn(async () => ({ key: null, enabled: false })), apiPost: vi.fn() }))
import { apiGet } from './api'
import { ensurePushSubscription } from './push'

// A page whose own link session answers is refused the push routes – asking was a 403 on
// every Trupp-Formular of the Atemschutz-Link (RBAC audit §3, 22.10.2026).
describe('ensurePushSubscription', () => {
  afterEach(() => { vi.unstubAllGlobals(); history.replaceState(null, '', '/'); vi.clearAllMocks() })

  it('asks nothing from an Atemschutz-Link page, and asks from the app', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.stubGlobal('PushManager', function PushManager() {})
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: new Promise(() => {}) } })
    history.replaceState(null, '', '/l/aSECRET-secret-secret') // an Atemschutz-Link
    expect(await ensurePushSubscription(true)).toBe(false)
    expect(apiGet).not.toHaveBeenCalled()

    history.replaceState(null, '', '/')
    await ensurePushSubscription(true)
    expect(apiGet).toHaveBeenCalledWith('/api/push/vapid-key')
  })
})
