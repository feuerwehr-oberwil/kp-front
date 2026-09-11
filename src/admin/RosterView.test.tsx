// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The CSV import stops BEFORE it writes — for EVERY file, not only for one that uses a
// Dienstgrad the station's rank list does not know. What is asserted here is the part a person
// can see:
//   • picking the file imports nobody — the confirmation appears first, ranks known or not;
//   • it says how many people are new and how many it would update in place;
//   • one unknown VALUE is one row, whatever the number of people behind it;
//   • «Abbrechen» sends nothing at all;
//   • the decisions leave for the server exactly as they were made.
// Two bugs live here. The old import wrote all 40 people first and listed «Zeile 12: unbekannter
// Grad 'Sdt'» afterwards, under a green «40 importiert» badge. Its replacement only asked when a
// rank was unknown — so a station that re-picked an already-imported file got its whole Wehr a
// second time, silently, because by then every rank was known.

const { previewRosterCsv, importRosterCsv, listRoster, createPerson, updatePerson } = vi.hoisted(() => ({
  previewRosterCsv: vi.fn(),
  importRosterCsv: vi.fn(),
  listRoster: vi.fn(),
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
}))
vi.mock('./rosterApi', () => ({
  listRoster,
  previewRosterCsv,
  importRosterCsv,
  createPerson,
  updatePerson,
}))

/** The Dienstgrade of THIS station — deliberately none of them from the shipped Swiss list, so
 *  a picker that offered a hard-coded vocabulary would be visible as such. */
const STATION_RANKS = [
  { key: 'zgf', label: 'Zugführer', abbr: 'Zgf', tier: 'officer' as const },
  { key: 'sdt', label: 'Soldat', abbr: 'Sdt', tier: 'crew' as const },
]
vi.mock('../lib/deploymentConfig', async () => {
  const actual = await vi.importActual<typeof import('../lib/deploymentConfig')>('../lib/deploymentConfig')
  return { ...actual, getDeploymentConfig: () => ({ roster: { ranks: STATION_RANKS } }) }
})

const apiGet = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiGet: (p: string) => apiGet(p), apiPut: vi.fn() }
})

import { RosterView } from './RosterView'
import { ConfigProvider } from './ConfigContext'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

const C = appConfig.copy.admin.roster

const KNOWN = [
  { key: 'oblt', label: 'Oberleutnant', abbr: 'Oblt' },
  { key: 'fwm', label: 'Feuerwehrmann', abbr: 'Fwm' },
]

/** «Sdt» three times (nothing like it in the list) and one near-miss the server proposes. */
const PREVIEW = {
  total: 40,
  creates: 40,
  updates: 0,
  skipped: 0,
  errors: [],
  known_ranks: KNOWN,
  has_own_ranks: true,
  unknown_ranks: [
    { value: 'Sdt', count: 3, people: ['Berger Luca', 'Frei Nadja', 'Sutter Ivo'], suggestion: null },
    { value: 'Oblt.', count: 2, people: ['Kunz Bea', 'Roth Tim'], suggestion: 'oblt' },
  ],
}

const RESULT = { imported: 40, created: 40, updated: 0, skipped: 0, errors: [], adopted_ranks: [] }

beforeEach(() => {
  vi.clearAllMocks()
  listRoster.mockResolvedValue([])
  importRosterCsv.mockResolvedValue(RESULT)
  apiGet.mockResolvedValue({ integrations: {} })
})
afterEach(cleanup)

/** Mount the page and hand it a file, as the operator does. */
async function pickFile(preview: unknown = PREVIEW) {
  previewRosterCsv.mockResolvedValue(preview)
  const { container } = await act(async () => render(<ConfigProvider><RosterView /></ConfigProvider>))
  const input = await waitFor(() => {
    const el = container.querySelector('input[type="file"]')
    if (!el) throw new Error('no file input')
    return el as HTMLInputElement
  })
  const file = new File(['name,rank\n'], 'mannschaft-2026.csv', { type: 'text/csv' })
  fireEvent.change(input, { target: { files: [file] } })
  await waitFor(() => expect(previewRosterCsv).toHaveBeenCalled())
}

