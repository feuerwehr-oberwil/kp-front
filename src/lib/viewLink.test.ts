import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createShareLink, fetchShareLink, revokeShareLink, viewLinkUrl } from './viewLink'

const apiGet = vi.fn()
const apiPost = vi.fn()
const apiDelete = vi.fn()
vi.mock('./api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiDelete: (...a: unknown[]) => apiDelete(...a),
}))

describe('viewLinkUrl', () => {
  it('composes the address from the browser’s own origin', () => {
    expect(viewLinkUrl({ enabled: true, token: 'vAbC123' }, 'https://front.fwo.li'))
      .toBe('https://front.fwo.li/l/vAbC123')
  })

  // the «noch keiner» state is rendered off `enabled` — a half-built URL must never be offered
  it('is empty while there is no link', () => {
    expect(viewLinkUrl({ enabled: false, token: null }, 'https://front.fwo.li')).toBe('')
  })
})

// The kind picks the endpoint and nothing else — same verbs, same shape. Worth pinning because
// the two links mean very different things (read-only forever vs. operate until the Einsatz
// closes), and a swapped path would hand a Nachbarwehr a Tafel it can write on.
describe('the endpoint each kind talks to', () => {
  beforeEach(() => {
    apiGet.mockReset().mockResolvedValue({ enabled: false, token: null })
    apiPost.mockReset().mockResolvedValue({ enabled: true, token: 't' })
    apiDelete.mockReset().mockResolvedValue({ enabled: false, token: null })
  })

  it('reads, mints and revokes the view link on /view-link', async () => {
    await fetchShareLink('i1', 'view')
    await createShareLink('i1', 'view')
    await revokeShareLink('i1', 'view')
    expect(apiGet).toHaveBeenCalledWith('/api/incidents/i1/view-link')
    expect(apiPost).toHaveBeenCalledWith('/api/incidents/i1/view-link', {})
    expect(apiDelete).toHaveBeenCalledWith('/api/incidents/i1/view-link')
  })

  it('reads, mints and revokes the Atemschutz link on /atemschutz-link', async () => {
    await fetchShareLink('i1', 'atemschutz')
    await createShareLink('i1', 'atemschutz')
    await revokeShareLink('i1', 'atemschutz')
    expect(apiGet).toHaveBeenCalledWith('/api/incidents/i1/atemschutz-link')
    expect(apiPost).toHaveBeenCalledWith('/api/incidents/i1/atemschutz-link', {})
    expect(apiDelete).toHaveBeenCalledWith('/api/incidents/i1/atemschutz-link')
  })
})
