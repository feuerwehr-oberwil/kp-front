// @vitest-environment jsdom
// Doors a session cannot go through are not drawn (3am test on staging, 25.09.2026 — the `el`
// role was offered actions that answered with a 403 or led to a surface that disarmed them).
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import type { ChecklistTemplate } from '../lib/checklists'
import { fillTemplate } from '../lib/format'

vi.mock('../lib/incidents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/incidents')>()),
  listIncidents: async () => [{
    id: 'a1', title: 'Brand Scheune', status: 'abgeschlossen', is_archived: true, is_exercise: false,
    address: 'Musterweg 1', started_at: '2026-09-20T10:00:00Z',
  }],
}))

import { HistoryPanel } from './panels/HistoryPanel'
import { ChecklistRunner } from './ChecklistRunner'

afterEach(cleanup)

describe('«Alle Einsätze» · «Wieder öffnen» is the lifecycle, gated with «Abschliessen»', () => {
  const reopen = appConfig.copy.history.reactivate

  it('an editor (onArchive given) can reopen an archived Einsatz', async () => {
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} onArchive={async () => {}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: reopen })).toBeTruthy())
  })

  it('⚠️ an el / viewer gets the list without the door (PATCH is_archived is editor-only)', async () => {
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText('Brand Scheune')).toBeTruthy())
    expect(screen.queryByRole('button', { name: reopen })).toBeNull()
  })
})

// #449
describe('«Alle Einsätze» · a viewer is told its window', () => {
  const h = appConfig.copy.history

  it('says which Einsätze the list holds, under the list', async () => {
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} windowDays={7} />)
    await waitFor(() => expect(screen.getByText('Brand Scheune')).toBeTruthy())
    expect(screen.getByText(fillTemplate(h.windowNote, { n: 7 }))).toBeTruthy()
  })

  it('says nothing of the kind to an account the server does not narrow', async () => {
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} />)
    await waitFor(() => expect(screen.getByText('Brand Scheune')).toBeTruthy())
    expect(screen.queryByText(fillTemplate(h.windowNote, { n: 7 }))).toBeNull()
  })
})

describe('Checkliste · a deep link the session cannot follow is not drawn', () => {
  const template = {
    id: 't', title: 'FU', phases: [{
      id: 'p', title: 'Erste Minuten', items: [
        { id: 'i1', text: 'Zufahrt einzeichnen', action: 'draw' },
        { id: 'i2', text: 'Lage im Journal', action: 'journal' },
      ],
    }],
  } as unknown as ChecklistTemplate
  const labels = appConfig.copy.checklists.actionLabels

  const setup = (offersAction?: (a: 'journal' | 'plan' | 'draw') => boolean) => render(
    <ChecklistRunner template={template} state={{ ticks: {} }} canTick onToggle={() => {}} onBranch={() => {}}
      onAction={() => {}} offersAction={offersAction} />,
  )

  it('every link by default', () => {
    setup()
    expect(screen.getByRole('button', { name: labels.draw })).toBeTruthy()
    expect(screen.getByRole('button', { name: labels.journal })).toBeTruthy()
  })

  it('⚠️ «Zeichnen» gone on a tactically locked device, «Journal» stays', () => {
    setup((a) => a !== 'draw')
    expect(screen.queryByRole('button', { name: labels.draw })).toBeNull()
    expect(screen.getByRole('button', { name: labels.journal })).toBeTruthy()
  })
})