const primary = () => screen.getByRole('button', { name: /importieren$/i }) as HTMLButtonElement

/** Choose an option in one row's «Wird zu» picker. */
function choose(rowValue: string, optionLabel: string) {
  fireEvent.click(screen.getByRole('button', { name: fillTemplate(C.mapTargetFor, { value: rowValue }) }))
  fireEvent.click(screen.getByRole('option', { name: optionLabel }))
}

describe('CSV-Import · Grade zuordnen', () => {
  it('imports nobody until the unknown ranks are decided', async () => {
    await pickFile()
    await screen.findByText(C.mapTitle)
    expect(importRosterCsv).not.toHaveBeenCalled()
  })

  it('asks once per VALUE, not once per person', async () => {
    await pickFile()
    await screen.findByText(C.mapTitle)
    expect(screen.getAllByText('Sdt')).toHaveLength(1)
    expect(screen.getByText(fillTemplate(C.mapPeopleCount, { n: 3 }))).toBeTruthy()
    expect(screen.getByText('Berger Luca, Frei Nadja, Sutter Ivo')).toBeTruthy()
  })

  it('writes nothing at all when the mapping is cancelled', async () => {
    await pickFile()
    await screen.findByText(C.mapTitle)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.admin.common2.cancel }))
    await waitFor(() => expect(screen.queryByText(C.mapTitle)).toBeNull())
    expect(importRosterCsv).not.toHaveBeenCalled()
  })

  it('sends the decisions as they were made — a proposal is preselected, never applied silently', async () => {
    await pickFile()
    await screen.findByText(C.mapTitle)
    // «Oblt.» came back with a proposal, «Sdt» with none: the one is preselected on the rank,
    // the other on «neuer Grad».
    expect(screen.getByText('Oberleutnant · Oblt')).toBeTruthy()
    choose('Sdt', C.mapDropOption)
    fireEvent.click(primary())

    await waitFor(() => expect(importRosterCsv).toHaveBeenCalled())
    expect(importRosterCsv.mock.calls[0][1]).toEqual([
      { value: 'Sdt', action: 'skip' },
      { value: 'Oblt.', action: 'map', rank: 'oblt' },
    ])
  })

  it('takes the whole column in one press when the station has no rank list of its own', async () => {
    await pickFile({ ...PREVIEW, has_own_ranks: false })
    await screen.findByText(C.mapNoOwnListTitle)
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(C.mapAdoptAll, { n: 2 }) }))

    // the primary action says what it now does — «übernehmen», not «zuordnen»
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(C.mapAdoptAndImport, { n: 40 }) }))
    await waitFor(() => expect(importRosterCsv).toHaveBeenCalled())
    expect(importRosterCsv.mock.calls[0][1]).toEqual([
      { value: 'Sdt', action: 'adopt' },
      { value: 'Oblt.', action: 'adopt' },
    ])
  })

  it('confirms a file whose ranks are all known too — without a mapping table', async () => {
    await pickFile({ ...PREVIEW, unknown_ranks: [] })
    await screen.findByText(C.confirmTitle)
    expect(importRosterCsv).not.toHaveBeenCalled()
    expect(screen.queryByText(C.mapColValue)).toBeNull()

    fireEvent.click(primary())
    await waitFor(() => expect(importRosterCsv).toHaveBeenCalled())
    expect(importRosterCsv.mock.calls[0][1]).toEqual([])
    expect(await screen.findByText(fillTemplate(C.createdBadge, { n: 40 }))).toBeTruthy()
  })

  // The blocker: 14 people imported, the same file picked again. Nothing about it looks
  // different — same green sheet, same button — except the one line that matters.
  it('says «nothing new, 14 updates» when the file has already been imported', async () => {
    await pickFile({ ...PREVIEW, total: 14, creates: 0, updates: 14, unknown_ranks: [] })
    await screen.findByText(C.confirmTitle)
    expect(screen.getByText(fillTemplate(C.confirmNew, { n: 0 }))).toBeTruthy()
    expect(screen.getByText(fillTemplate(C.confirmUpdated, { n: 14 }))).toBeTruthy()
    expect(importRosterCsv).not.toHaveBeenCalled()
  })

  it('writes nothing when a plain confirmation is cancelled', async () => {
    await pickFile({ ...PREVIEW, creates: 0, updates: 40, unknown_ranks: [] })
    await screen.findByText(C.confirmTitle)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.admin.common2.cancel }))
    await waitFor(() => expect(screen.queryByText(C.confirmTitle)).toBeNull())
    expect(importRosterCsv).not.toHaveBeenCalled()
  })

  it('offers no import at all for a file that would touch nobody', async () => {
    await pickFile({ ...PREVIEW, total: 0, creates: 0, updates: 0, skipped: 3, unknown_ranks: [] })
    await screen.findByText(C.confirmNothing)
    expect(primary().disabled).toBe(true)
  })
})

