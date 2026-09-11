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
// «Überwachung» is the row that rule was written for. It used to be the exception: env-only
// (HEALTHCHECK_PING_URL), so it was listed without a chevron and left out of the «x von n»
// count. It is now one of the credentials «Zugangsdaten» sets, so it is a row like any other —
// counted, with a working target. The tests below pin BOTH halves of that: it holds the card
// open while it is unset (which is only acceptable because it can be finished), and its chevron
// lands on the page that finishes it.

import { SetupChecklist, type SetupFacts } from './SetupChecklist'
import { appConfig } from '../config/appConfig'
import type { DeploymentConfig } from '../lib/deploymentConfig'

const C = appConfig.copy.admin.setup

/** A station that has finished everything but the monitor. */
const DONE_CFG = {
  identity: { appName: 'Feuerwehr Bergmatt', assets: { logo: '/api/branding/file/x.png' } },
  map: {
    defaultView: { center: [8.1148, 47.1723] },
    geocoder: { defaultLocality: '4104 Musterdorf BL' },
  },
  fleet: { vehicles: [{ id: 'tlf' }] },
} as unknown as DeploymentConfig
const DONE_FACTS: SetupFacts = { users: 4, personnelActive: 9, heartbeatConfigured: false, sharepointConfigured: true }

const card = () => document.querySelector('.adm-setup')

beforeEach(() => set.mockClear())
afterEach(cleanup)

describe('«Einrichtung» disappears once every row is done', () => {
  it('is gone when the browser-finishable setup is done — manual incidents are a valid steady state', () => {
    render(<SetupChecklist cfg={DONE_CFG} facts={DONE_FACTS} onGo={vi.fn()} />)
    expect(card()).not.toBeNull()
    expect(screen.getByText(C.title.replace('{done}', '8').replace('{n}', '9'))).toBeTruthy()

    cleanup()
    render(<SetupChecklist cfg={DONE_CFG} facts={{ ...DONE_FACTS, heartbeatConfigured: true }}
      onGo={vi.fn()} />)
    // No automatic alarm provider is configured. The card still clears because creating
    // incidents manually is a supported setup, not an unfinished integration.
    expect(card()).toBeNull()
  })

  it('counts Überwachung in the total while other rows are open', () => {
    render(<SetupChecklist cfg={{ ...DONE_CFG, fleet: { vehicles: [] } } as unknown as DeploymentConfig}
      facts={DONE_FACTS} onGo={vi.fn()} />)
    expect(screen.getByText(C.title.replace('{done}', '7').replace('{n}', '9'))).toBeTruthy()
    expect(screen.getByText(C.monitoringOpen)).toBeTruthy()
  })

  // ⚠️ The fixture above stores a WGS84 centre, so it could never catch this: the Station form
  // writes `centerLv95` and NULLs `center` when the operator picks LV95 — the Swiss default —
  // and the row used to tick on `center` alone. The card then never cleared, on the landing
  // page, forever. The test that documented the behaviour was the test that missed the bug.
  it('accepts an LV95 centre, so a Swiss station can actually finish the card', () => {
    const lv95 = { ...DONE_CFG, map: { ...DONE_CFG.map, defaultView: { center: null, centerLv95: [2600000, 1200000] } } }
    render(<SetupChecklist cfg={lv95 as unknown as DeploymentConfig}
      facts={{ ...DONE_FACTS, heartbeatConfigured: true }} onGo={vi.fn()} />)
    expect(card()).toBeNull()
  })

  it('still asks for a centre when neither CRS is set', () => {
    const none = { ...DONE_CFG, map: { ...DONE_CFG.map, defaultView: { center: null, centerLv95: null } } }
    render(<SetupChecklist cfg={none as unknown as DeploymentConfig}
      facts={{ ...DONE_FACTS, heartbeatConfigured: true }} onGo={vi.fn()} />)
    expect(screen.getByText(C.mapOpen)).toBeTruthy()
  })
})

