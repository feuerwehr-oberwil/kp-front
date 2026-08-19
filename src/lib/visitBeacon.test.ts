import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const isDemoMode = vi.fn(() => true)
vi.mock('./deploymentConfig', () => ({ isDemoMode: () => isDemoMode() }))

import { countSurface } from './visitBeacon'

const sendBeacon = vi.fn(() => true)

const sent = async () => {
  const [url, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob]
  return { url, body: JSON.parse(await blob.text()) as Record<string, string>, type: blob.type }
}

describe('countSurface', () => {
  beforeEach(() => {
    sendBeacon.mockClear()
    isDemoMode.mockReturnValue(true)
    vi.stubGlobal('navigator', { sendBeacon })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends the surface name as a text/plain beacon', async () => {
    countSurface('atemschutz')
    expect(sendBeacon).toHaveBeenCalledTimes(1)
    const { url, body, type } = await sent()
    expect(url).toBe('/api/hit')
    expect(body).toEqual({ kind: 'feature', key: 'atemschutz' })
    // text/plain keeps it a CORS *simple* request — no preflight, nothing to negotiate
    expect(type).toBe('text/plain')
  })

  it('translates the rail surface names the backend does not share', async () => {
    countSurface('map')
    expect((await sent()).body.key).toBe('lage')
  })

  // The guard that matters: a real station must never send this.
  it('does nothing off the demo', () => {
    isDemoMode.mockReturnValue(false)
    countSurface('rapport')
    expect(sendBeacon).not.toHaveBeenCalled()
  })

  it('does nothing in a link session', () => {
    countSurface('rapport', { linkScoped: true })
    expect(sendBeacon).not.toHaveBeenCalled()
  })

  it('does nothing where sendBeacon is missing', () => {
    vi.stubGlobal('navigator', {})
    expect(() => countSurface('mittel')).not.toThrow()
  })
})
