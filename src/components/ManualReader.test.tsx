// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ManualReader } from './ManualReader'
import { ChecklistsView } from './ChecklistsView'
import { warmTemplates, type ChecklistTemplate } from '../lib/checklists'
import { useMediaQuery } from '../lib/useIsPhone'
import { openPhoto } from '../lib/ui'
import { appConfig } from '../config/appConfig'

// Anleitungen (kind: manual, 05.10.2026): read-only numbered steps, grouped by device in the
// Checkliste picker. Pinned: nothing to tick, the step pictures open the ONE picture viewer, and
// the picker shows one row per device (19.10.2026) and finds a manual by its device.

vi.mock('../lib/ui', () => ({ openPhoto: vi.fn() }))
vi.mock('../lib/checklists', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/checklists')>(),
  warmTemplates: vi.fn(),
}))
vi.mock('../lib/useIsPhone', () => ({ useMediaQuery: vi.fn() }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const MANUAL: ChecklistTemplate = {
  id: 'stromerzeuger', kind: 'manual', title: 'Stromerzeuger starten', device: 'Stromerzeuger 8 kVA',
  version: 1, updated: '2026-10-05', source: 'Demo',
  steps: [
    { text: 'Standort wählen', warning: 'Nie in geschlossenen Räumen', details: ['im Freien', 'eben'] },
    { text: 'Choke schliessen', hint: 'Nur bei kaltem Motor', images: [{ page: 1, caption: 'Bedienfeld' }] },
  ],
}

describe('ManualReader', () => {
  it('renders numbered steps with warning, hint, device and date — and nothing to tick', () => {
    const { container } = render(<ManualReader manual={MANUAL} />)
    expect([...container.querySelectorAll('ol > li')].map((li) => li.textContent?.slice(0, 2))).toEqual(['1S', '2C'])
    expect(screen.getByText('Nie in geschlossenen Räumen')).toBeTruthy()
    expect(screen.getByText('Nur bei kaltem Motor')).toBeTruthy()
    expect([...container.querySelectorAll('ol > li:first-child ul > li')].map((li) => li.textContent)).toEqual(['im Freien', 'eben'])
    expect(screen.getByText(/Stromerzeuger 8 kVA · Stand 05\.10\.2026/)).toBeTruthy()
    expect(container.querySelector('input, [role="checkbox"]')).toBeNull()
  })

  it('opens a step picture in the shared viewer', () => {
    render(<ManualReader manual={MANUAL} />)
    fireEvent.click(screen.getByRole('button', { name: `${appConfig.copy.checklists.manualImageOpen}: Bedienfeld` }))
    expect(openPhoto).toHaveBeenCalledWith('/api/reference/checklists:stromerzeuger:p1', expect.objectContaining({ download: false }))
  })
})

describe('Checkliste picker · Anleitungen', () => {
  const noop = () => {}
  const mount = async (templates: ChecklistTemplate[]) => {
    vi.mocked(useMediaQuery).mockReturnValue(false)
    vi.mocked(warmTemplates).mockReturnValue({ list: Promise.resolve(templates), newer: null })
    const view = render(<ChecklistsView checklists={{}} canTick divera={{}} onTick={noop} onBranch={noop} onAction={noop} />)
    await act(async () => {})
    return view
  }
  const FU: ChecklistTemplate = {
    id: 'fu', kind: 'action', title: 'Aufgaben FU', version: 1, source: 'x',
    phases: [{ id: 'p', title: 'P', items: [{ id: 'i', text: 'Item' }] }],
  }

  const CHAPTER = (n: number): ChecklistTemplate => ({
    id: `ms-${n}`, kind: 'manual', title: `Kapitel-Titel ${n}`, device: 'Motorspritze', version: 1, source: 'x',
    steps: [{ text: `Schritt aus ${n}` }],
  })

  it('lists one row per device, LAST, never among the tick lists', async () => {
    const { container } = await mount([MANUAL, FU, CHAPTER(1), CHAPTER(2)])
    const labels = [...container.querySelectorAll('nav [class*="cl-rail-label"]')].map((l) => l.textContent)
    expect(labels[labels.length - 1]).toBe(appConfig.copy.checklists.groupManuals)
    // the single Anleitung's device says its title, the device with chapters «2 Kapitel»
    expect(screen.getByRole('button', { name: /Stromerzeuger 8 kVA.*Stromerzeuger starten/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Motorspritze.*2 Kapitel/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Kapitel-Titel/ })).toBeNull()
  })

  it('opens a single Anleitung directly and finds it by its device', async () => {
    await mount([FU, MANUAL])
    fireEvent.click(screen.getByRole('button', { name: /Stromerzeuger 8 kVA/ }))
    expect(screen.getByText('Standort wählen')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(appConfig.copy.checklists.searchAria), { target: { value: 'kva' } })
    expect(screen.queryByRole('button', { name: /Aufgaben FU/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Stromerzeuger 8 kVA/ })).toBeTruthy()
  })

  it('opens a device page, a chapter with «Kapitel k von n», and the next chapter from its foot', async () => {
    await mount([FU, CHAPTER(1), CHAPTER(2)])
    fireEvent.click(screen.getByRole('button', { name: /Motorspritze/ }))
    fireEvent.click(screen.getByRole('button', { name: /Kapitel-Titel 1/ }))
    expect(screen.getByText('Schritt aus 1')).toBeTruthy()
    expect(screen.getByText(/Kapitel 1 von 2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Kapitel 2.*Kapitel-Titel 2/ }))
    expect(screen.getByText('Schritt aus 2')).toBeTruthy()
    // the device name in the meta line leads back to the chapter page
    fireEvent.click(screen.getByRole('button', { name: 'Motorspritze' }))
    expect(screen.getByRole('list', { name: 'Motorspritze' })).toBeTruthy()
  })
})