describe('every row leads somewhere that can finish it', () => {
  it('sends Überwachung to «Zugangsdaten», where the ping URL is set', () => {
    const onGo = vi.fn()
    render(<SetupChecklist cfg={DONE_CFG} facts={DONE_FACTS} onGo={onGo} />)
    const row = screen.getByText(C.monitoring).closest('.adm-setup-row')
    expect(row?.tagName).toBe('BUTTON')
    fireEvent.click(row as Element)
    expect(onGo).toHaveBeenCalledWith('zugaenge')
  })

  it('leaves no row without a chevron — the card lists nothing it cannot offer', () => {
    render(<SetupChecklist cfg={{ ...DONE_CFG, fleet: { vehicles: [] } } as unknown as DeploymentConfig}
      facts={DONE_FACTS} onGo={vi.fn()} />)
    const rows = document.querySelectorAll('.adm-setup-row')
    expect(rows.length).toBe(9)
    rows.forEach((r) => {
      expect(r.tagName).toBe('BUTTON')
      expect(r.querySelector('.adm-setup-go')).not.toBeNull()
    })
  })
})

// The address search is biased by two fields that were CLI-only until recently and appear on no
// landing page. A Wehr can finish every other row and still be offered a «Hauptstrasse 3» from
// three cantons away the first time it opens an incident.
describe('the «Suchbereich» row', () => {
  const withGeocoder = (geocoder: unknown) =>
    ({ ...DONE_CFG, map: { ...DONE_CFG.map, geocoder } }) as unknown as DeploymentConfig

  it('stays open while neither Heimatort nor Suchbereich is set, and leads to «Station & Karte»', () => {
    const onGo = vi.fn()
    render(<SetupChecklist cfg={withGeocoder(null)}
      facts={{ ...DONE_FACTS, heartbeatConfigured: true }} onGo={onGo} />)
    expect(screen.getByText(C.geocoderOpen)).toBeTruthy()
    fireEvent.click(screen.getByText(C.geocoder).closest('.adm-setup-row') as Element)
    expect(onGo).toHaveBeenCalledWith('identitaet')
  })

  // Either field biases the search on its own (geocode.py · _resolve_bias), so demanding both
  // would keep the card open on a station that is in fact searching in the right place.
  it('ticks on the bbox alone, exactly as it does on the locality alone', () => {
    render(<SetupChecklist cfg={withGeocoder({ bboxLv95: '2603745,1256834,2613745,1266834' })}
      facts={{ ...DONE_FACTS, heartbeatConfigured: true }} onGo={vi.fn()} />)
    expect(card()).toBeNull()
  })

  it('does not tick on whitespace', () => {
    render(<SetupChecklist cfg={withGeocoder({ defaultLocality: '  ', bboxLv95: '' })}
      facts={{ ...DONE_FACTS, heartbeatConfigured: true }} onGo={vi.fn()} />)
    expect(screen.getByText(C.geocoderOpen)).toBeTruthy()
  })
})

// Credentials alone are a silent no-op (no folder to poll) and a folder alone cannot exist
// without credentials to read it — so the row is a single fact, not two, and it points at the
// half of the setup a browser can actually finish: Zugangsdaten, not the config file.
describe('the «SharePoint-Anbindung» row', () => {
  it('stays open until the status reports both credentials and a folder, and leads to «Zugangsdaten»', () => {
    const onGo = vi.fn()
    render(<SetupChecklist cfg={DONE_CFG}
      facts={{ ...DONE_FACTS, heartbeatConfigured: true, sharepointConfigured: false }} onGo={onGo} />)
    expect(screen.getByText(C.sharepointOpen)).toBeTruthy()
    fireEvent.click(screen.getByText(C.sharepoint).closest('.adm-setup-row') as Element)
    expect(onGo).toHaveBeenCalledWith('zugaenge')
  })

  it('ticks once both halves are in place', () => {
    render(<SetupChecklist cfg={DONE_CFG}
      facts={{ ...DONE_FACTS, heartbeatConfigured: true, sharepointConfigured: true }} onGo={vi.fn()} />)
    expect(card()).toBeNull()
  })
})

