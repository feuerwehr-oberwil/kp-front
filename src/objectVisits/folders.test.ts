import { describe, expect, it } from 'vitest'
import { DEFAULT_DESTINATION, destinationLabel, destinationValid, fillFolder, objectFolderOf, previewFolder, previewLocationFolder, sanitizeSegment } from './folders'

const vars = { objectName: 'Gemeindeverwaltung', objectAddress: 'Hauptstrasse 24', date: '2026-10-03', checklist: 'Kontrolle Schlüsselhülse', visitId: 'ov1759473240123-7f3a' }

describe('destination folders', () => {
  it('sanitises a segment for SharePoint', () => {
    expect(sanitizeSegment(' .a"b*c:d<e>f?g/h\\i|j. ')).toBe('abcdefghij')
  })
  it('{object.folder} falls back to «address - name», then the name', () => {
    expect(objectFolderOf({ ...vars, objectFolder: 'Ordner X' })).toBe('Ordner X')
    expect(objectFolderOf(vars)).toBe('Hauptstrasse 24 - Gemeindeverwaltung')
    expect(objectFolderOf({ ...vars, objectAddress: null })).toBe('Gemeindeverwaltung')
  })
  it('fills the visit folder; a slash in a VALUE does not open a folder', () => {
    expect(fillFolder('Objektbesuche/{date} {checklist} ({short})', vars)).toEqual(['Objektbesuche', '2026-10-03 Kontrolle Schlüsselhülse (7f3a)'])
    expect(fillFolder('{object.name}', { ...vars, objectName: 'A/B' })).toEqual(['AB'])
    expect(fillFolder('{checklist}', { ...vars, checklist: null })).toEqual(['Besuch'])
  })
  it('previews root / object / visit for the admin', () => {
    expect(previewFolder({ ...DEFAULT_DESTINATION, root: 'FÜHRUNGSUNTERSTÜTZUNG/Einsatzpläne' }, vars))
      .toBe('FÜHRUNGSUNTERSTÜTZUNG/Einsatzpläne/Hauptstrasse 24 - Gemeindeverwaltung/Objektbesuche/2026-10-03 Kontrolle Schlüsselhülse (7f3a)')
  })
  it('a visit at a place goes to one general folder below the root — no object folder, no year', () => {
    const place = { ...vars, checklist: 'Fehlermeldung', locationLabel: 'bei Talholzstrasse 15' }
    expect(previewLocationFolder({ ...DEFAULT_DESTINATION, root: 'FÜHRUNGSUNTERSTÜTZUNG/Einsatzpläne' }, place))
      .toBe('FÜHRUNGSUNTERSTÜTZUNG/Einsatzpläne/Allgemeine Meldungen/2026-10-03 Fehlermeldung (7f3a)')
    expect(previewLocationFolder({ root: '', locationFolder: 'Meldungen/{location.label}' }, place)).toBe('Meldungen/bei Talholzstrasse 15')
    // an older stored destination without the field files under the default
    expect(previewLocationFolder({ root: 'R' }, place)).toBe('R/Allgemeine Meldungen/2026-10-03 Fehlermeldung (7f3a)')
  })
  it('refuses what the server would refuse — so one bad row never blocks the config save', () => {
    expect(destinationValid(DEFAULT_DESTINATION)).toBe(false) // no site yet
    const ok = { ...DEFAULT_DESTINATION, siteUrl: 'https://x.sharepoint.com/sites/FWO' }
    expect(destinationValid(ok)).toBe(true)
    expect(destinationValid({ ...ok, siteUrl: 'http://x' })).toBe(false)
    expect(destinationValid({ ...ok, root: 'a/../b' })).toBe(false)
    expect(destinationValid({ ...ok, visitFolder: ' ' })).toBe(false)
    expect(destinationValid({ ...ok, id: 'Bad Id' })).toBe(false)
    expect(destinationValid({ ...ok, locationFolder: '../x' })).toBe(false)
    expect(destinationValid({ ...ok, locationFolder: undefined })).toBe(true)
  })
  it('names a destination for a person, not by its id', () => {
    const kind = () => 'SharePoint'
    const dests = [{ id: 'sharepoint-fu', kind: 'sharepoint', root: 'FÜHRUNGSUNTERSTÜTZUNG/Einsatzpläne/' }, { id: 'sp2', kind: 'sharepoint', root: '' }]
    expect(destinationLabel('sharepoint-fu', dests, kind)).toBe('SharePoint · Einsatzpläne')
    expect(destinationLabel('sp2', dests, kind)).toBe('SharePoint')
    expect(destinationLabel('gone', dests, kind)).toBe('gone')
  })
})
