import { describe, expect, it } from 'vitest'
import { TERMINAL_PATH, linkKindFromToken, linkPageOwnsSession, linkSessionHeaders, linkTokenFromPath, onLinkPage } from './linkMode'

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJpbmMiOiJhYmMifQ.sig-part_1' // an alarm link (a JWT)
const ATEMSCHUTZ = 'aSECRET-secret-secret'
const VIEW = 'vSECRET-secret-secret'
const TERMINAL = 'tSECRET-secret-secret'
const STANDING_AS = 'sSECRET-secret-secret'

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
  it('tells the five kinds apart by the marker in front of the secret', () => {
    expect(linkKindFromToken(ATEMSCHUTZ)).toBe('atemschutz')
    expect(linkKindFromToken(VIEW)).toBe('view')
    expect(linkKindFromToken(TERMINAL)).toBe('terminal')
    expect(linkKindFromToken(STANDING_AS)).toBe('atemschutz-standing')
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

  it('claims the session on the standing surfaces — the enrolled terminal IS the terminal, and the laminated board IS the board', () => {
    for (const path of [TERMINAL_PATH, `/l/${TERMINAL}`, `/l/${STANDING_AS}`]) {
      expect(linkSessionHeaders(path)).toEqual({ 'X-Incident-Link': 'use' })
      expect(linkPageOwnsSession(path)).toBe(true)
    }
  })
})

/* ⚠️ A different question from `linkPageOwnsSession`, which asks whose session answers a request.
 * This one asks whether the page may write STATION data — the calibrations and georeferences every
 * incident and device shares. A link is handed to somebody for one job, and none of those jobs is
 * «reshape the station's plans». */
describe('onLinkPage', () => {
  it('is true for EVERY handed-over link, not only the one that owns the session', () => {
    expect(onLinkPage(`/l/${ATEMSCHUTZ}`)).toBe(true)
    // …the one that matters: a view link on a device signed in as an editor would be ALLOWED to
    // write by the server, so only the client can decline it
    expect(onLinkPage(`/l/${VIEW}`)).toBe(true)
    expect(onLinkPage(`/l/${TOKEN}`)).toBe(true)
  })

  it('is false for the ordinary app', () => {
    expect(onLinkPage('/')).toBe(false)
    expect(onLinkPage('/einsatz/abc')).toBe(false)
    expect(onLinkPage(`/e/${TOKEN}`)).toBe(false) // the capture poster is not a link session
  })
})
