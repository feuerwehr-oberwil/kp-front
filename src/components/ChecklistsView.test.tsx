// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { ChecklistsView } from './ChecklistsView'
import { warmTemplates, type ChecklistTemplate } from '../lib/checklists'
import { useMediaQuery } from '../lib/useIsPhone'
import { appConfig } from '../config/appConfig'

vi.mock('../lib/checklists', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/checklists')>(),
  warmTemplates: vi.fn(),
}))
vi.mock('../lib/useIsPhone', () => ({ useMediaQuery: vi.fn() }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Checklist chooser loading', () => {
  it.each([true, false])('shows one loader in the visible rail (narrow: %s) until templates settle', async narrow => {
    vi.mocked(useMediaQuery).mockReturnValue(narrow)
    let resolve!: (templates: ChecklistTemplate[]) => void
    vi.mocked(warmTemplates).mockReturnValue({ list: new Promise(done => { resolve = done }), newer: null })
    const noop = () => {}
    const { container } = render(<ChecklistsView checklists={{}} canTick divera={{}}
      onTick={noop} onBranch={noop} onAction={noop} />)
    expect(within(screen.getByRole('navigation')).getByRole('status').textContent).toBe(appConfig.copy.loading)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(container.querySelector('.no-hits')).toBeNull()
    if (narrow) expect(container.querySelector('main')).toBeNull()
    await act(async () => resolve([]))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(appConfig.copy.checklists.none)).toBeTruthy()
  })
})
