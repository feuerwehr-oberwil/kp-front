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
// the picker finds a manual by its device.

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

  it('lists manuals in their own group, under their device, never among the tick lists', async () => {
    await mount([FU, MANUAL])
    expect(screen.getByText(appConfig.copy.checklists.groupManuals)).toBeTruthy()
    const device = screen.getByRole('group', { name: 'Stromerzeuger 8 kVA' })
    expect(device.textContent).toContain('Stromerzeuger starten')
    expect(screen.getAllByRole('button', { name: /Stromerzeuger starten/ })).toHaveLength(1)
  })

  it('opens the reader on pick and finds the manual by its device', async () => {
    await mount([FU, MANUAL])
    fireEvent.click(screen.getByRole('button', { name: /Stromerzeuger starten/ }))
    expect(screen.getByText('Standort wählen')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(appConfig.copy.checklists.searchAria), { target: { value: 'kva' } })
    expect(screen.queryByRole('button', { name: /Aufgaben FU/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Stromerzeuger starten/ })).toBeTruthy()
  })
})