describe('the «Name der Wehr» row points at a field with the same name', () => {
  // ⚠️ This used to assert `C.name === appConfig.copy.admin.identity.appName` and nothing else —
  // two entries of the copy catalogue compared with each other. It passed with the component
  // deleted, with the row removed, and with the chevron pointing at the wrong page. A test that
  // cannot fail on the thing it is named after is not coverage; it is a comment with a runtime.
  it('renders the row under the exact label of the field it navigates to', () => {
    const onGo = vi.fn()
    const nameless = { ...DONE_CFG, identity: { ...DONE_CFG.identity, appName: '' } }
    render(<SetupChecklist cfg={nameless as unknown as DeploymentConfig} facts={DONE_FACTS} onGo={onGo} />)

    const row = screen.getByText(appConfig.copy.admin.identity.appName).closest('.adm-setup-row')
    expect(row).not.toBeNull()
    // …and it leads to the page that carries that field, so the two cannot drift apart silently
    fireEvent.click(row as Element)
    expect(onGo).toHaveBeenCalledWith('identitaet')
    // the open row says what is missing rather than only that something is
    expect(screen.getByText(C.nameOpen)).toBeTruthy()
  })
})

// «Fahrzeuge» is the row this card could never finish: the built-in catalogue writes no
// `fleet.vehicles`, so a station happy with the shipped Fahrzeuge sat at «7 von 8» forever — the
// same never-tickable row the card's own rule exists to prevent, only from the other direction.
// The hand tick is the escape hatch, and it belongs to the STATION (config), not to the tablet.
describe('«Abhaken» — die Zeile von Hand erledigen', () => {
  const OPEN_FLEET = { ...DONE_CFG, fleet: { vehicles: [] } } as unknown as DeploymentConfig
  const acknowledged = (keys: string[]) =>
    ({ ...OPEN_FLEET, setup: { acknowledged: keys } }) as unknown as DeploymentConfig

  const item = (label: string) => screen.getByText(label).closest('.adm-setup-item') as HTMLElement
  const ack = (label: string) => item(label).querySelector('.adm-setup-ack') as HTMLButtonElement
  const isDone = (label: string) => !!item(label).querySelector('.adm-setup-dot.done')

  it('schreibt das Häkchen in die Konfiguration — und die Zeile bleibt bei jedem weiteren Render erledigt', () => {
    const { rerender } = render(<SetupChecklist cfg={OPEN_FLEET} facts={DONE_FACTS} onGo={vi.fn()} />)
    expect(isDone(C.fleet)).toBe(false)
    // «dorthin» und «abhaken» sind Geschwister — ein Button im Button wäre ungültiges HTML
    expect(ack(C.fleet).closest('button.adm-setup-row')).toBeNull()

    fireEvent.click(ack(C.fleet))
    expect(set).toHaveBeenCalledWith(['setup', 'acknowledged'], ['fleet'])

    // …und mit dem Dokument, das dieser Schreibvorgang erzeugt, zählt die Zeile als erledigt
    rerender(<SetupChecklist cfg={acknowledged(['fleet'])} facts={DONE_FACTS} onGo={vi.fn()} />)
    expect(isDone(C.fleet)).toBe(true)
    expect(screen.getByText(C.title.replace('{done}', '8').replace('{n}', '9'))).toBeTruthy()

    rerender(<SetupChecklist cfg={acknowledged(['fleet'])} facts={DONE_FACTS} onGo={vi.fn()} />)
    expect(isDone(C.fleet)).toBe(true)
  })

  it('nimmt das Häkchen wieder zurück, ohne die übrigen anzufassen', () => {
    // «Suchbereich» bleibt offen, sonst wäre die Karte weg und es gäbe nichts mehr zu klicken
    const cfg = {
      ...acknowledged(['fleet', 'monitoring']),
      map: { ...DONE_CFG.map, geocoder: null },
    } as unknown as DeploymentConfig
    render(<SetupChecklist cfg={cfg} facts={DONE_FACTS} onGo={vi.fn()} />)

    expect(ack(C.monitoring).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(ack(C.monitoring))
    expect(set).toHaveBeenCalledWith(['setup', 'acknowledged'], ['fleet'])
  })
})
