// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  map: { defaultView: { center: [8.1148, 47.1723] } },
  fleet: { vehicles: [{ id: 'tlf' }] },
} as unknown as DeploymentConfig
const DONE_FACTS: SetupFacts = { users: 4, personnelActive: 9, heartbeatConfigured: false }

const card = () => document.querySelector('.adm-setup')

afterEach(cleanup)

describe('«Einrichtung» disappears once every row is done', () => {
  it('is gone only when Überwachung is done too — it counts like every other row', () => {
    render(<SetupChecklist cfg={DONE_CFG} facts={DONE_FACTS} onGo={vi.fn()} />)
    expect(card()).not.toBeNull()
    expect(screen.getByText(C.title.replace('{done}', '6').replace('{n}', '7'))).toBeTruthy()

    cleanup()
    render(<SetupChecklist cfg={DONE_CFG} facts={{ ...DONE_FACTS, heartbeatConfigured: true }}
      onGo={vi.fn()} />)
    expect(card()).toBeNull()
  })

  it('counts Überwachung in the total while other rows are open', () => {
    render(<SetupChecklist cfg={{ ...DONE_CFG, fleet: { vehicles: [] } } as unknown as DeploymentConfig}
      facts={DONE_FACTS} onGo={vi.fn()} />)
    expect(screen.getByText(C.title.replace('{done}', '5').replace('{n}', '7'))).toBeTruthy()
    expect(screen.getByText(C.monitoringOpen)).toBeTruthy()
  })

  // ⚠️ The fixture above stores a WGS84 centre, so it could never catch this: the Station form
  // writes `centerLv95` and NULLs `center` when the operator picks LV95 — the Swiss default —
  // and the row used to tick on `center` alone. The card then never cleared, on the landing
  // page, forever. The test that documented the behaviour was the test that missed the bug.
  it('accepts an LV95 centre, so a Swiss station can actually finish the card', () => {
    const lv95 = { ...DONE_CFG, map: { defaultView: { center: null, centerLv95: [2600000, 1200000] } } }
    render(<SetupChecklist cfg={lv95 as unknown as DeploymentConfig}
      facts={{ ...DONE_FACTS, heartbeatConfigured: true }} onGo={vi.fn()} />)
    expect(card()).toBeNull()
  })

  it('still asks for a centre when neither CRS is set', () => {
    const none = { ...DONE_CFG, map: { defaultView: { center: null, centerLv95: null } } }
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
    expect(rows.length).toBe(7)
    rows.forEach((r) => {
      expect(r.tagName).toBe('BUTTON')
      expect(r.querySelector('.adm-setup-go')).not.toBeNull()
    })
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
