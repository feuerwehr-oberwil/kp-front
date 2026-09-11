// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The card writes through the same config draft «Verwaltung» edits — the provider itself is not
// what is under test here, so only its writer is stubbed.
const { set } = vi.hoisted(() => ({ set: vi.fn() }))
vi.mock('./ConfigContext', () => ({ useConfig: () => ({ set }) }))

// «Einrichtung» makes exactly one promise: it is a nudge on the way in, and it goes away once
// there is nothing left on it to do (SETUP.md §3). What this file pins is the rule that keeps
// that promise honest — every line on this card must be finishable FROM THIS UI, because a row
// nobody can tick would park the card on the admin's landing page forever.
//
// ⚠️ The PREDICATES are no longer here. `GET /api/system` derives them (backend · api/system ·
// `_setup`, tested there, including the parts that look wrong until you read why: «users» wants
// more than one, «map» accepts either CRS, «geocoder» is done on either field). What this file
// pins is what the card does with that answer: it renders the server's rows, in the server's
// order, in this station's own words — and it folds the HAND ticks in on top, which is the one
// half of the state the browser owns.

import { SetupChecklist, type SetupFacts, type SetupState } from './SetupChecklist'
import { appConfig } from '../config/appConfig'
import type { DeploymentConfig } from '../lib/deploymentConfig'

const C = appConfig.copy.admin.setup

/** The ids the backend sends, in card order (backend · SETUP_ROWS). */
const IDS = ['name', 'map', 'logo', 'users', 'personnel', 'fleet', 'geocoder', 'sharepoint', 'monitoring']

/** The server's answer: every row done except the ones named. */
const setupWith = (open: string[], acknowledged: string[] = []): SetupState => ({
  rows: IDS.map((id) => ({ id, done: !open.includes(id) })),
  acknowledged,
  complete: open.every((id) => acknowledged.includes(id)),
})

/** A station that has filled everything in — the values the SUB lines quote back. */
const CFG = {
  identity: { appName: 'Feuerwehr Bergmatt', assets: { logo: '/api/branding/file/x.png' } },
  map: {
    defaultView: { center: [8.1148, 47.1723] },
    geocoder: { defaultLocality: '4104 Musterdorf BL' },
  },
  fleet: { vehicles: [{ id: 'tlf' }] },
} as unknown as DeploymentConfig
const FACTS: SetupFacts = { users: 4, personnelActive: 9 }

const card = () => document.querySelector('.adm-setup')
const show = (setup: SetupState | null, cfg: DeploymentConfig = CFG, onGo = vi.fn()) =>
  render(<SetupChecklist cfg={cfg} setup={setup} facts={FACTS} onGo={onGo} />)

beforeEach(() => set.mockClear())
afterEach(cleanup)

describe('the card renders the server\'s answer, not one of its own', () => {
  it('is gone once the server reports nothing open — manual incidents are a valid steady state', () => {
    show(setupWith(['monitoring']))
    expect(card()).not.toBeNull()
    expect(screen.getByText(C.title.replace('{done}', '8').replace('{n}', '9'))).toBeTruthy()

    cleanup()
    show(setupWith([]))
    // No automatic alarm provider is configured. The card still clears because creating
    // incidents manually is a supported setup, not an unfinished integration.
    expect(card()).toBeNull()
  })

  it('counts Überwachung in the total while other rows are open', () => {
    show(setupWith(['fleet', 'monitoring']))
    expect(screen.getByText(C.title.replace('{done}', '7').replace('{n}', '9'))).toBeTruthy()
    expect(screen.getByText(C.monitoringOpen)).toBeTruthy()
  })

  it('says nothing at all when that section of /api/system failed', () => {
    // ⚠️ A card that cannot say WHAT is open must not guess — «alles erledigt» and «keine
    // Ahnung» are the two answers it would be choosing between, and one of them is a lie.
    show(null)
    expect(card()).toBeNull()
  })

  it('skips a row id this build has no words for, rather than printing the raw id', () => {
    show({ rows: [{ id: 'quantum_entanglement', done: false }, { id: 'fleet', done: false }], acknowledged: [], complete: false })
    expect(screen.queryByText('quantum_entanglement')).toBeNull()
    expect(document.querySelectorAll('.adm-setup-row').length).toBe(1)
    expect(screen.getByText(C.fleet)).toBeTruthy()
  })

  it('quotes the station\'s own values in the sub line of a done row', () => {
    show(setupWith(['monitoring']))
    expect(screen.getByText('Feuerwehr Bergmatt')).toBeTruthy()
    expect(screen.getByText(C.usersSet.replace('{n}', '4'))).toBeTruthy()
    expect(screen.getByText(C.personnelSet.replace('{n}', '9'))).toBeTruthy()
  })
})

