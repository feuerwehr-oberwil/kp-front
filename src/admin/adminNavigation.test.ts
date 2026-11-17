import { describe, expect, it } from 'vitest'
import { ADMIN_NAV, adminSectionFromPath, adminSectionHref, resolveAdminSection } from './adminNavigation'

describe('admin destinations and bookmarks', () => {
  it('keeps all 21 existing pages reachable exactly once in seven areas', () => {
    const ids = ADMIN_NAV.flatMap((g) => g.entries.map((e) => e.id))
    expect(ADMIN_NAV).toHaveLength(7)
    expect(ids.slice().sort()).toEqual([
      'identitaet', 'doktrin', 'rapport', 'alarme', 'fahrzeuge', 'material', 'ebenen', 'objektplaene',
      'checklisten', 'tafel', 'objektbesuche', 'mitglieder', 'mannschaft', 'einsaetze',
      'divera', 'traccar', 'arbeitsmappe', 'zugaenge', 'links', 'system', 'sicherung',
    ].sort())
    for (const id of ids) {
      expect(adminSectionFromPath(adminSectionHref(id))).toBe(id)
      expect(adminSectionFromPath(`/admin/${id}`)).toBe(id)
    }
  })

  it.each([
    ['karte', 'identitaet'], ['journal', 'rapport'], ['uebersicht', 'system'],
    ['statistik', 'links'], ['erfassung', 'links'], ['einsatzlink', 'zugaenge'],
  ])('keeps the old %s page and device preference working', (old, current) => {
    expect(resolveAdminSection(old)).toBe(current)
    expect(adminSectionFromPath(`/admin/${old}`)).toBe(current)
  })

  it('distinguishes a bare entry from an unknown path and rejects wrong areas/prototype keys', () => {
    expect(adminSectionFromPath('/admin')).toBeNull()
    expect(adminSectionFromPath('/admin/')).toBeNull()
    expect(adminSectionFromPath('/admin/personal/mannschaft/')).toBe('mannschaft')
    for (const path of ['/admin/unknown', '/admin/karte/mannschaft', '/admin/personal/mannschaft/extra', '/admin/toString']) {
      expect(adminSectionFromPath(path)).toBe('system')
    }
    expect(resolveAdminSection('constructor')).toBeNull()
  })
})