// Namensformat — die eine Einstellung dieser Seite. Sie war als einzige im ganzen /admin keine
// Zeile der Einstellungstabelle, sondern eine Karte mit gestapeltem Feld; hier steht, dass sie
// jetzt eine SettingRow ist UND weiterhin über denselben Config-Pfad schreibt.
describe('Namensformat', () => {
  it('ist eine Zeile der Einstellungstabelle und schreibt in den Config-Entwurf', async () => {
    await act(async () => render(<ConfigProvider><RosterView /></ConfigProvider>))

    const trigger = screen.getByLabelText(C.nameOrderLabel)
    expect(trigger.closest('.adm-set-row')).toBeTruthy()
    // solange die ausgelieferte Reihenfolge gilt, schweigt die Standard-Spalte
    expect(document.querySelector('.adm-set-std')?.textContent).toBe('')

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: C.nameOrderFirstLast }))

    expect(screen.getByLabelText(C.nameOrderLabel).textContent).toContain(C.nameOrderFirstLast)
    expect(document.querySelector('.adm-set-std')?.textContent).toBe(
      // the SHORT label: the option's own text carries an example, which would put three
      // ·-separated parts in the narrowest column on the page
      fillTemplate(appConfig.copy.admin.common.standardChanged, { value: C.nameOrderShortLastFirst }),
    )
  })
})

