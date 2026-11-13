import { describe, expect, it } from 'vitest'
import type { AuthUser } from '../lib/auth'
import type { IncidentMeta } from '../lib/incidents'
import { viewOnlyReason, workspaceFlags, type FlagInputs } from './access'

const user = (role: AuthUser['role'], extra: Partial<AuthUser> = {}): AuthUser =>
  ({ id: 'u', username: 'u', display_name: 'U', role, color: null, last_login: null, ...extra })
const meta = (over: Partial<IncidentMeta> = {}) => ({ id: 'i1', status: 'offen', is_archived: false, ...over }) as IncidentMeta
const flags = (over: Partial<FlagInputs>) => workspaceFlags({
  user: user('editor'), asLink: false, isEl: false, isEditor: true, roleReadOnly: false,
  forceReadOnly: false, tabLockLost: false, replayActive: false, incidentMeta: meta(), olderBuild: false, ...over,
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
  // owner, 12.11.2026: closed is closed for the Rapport too – only signing it is left
  it('a closed Einsatz is read-only, its Rapport too, and the Rapport can still be signed', () => {
    const f = flags({ incidentMeta: meta({ is_archived: true }) })
    expect(f).toMatchObject({ running: false, readOnly: true, canEditIncident: false, canEditRecord: false, canEditRapport: false, canSignRapport: true })
    expect(flags({}).canSignRapport).toBe(false)
    // …and its outboxes still deliver what was queued before the close
    expect(f.outboxReadOnly).toBe(false)
  })
  // RBAC audit S4c (22.10.2026): a machine seed of a non-record key only where the push carries it
  it('only an editor\'s session pushes the whole blob – the el and the Atemschutz-Link do not', () => {
    expect(flags({}).canWriteBlob).toBe(true)
    expect(flags({ user: user('editor', { el_view_default: true }) }).canWriteBlob).toBe(true)
    expect(flags({ user: user('el'), isEditor: false, isEl: true }).canWriteBlob).toBe(false)
    expect(flags({ user: user('viewer'), isEditor: false, asLink: true }).canWriteBlob).toBe(false)
    expect(flags({ tabLockLost: true }).canWriteBlob).toBe(false)
  })
  // sweep 30.10.2026 #19: an older build would save a newer build's blob without what it skipped
  it('data from a newer build locks every write of the blob – the Tafel and a closed Rapport too – but the outboxes deliver', () => {
    expect(flags({ olderBuild: true })).toMatchObject({ readOnly: true, outboxReadOnly: false, canEditIncident: false, canEditRecord: false, canWriteBlob: false })
    expect(flags({ user: user('viewer'), isEditor: false, asLink: true, olderBuild: true }).canEditTrupps).toBe(false)
    expect(flags({ incidentMeta: meta({ is_archived: true }), olderBuild: true }).canSignRapport).toBe(false)
  })
  it('a replay locks everything, the outboxes included', () => {
    expect(flags({ replayActive: true })).toMatchObject({ readOnly: true, outboxReadOnly: true, canEditRapport: false, canSignRapport: false, tacticalLocked: true })
  })
})

// M6 A (13.11.2026): «Nur ansehen» in the head pill – true per surface, never beside the closed lock
describe('viewOnlyReason', () => {
  const reason = (over: Partial<FlagInputs>, mode: Parameters<typeof viewOnlyReason>[0]['mode'], extra: { linkScoped?: boolean; journalOpen?: boolean } = {}) =>
    viewOnlyReason({ flags: flags(over), roleReadOnly: over.roleReadOnly ?? false, linkScoped: extra.linkScoped ?? false, isEl: over.isEl ?? false, mode, journalOpen: extra.journalOpen ?? false })
  const viewer = { user: user('viewer'), isEditor: false, roleReadOnly: true }
  const el = { user: user('el'), isEditor: false, isEl: true }

  it('an editor writes every surface, so it never sees the mark', () => {
    for (const m of ['map', 'plans', 'atemschutz', 'rapport'] as const) expect(reason({}, m)).toBeNull()
  })
  it('a viewer and an Einsatz-Link say so on every surface, each with its own reason', () => {
    expect(reason(viewer, 'map')).toBe('viewer')
    expect(reason(viewer, 'rapport')).toBe('viewer')
    expect(reason(viewer, 'map', { linkScoped: true })).toBe('link')
  })
  it('the el is «Nur ansehen» on the picture and the Tafel, not on the record it keeps', () => {
    expect(reason(el, 'map')).toBe('el')
    expect(reason(el, 'plans')).toBe('el')
    expect(reason(el, 'atemschutz')).toBe('el')
    expect(reason(el, 'rapport')).toBeNull()
    expect(reason(el, 'anwesenheit')).toBeNull()
    expect(reason(el, 'map', { journalOpen: true })).toBeNull()
    // …and the Führungsansicht reads the same
    expect(reason({ user: user('editor', { el_view_default: true }) }, 'map')).toBe('el')
  })
  it('a closed Einsatz keeps its lock alone in the slot', () => {
    expect(reason({ ...viewer, incidentMeta: meta({ is_archived: true }) }, 'map')).toBeNull()
  })
})