describe('every row leads somewhere that can finish it', () => {
  it('sends Überwachung to «Zugangsdaten», where the ping URL is set', () => {
    const onGo = vi.fn()
    show(setupWith(['monitoring']), CFG, onGo)
    const row = screen.getByText(C.monitoring).closest('.adm-setup-row')
    expect(row?.tagName).toBe('BUTTON')
    fireEvent.click(row as Element)
    expect(onGo).toHaveBeenCalledWith('zugaenge')
  })

  it('leaves no row without a chevron — the card lists nothing it cannot offer', () => {
    show(setupWith(['fleet', 'monitoring']))
    const rows = document.querySelectorAll('.adm-setup-row')
    expect(rows.length).toBe(9)
    rows.forEach((r) => {
      expect(r.tagName).toBe('BUTTON')
      expect(r.querySelector('.adm-setup-go')).not.toBeNull()
    })
  })

  // The SharePoint row leads to «Zugangsdaten», not to the config file: that is the half of the
  // setup a browser can actually finish.
  it('sends SharePoint to «Zugangsdaten» and the Wehr\'s name to «Station & Karte»', () => {
    const onGo = vi.fn()
    show(setupWith(['sharepoint', 'name']), CFG, onGo)
    expect(screen.getByText(C.sharepointOpen)).toBeTruthy()
    fireEvent.click(screen.getByText(C.sharepoint).closest('.adm-setup-row') as Element)
    expect(onGo).toHaveBeenCalledWith('zugaenge')

    // …and the «Name der Wehr» row carries the exact label of the field it navigates to, so the
    // two cannot drift apart silently.
    fireEvent.click(screen.getByText(appConfig.copy.admin.identity.appName).closest('.adm-setup-row') as Element)
    expect(onGo).toHaveBeenCalledWith('identitaet')
  })
})

// «Fahrzeuge» is the row nothing can finish: the built-in catalogue writes no `fleet.vehicles`,
// so a station happy with the shipped Fahrzeuge sat at «7 von 8» forever — the same never-tickable
// row the card's own rule exists to prevent, only from the other direction. The hand tick is the
// escape hatch, and it belongs to the STATION (config), not to the tablet.
describe('«Abhaken» — die Zeile von Hand erledigen', () => {
  const acknowledged = (keys: string[]) =>
    ({ ...CFG, setup: { acknowledged: keys } }) as unknown as DeploymentConfig

  const item = (label: string) => screen.getByText(label).closest('.adm-setup-item') as HTMLElement
  const ack = (label: string) => item(label).querySelector('.adm-setup-ack') as HTMLButtonElement
  const isDone = (label: string) => !!item(label).querySelector('.adm-setup-dot.done')

  it('schreibt das Häkchen in die Konfiguration — und die Zeile bleibt bei jedem weiteren Render erledigt', () => {
    // «Überwachung» bleibt offen, sonst verschwindet die Karte nach dem Häkchen und es gibt
    // nichts mehr zu prüfen.
    const open = setupWith(['fleet', 'monitoring'])
    const { rerender } = show(open)
    expect(isDone(C.fleet)).toBe(false)
    // «dorthin» und «abhaken» sind Geschwister — ein Button im Button wäre ungültiges HTML
    expect(ack(C.fleet).closest('button.adm-setup-row')).toBeNull()

    fireEvent.click(ack(C.fleet))
    expect(set).toHaveBeenCalledWith(['setup', 'acknowledged'], ['fleet'])

    // ⚠️ Der Server weiss noch nichts davon (die Konfiguration speichert erst nach 700 ms), und
    // genau darum liest die Karte den Entwurf: sonst sähe «Abhaken» wie ein toter Knopf aus.
    rerender(<SetupChecklist cfg={acknowledged(['fleet'])} setup={open} facts={FACTS} onGo={vi.fn()} />)
    expect(isDone(C.fleet)).toBe(true)
    expect(screen.getByText(C.ackSub)).toBeTruthy()
    expect(screen.getByText(C.title.replace('{done}', '8').replace('{n}', '9'))).toBeTruthy()
  })

  it('nimmt das Häkchen wieder zurück, ohne die übrigen anzufassen', () => {
    // «Suchbereich» bleibt offen, sonst wäre die Karte weg und es gäbe nichts mehr zu klicken
    show(setupWith(['fleet', 'monitoring', 'geocoder'], ['fleet', 'monitoring']),
      acknowledged(['fleet', 'monitoring']))

    expect(ack(C.monitoring).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(ack(C.monitoring))
    expect(set).toHaveBeenCalledWith(['setup', 'acknowledged'], ['fleet'])
  })
})