// «Person hinzufügen» nahm nur den Namen entgegen, obwohl die Tabelle daneben Grad und Status
// führt — eine im Browser erfasste Person landete ohne Dienstgrad, und geändert werden konnte er
// nirgends. Hier steht, dass beides angelegt UND bearbeitet wird, und dass die Gradliste die der
// Station ist.
describe('Grad und Status — erfassen und bearbeiten', () => {
  const PERSON = {
    id: 'p1',
    divera_id: null,
    external_identities: [],
    display_name: 'Berger Luca',
    first_name: null,
    last_name: null,
    rank: 'sdt',
    is_active: true,
    updated_at: '2026-09-10T08:00:00Z',
  }

  /** Pick an option in one of the two form pickers (they carry the column's name). */
  const pick = (field: string, option: string) => {
    fireEvent.click(screen.getByRole('button', { name: field }))
    fireEvent.click(screen.getByRole('option', { name: option }))
  }

  const mount = () => act(async () => { render(<ConfigProvider><RosterView /></ConfigProvider>) })

  it('öffnet das Formular im selben Card wie der Knopf, nicht oben auf der Seite', async () => {
    await mount()
    expect(document.querySelector('.adm-members-addbox')).toBeNull()

    const trigger = screen.getByRole('button', { name: C.addPerson })
    fireEvent.click(trigger)

    // Der Knopf steht im Kopf einer Card; das Formular muss im Body GENAU dieser Card stehen.
    // Vorher rendete es als eigene Card zuoberst auf der Seite – der Klick schob die Antwort
    // aus dem Bild, und die Seite sah aus, als sei man woanders gelandet.
    const card = trigger.closest('.adm-card')
    expect(card).toBeTruthy()
    const box = document.querySelector('.adm-members-addbox')
    expect(box).toBeTruthy()
    expect(card!.contains(box!)).toBe(true)
    expect(box!.closest('.adm-card')).toBe(card)
  })

  it('legt eine Person mit Grad und Status an – beides erreicht die API', async () => {
    createPerson.mockResolvedValue({ ...PERSON, rank: 'zgf', is_active: true })
    updatePerson.mockResolvedValue({ ...PERSON, rank: 'zgf', is_active: false })
    await mount()

    fireEvent.click(screen.getByRole('button', { name: C.addPerson }))
    fireEvent.change(document.querySelector('.adm-members-addbox .adm-input')!, {
      target: { value: 'Berger Luca' },
    })

    // die Liste der Station, nicht die mitgelieferte Schweizer
    fireEvent.click(screen.getByRole('button', { name: C.colRank }))
    expect(screen.queryByRole('option', { name: /Feuerwehrmann/ })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'Zugführer · Zgf' }))

    pick(C.colStatus, C.inactive)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.admin.common2.create }))

    await waitFor(() => expect(createPerson).toHaveBeenCalled())
    expect(createPerson.mock.calls[0][0]).toEqual({ display_name: 'Berger Luca', rank: 'zgf' })
    // ⚠️ Der Status braucht den zweiten Schreibvorgang: PersonnelCreate kennt kein is_active,
    // der Server legt IMMER aktiv an (backend/app/api/personnel.py · create_person).
    await waitFor(() => expect(updatePerson).toHaveBeenCalledWith('p1', { is_active: false }))
  })

  it('ändert Grad und Status einer erfassten Person in einem PATCH', async () => {
    listRoster.mockResolvedValue([PERSON])
    updatePerson.mockResolvedValue({ ...PERSON, rank: 'zgf', is_active: false })
    await mount()

    fireEvent.click(screen.getByRole('button', { name: `${C.colActions} — Berger Luca` }))
    fireEvent.click(await screen.findByText(appConfig.copy.admin.common2.edit))

    // der bestehende Grad steht drin, statt dass die Maske mit einem leeren Feld öffnet
    expect(screen.getByRole('button', { name: C.colRank }).textContent).toContain('Soldat')
    pick(C.colRank, 'Zugführer · Zgf')
    pick(C.colStatus, C.inactive)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.admin.common2.save }))

    await waitFor(() => expect(updatePerson).toHaveBeenCalled())
    expect(updatePerson.mock.calls[0]).toEqual([
      'p1',
      { display_name: 'Berger Luca', rank: 'zgf', is_active: false },
    ])
  })

  // ⚠️ Select zeigt für einen Wert, den es nicht findet, seine ERSTE Option. Ein Grad, den die
  // Konfiguration der Station (noch) nicht kennt – der Normalfall nach einer Synchronisation in
  // eine unkonfigurierte Station – sähe damit leer aus und würde beim Speichern umgehängt.
  it('hält einen Grad, den die Gradliste nicht kennt, wählbar', async () => {
    listRoster.mockResolvedValue([{ ...PERSON, rank: 'wachtm' }])
    updatePerson.mockResolvedValue({ ...PERSON, rank: 'wachtm' })
    await mount()

    fireEvent.click(screen.getByRole('button', { name: `${C.colActions} — Berger Luca` }))
    fireEvent.click(await screen.findByText(appConfig.copy.admin.common2.edit))
    expect(screen.getByRole('button', { name: C.colRank }).textContent).toContain('wachtm')

    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.admin.common2.save }))
    await waitFor(() => expect(updatePerson).toHaveBeenCalled())
    expect(updatePerson.mock.calls[0][1]).toMatchObject({ rank: 'wachtm' })
  })

  // Eine Tatsache, ein Schreibweg: die Zeilenaktion schreibt denselben PATCH wie der
  // Status-Wähler der Bearbeitungszeile (vorher DELETE /api/personnel/{id}).
  it('deaktiviert über die Zeilenaktion mit demselben PATCH', async () => {
    listRoster.mockResolvedValue([PERSON])
    updatePerson.mockResolvedValue({ ...PERSON, is_active: false })
    await mount()

    fireEvent.click(screen.getByRole('button', { name: `${C.colActions} — Berger Luca` }))
    fireEvent.click(await screen.findByText(C.deactivate))
    await waitFor(() => expect(updatePerson).toHaveBeenCalledWith('p1', { is_active: false }))
  })
})
