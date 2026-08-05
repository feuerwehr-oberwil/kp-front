import { describe, expect, it } from 'vitest'
import { isIncidentRunning } from './api/incidents'

// «Is this Einsatz still running» decides whether the Einsatz-Link works, whether a phone may
// report its position, and whether «Standort teilen» is even offered. It has to agree with the
// backend's `Incident.is_open` exactly — a client that is stricter hides features the API would
// allow (which is how the whole feature read as missing in production), and one that is looser
// offers actions the API then refuses.

const meta = (over: Partial<{ is_archived: boolean; closed_at: string | null; status: string }> = {}) =>
  ({ is_archived: false, closed_at: null, status: 'offen', ...over })

describe('isIncidentRunning', () => {
  it('counts «offen» — what every intake writes', () => {
    expect(isIncidentRunning(meta())).toBe(true)
  })

  it('counts «in_arbeit» — an Einsatz somebody is WORKING is not over', () => {
    // The production bug, 2026-08-05: this returned false, so the compass row vanished on the
    // one Einsatz that was actually being run.
    expect(isIncidentRunning(meta({ status: 'in_arbeit' }))).toBe(true)
  })

  it('is over once archived, closed, or explicitly given a closed status', () => {
    expect(isIncidentRunning(meta({ is_archived: true }))).toBe(false)
    expect(isIncidentRunning(meta({ closed_at: '2026-08-05T12:00:00Z' }))).toBe(false)
    expect(isIncidentRunning(meta({ status: 'geschlossen' }))).toBe(false)
  })

  it('does not treat an unknown status as running', () => {
    // Fail closed: a status nobody here has heard of must not silently grant a live link.
    expect(isIncidentRunning(meta({ status: 'was-auch-immer' }))).toBe(false)
  })
})
