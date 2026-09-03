import { describe, expect, it } from 'vitest'
import { linkKindFromToken, linkPageOwnsSession, linkSessionHeaders, linkTokenFromPath } from './linkMode'

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJpbmMiOiJhYmMifQ.sig-part_1' // an alarm link (a JWT)
const ATEMSCHUTZ = 'aSECRET-secret-secret'
const VIEW = 'vSECRET-secret-secret'

describe('linkTokenFromPath', () => {
  it('reads the token out of /l/<token> (with and without a trailing slash)', () => {
    expect(linkTokenFromPath(`/l/${TOKEN}`)).toBe(TOKEN)
    expect(linkTokenFromPath(`/l/${TOKEN}/`)).toBe(TOKEN)
  })

  it('rejects anything that is not a link URL', () => {
    expect(linkTokenFromPath('/')).toBeNull()
    expect(linkTokenFromPath('/l/')).toBeNull()
    expect(linkTokenFromPath('/l/short')).toBeNull()      // too short to be a minted token
    expect(linkTokenFromPath(`/l/${TOKEN}/extra`)).toBeNull()
    expect(linkTokenFromPath(`/e/${TOKEN}`)).toBeNull()   // the capture poster, not a link
  })
})

describe('linkKindFromToken', () => {
  it('tells the three kinds apart by the marker in front of the secret', () => {
    expect(linkKindFromToken(ATEMSCHUTZ)).toBe('atemschutz')
    expect(linkKindFromToken(VIEW)).toBe('view')
    expect(linkKindFromToken(TOKEN)).toBe('alarm')
  })
})

// The isolation the header buys, stated as the three situations it has to answer — see
// lib/linkMode and backend/app/auth/incident_link.py · LINK_MODE_HEADER.
describe('which session a page asks with', () => {
  it('says «off» everywhere but on a link page, so no stale link cookie can answer for the app', () => {
    for (const path of ['/', '/admin', `/e/${TOKEN}`, '/l/short']) {
      expect(linkSessionHeaders(path)).toEqual({ 'X-Incident-Link': 'off' })
      expect(linkPageOwnsSession(path)).toBe(false)
    }
  })

  it('claims the session on the handed-over Atemschutz board, which may not borrow a login', () => {
    expect(linkSessionHeaders(`/l/${ATEMSCHUTZ}`)).toEqual({ 'X-Incident-Link': 'use' })
    expect(linkPageOwnsSession(`/l/${ATEMSCHUTZ}`)).toBe(true)
  })

  it('says nothing on an alarm or view link, where a signed-in member stays who they are', () => {
    expect(linkSessionHeaders(`/l/${TOKEN}`)).toEqual({})
    expect(linkSessionHeaders(`/l/${VIEW}`)).toEqual({})
    expect(linkPageOwnsSession(`/l/${VIEW}`)).toBe(false)
  })
})
