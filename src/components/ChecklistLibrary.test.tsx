// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChecklistLibrary } from './ChecklistLibrary'
import { warmTemplates, type ChecklistTemplate } from '../lib/checklists'
import { useMediaQuery } from '../lib/useIsPhone'
import { appConfig } from '../config/appConfig'
import { appHistoryDepth } from '../objectVisits/route'

// The Karte's Checkliste surface (19.10.2026): devices first, checklists to READ, one search over
// everything, and the place kept per tab. Pinned on the phone layout (list ↔ page), where the
// owner reads it; the tablet shares every piece with the Einsatz rail (ManualReader.test).

vi.mock('../lib/checklists', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/checklists')>(),
  warmTemplates: vi.fn(),
}))
vi.mock('../lib/useIsPhone', () => ({ useMediaQuery: vi.fn() }))

/** the history steps the library schedules (a microtask) and their traversals (a task) */
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })

afterEach(async () => { cleanup(); await settle(); vi.clearAllMocks(); sessionStorage.clear() })

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

const TLF = (id: string, title: string): ChecklistTemplate => ({
  id, kind: 'manual', title, device: 'TLF', version: 1, source: 'x', steps: [{ text: `${title} – Schritt` }],
})

const mount = async (query = '', extra: ChecklistTemplate[] = []) => {
  vi.mocked(useMediaQuery).mockReturnValue(true)
  vi.mocked(warmTemplates).mockReturnValue({ list: Promise.resolve([FU, TAKTIK, GEN, ...extra]), newer: null })
  const view = render(<ChecklistLibrary query={query} />)
  await act(async () => {})
  return view
}

describe('ChecklistLibrary', () => {
  it('starts the templates (and so their offline pictures) itself, and shows devices first', async () => {
    const { container } = await mount()
    expect(warmTemplates).toHaveBeenCalled()
    const CL = appConfig.copy.checklists
    // the Einsatzwissen unfolded: each reference template is a group of its Stichworte (review round 2)
    expect([...container.querySelectorAll('section')].map((g) => g.getAttribute('aria-label')))
      .toEqual([CL.groupManuals, CL.groupChecklists, TAKTIK.title])
  })

  it('opens a Stichwort from the home and goes back to the list', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: /Photovoltaik/ }))
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.modes.checklists })) // the back row
    expect(screen.getByRole('button', { name: /Generator/ })).toBeTruthy()
  })

  it('shows a checklist to read: numbers, the quiet line, no boxes and no deep links', async () => {
    const { container } = await mount()
    fireEvent.click(screen.getByRole('button', { name: /Aufgaben FU/ }))
    expect(screen.getByText(appConfig.copy.checklists.readOnly)).toBeTruthy()
    expect(screen.getByText('Objektplan bereitlegen')).toBeTruthy()
    expect(container.querySelector('[role="checkbox"], input')).toBeNull()
    expect(screen.queryByText(appConfig.copy.checklists.actionLabels.plan)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.modes.checklists })) // the back row
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

  it('goes back from a chapter to its device by name («‹ TLF»)', async () => {
    await mount('', [TLF('t1', 'Bedienungstableau'), TLF('t2', 'Notbetrieb')])
    fireEvent.click(screen.getByRole('button', { name: /^TLF/ }))
    fireEvent.click(screen.getByRole('button', { name: /Bedienungstableau/ }))
    expect(screen.getByText('Bedienungstableau – Schritt')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'TLF' })[0]) // the back row (the meta line's device link goes there too)
    expect(screen.getByRole('button', { name: /Notbetrieb/ })).toBeTruthy()
    expect(screen.queryByText('Bedienungstableau – Schritt')).toBeNull()
  })

  // owner 20.10.2026: «swipe from the left to go back one section» – the native back gestures
  // pop a history entry, so every level deeper is one (lib/historyTrail)
  it('the native back steps up one level: chapter → device → list, and leaving leaves nothing', async () => {
    const { unmount } = await mount('', [TLF('t1', 'Bedienungstableau'), TLF('t2', 'Notbetrieb')])
    fireEvent.click(screen.getByRole('button', { name: /^TLF/ }))
    fireEvent.click(screen.getByRole('button', { name: /Bedienungstableau/ }))
    await settle()
    expect(appHistoryDepth()).toBe(2)
    // the next chapter is a sibling: no entry of its own
    fireEvent.click(screen.getByRole('button', { name: /Notbetrieb/ }))
    await settle()
    expect(appHistoryDepth()).toBe(2)
    expect(screen.getByText('Notbetrieb – Schritt')).toBeTruthy()
    act(() => window.history.back())
    await settle()
    expect(screen.queryByText('Notbetrieb – Schritt')).toBeNull() // the device page
    expect(screen.getByRole('button', { name: /Bedienungstableau/ })).toBeTruthy()
    act(() => window.history.back())
    await settle()
    expect(screen.getByRole('button', { name: /Generator/ })).toBeTruthy() // the list
    fireEvent.click(screen.getByRole('button', { name: /Generator/ }))
    await settle()
    unmount() // back to the Karte
    await settle()
    expect(appHistoryDepth()).toBe(0)
  })

  it('a page that comes back gets its levels back: «‹ TLF» and the swipe both reach the device', async () => {
    await mount('', [TLF('t1', 'Bedienungstableau'), TLF('t2', 'Notbetrieb')])
    fireEvent.click(screen.getByRole('button', { name: /^TLF/ }))
    fireEvent.click(screen.getByRole('button', { name: /Notbetrieb/ }))
    cleanup()
    await settle()
    await mount('', [TLF('t1', 'Bedienungstableau'), TLF('t2', 'Notbetrieb')])
    await settle()
    expect(screen.getByText('Notbetrieb – Schritt')).toBeTruthy()
    expect(appHistoryDepth()).toBe(2)
    fireEvent.click(screen.getAllByRole('button', { name: 'TLF' })[0]) // the back row = one step back
    await settle()
    expect(appHistoryDepth()).toBe(1)
    expect(screen.queryByText('Notbetrieb – Schritt')).toBeNull()
    act(() => window.history.back())
    await settle()
    expect(screen.getByRole('button', { name: /Generator/ })).toBeTruthy() // the list
  })

  it('keeps the open page when the surface comes back (Karte ↔ Checkliste)', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: /Generator/ }))
    cleanup()
    await mount()
    expect(screen.getByText('Hauptschalter auf 0')).toBeTruthy()
  })
})
