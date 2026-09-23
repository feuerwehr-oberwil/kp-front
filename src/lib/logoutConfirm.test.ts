import { describe, expect, it } from 'vitest'
import { logoutAsk } from './logoutConfirm'

describe('logoutAsk — «Abmelden» always asks, and says what it costs', () => {
  it('online with nothing unsent: the plain ask, no note, danger (focus on «Abbrechen»)', () => {
    const a = logoutAsk({ online: true, unsyncedEntries: 0 })
    expect(a.title).toBe('Abmelden?')
    expect(a.message).toBe('Danach öffnet dieses Gerät Einsätze erst wieder nach einer Anmeldung mit PIN.')
    expect(a.note).toBeUndefined()
    expect(a).toMatchObject({ confirmLabel: 'Abmelden', cancelLabel: 'Abbrechen', danger: true })
  })

  it('offline: the SAME card adds that a new sign-in needs the network', () => {
    expect(logoutAsk({ online: false, unsyncedEntries: 0 }).note)
      .toBe('Eine neue Anmeldung ist erst wieder mit Netz möglich – bis dahin öffnet dieses Gerät keinen Einsatz.')
  })

  it('counts the unsent entries in the singular and the plural', () => {
    expect(logoutAsk({ online: true, unsyncedEntries: 1 }).note)
      .toBe('1 Eintrag ist noch nicht übertragen. Er bleibt auf diesem Gerät und wird gesendet, sobald du dich wieder anmeldest.')
    expect(logoutAsk({ online: true, unsyncedEntries: 3 }).note)
      .toBe('3 Einträge sind noch nicht übertragen. Sie bleiben auf diesem Gerät und werden gesendet, sobald du dich wieder anmeldest.')
  })

  it('names uncounted changes only when no entry can be counted', () => {
    expect(logoutAsk({ online: true, unsyncedEntries: 0, unsyncedOther: true }).note).toMatch(/^Änderungen sind noch nicht übertragen\./)
    expect(logoutAsk({ online: true, unsyncedEntries: 2, unsyncedOther: true }).note).toMatch(/^2 Einträge/)
  })

  it('offline AND unsent: both, the network first', () => {
    expect(logoutAsk({ online: false, unsyncedEntries: 2 }).note)
      .toBe('Eine neue Anmeldung ist erst wieder mit Netz möglich – bis dahin öffnet dieses Gerät keinen Einsatz. 2 Einträge sind noch nicht übertragen. Sie bleiben auf diesem Gerät und werden gesendet, sobald du dich wieder anmeldest.')
  })
})
