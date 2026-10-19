// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChecklistLibrary } from './ChecklistLibrary'
import { warmTemplates, type ChecklistTemplate } from '../lib/checklists'
import { useMediaQuery } from '../lib/useIsPhone'
import { appConfig } from '../config/appConfig'

// The Karte's Checkliste surface (19.10.2026): devices first, checklists to READ, one search over
// everything, and the place kept per tab. Pinned on the phone layout (list ↔ page), where the
// owner reads it; the tablet shares every piece with the Einsatz rail (ManualReader.test).

vi.mock('../lib/checklists', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/checklists')>(),
  warmTemplates: vi.fn(),
}))
vi.mock('../lib/useIsPhone', () => ({ useMediaQuery: vi.fn() }))

afterEach(() => { cleanup(); vi.clearAllMocks(); sessionStorage.clear() })

const FU: ChecklistTemplate = {
  id: 'fu', kind: 'action', title: 'Aufgaben FU', version: 1, source: 'x',
  phases: [{ id: 'p', title: 'Vor Anfahrt', items: [
    { id: 'a', text: 'Ausrückordnung beachten' },
    { id: 'b', text: 'Objektplan bereitlegen', action: 'plan', milestone: true },
  ] }],
}
const TAKTIK: ChecklistTemplate = {
  id: 'tk', kind: 'reference', title: 'Taktik · Stichworte', version: 1, source: 'x',
  entries: [{ id: 'pv', title: 'Photovoltaik', keywords: ['Gleichstrom'], content: [] }],
}
const GEN: ChecklistTemplate = {
  id: 'gen', kind: 'manual', title: 'Strom-Einspeisung', device: 'Generator', version: 1, source: 'x',
  steps: [{ text: 'Hauptschalter auf 0' }],
}

const mount = async (query = '') => {
  vi.mocked(useMediaQuery).mockReturnValue(true)
  vi.mocked(warmTemplates).mockReturnValue({ list: Promise.resolve([FU, TAKTIK, GEN]), newer: null })
  const view = render(<ChecklistLibrary query={query} />)
  await act(async () => {})
  return view
}

describe('ChecklistLibrary', () => {
  it('starts the templates (and so their offline pictures) itself, and shows devices first', async () => {
    const { container } = await mount()
    expect(warmTemplates).toHaveBeenCalled()
    const CL = appConfig.copy.checklists
    expect([...container.querySelectorAll('section')].map((g) => g.getAttribute('aria-label')))
      .toEqual([CL.groupManuals, CL.groupChecklists, CL.groupKnowledge])
  })

  it('shows a checklist to read: numbers, the quiet line, no boxes and no deep links', async () => {
    const { container } = await mount()
    fireEvent.click(screen.getByRole('button', { name: /Aufgaben FU/ }))
    expect(screen.getByText(appConfig.copy.checklists.readOnly)).toBeTruthy()
    expect(screen.getByText('Objektplan bereitlegen')).toBeTruthy()
    expect(container.querySelector('[role="checkbox"], input')).toBeNull()
    expect(screen.queryByText(appConfig.copy.checklists.actionLabels.plan)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Aufgaben FU/ })) // the back row
    expect(screen.getByRole('button', { name: /Generator/ })).toBeTruthy()
  })

  it('searches everything and says why a hit matched', async () => {
    await mount('strom')
    expect(screen.getByRole('button', { name: /Strom-Einspeisung.*Generator/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Photovoltaik.*Stichwort «Gleichstrom»/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Aufgaben FU/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Strom-Einspeisung/ }))
    expect(screen.getByText('Hauptschalter auf 0')).toBeTruthy()
  })

  it('keeps the open page when the surface comes back (Karte ↔ Checkliste)', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: /Generator/ }))
    cleanup()
    await mount()
    expect(screen.getByText('Hauptschalter auf 0')).toBeTruthy()
  })
})
