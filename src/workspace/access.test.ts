import { describe, expect, it } from 'vitest'
import type { AuthUser } from '../lib/auth'
import type { IncidentMeta } from '../lib/incidents'
import { workspaceFlags, type FlagInputs } from './access'

const user = (role: AuthUser['role'], extra: Partial<AuthUser> = {}): AuthUser =>
  ({ id: 'u', username: 'u', display_name: 'U', role, color: null, last_login: null, ...extra })
const meta = (over: Partial<IncidentMeta> = {}) => ({ id: 'i1', status: 'offen', is_archived: false, ...over }) as IncidentMeta
const flags = (over: Partial<FlagInputs>) => workspaceFlags({
  user: user('editor'), asLink: false, isEl: false, isEditor: true, roleReadOnly: false,
  forceReadOnly: false, tabLockLost: false, replayActive: false, incidentMeta: meta(), ...over,
})

// The flags moved out of IncidentWorkspace unchanged (E1); these pin the rules their comments
// state, so a later edit to one flag cannot quietly move another.
describe('workspaceFlags', () => {
  it('an editor on a running Einsatz may write everything', () => {
    expect(flags({})).toMatchObject({
      running: true, readOnly: false, canEditIncident: true, canEditTrupps: true, canEditRecord: true,
      canEditRapport: true, canEditMeta: true, canWriteRecord: true, tacticalLocked: false,
    })
  })
  it('the Führungsansicht locks the picture but keeps the record', () => {
    expect(flags({ user: user('editor', { el_view_default: true }) })).toMatchObject({
      canEditIncident: false, tacticalLocked: true, canEditRecord: true, canWriteRecord: true,
    })
  })
  it('the el role keeps the record and the Einsatzdaten, never the picture', () => {
    expect(flags({ user: user('el'), isEditor: false, isEl: true })).toMatchObject({
      canEditIncident: false, canEditTrupps: false, canEditRecord: true, canEditMeta: true, tacticalLocked: true,
    })
  })
  it('the Atemschutz-Link writes the Tafel and nothing else', () => {
    expect(flags({ user: user('viewer'), isEditor: false, asLink: true })).toMatchObject({
      readOnly: false, canEditIncident: false, canEditTrupps: true, canEditRecord: false, canWriteRecord: false,
    })
  })
  it('a closed Einsatz is read-only but its Rapport still takes corrections', () => {
    const f = flags({ incidentMeta: meta({ is_archived: true }) })
    expect(f).toMatchObject({ running: false, readOnly: true, canEditIncident: false, canEditRecord: false, canEditRapport: true })
    // …and its outboxes still deliver what was queued before the close
    expect(f.outboxReadOnly).toBe(false)
  })
  it('a replay locks everything, the outboxes included', () => {
    expect(flags({ replayActive: true })).toMatchObject({ readOnly: true, outboxReadOnly: true, canEditRapport: false, tacticalLocked: true })
  })
})
