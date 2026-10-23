// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import { patchIncident, type IncidentMeta } from '../../lib/incidents'

// UX sweep F2 (20.10.2026): a save the wizard cannot make yet stays tappable (aria-disabled) and
// points at the field that holds it back — it used to sit there grey behind a native `disabled`.

vi.mock('../../lib/incidents', () => ({
  createIncident: vi.fn(), patchIncident: vi.fn(),
  getIncident: vi.fn(() => Promise.resolve({ text: '' })),
  listObjects: vi.fn(() => Promise.resolve([])),
  geocodeSearch: vi.fn(() => Promise.resolve([])),
  geocodeReverse: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../MapPicker', () => ({ MapPicker: () => null }))
// the Sheet portals and traps focus; title + body + footer as plain markup is all this needs
vi.mock('./_shared', async (orig) => ({
  ...(await orig<typeof import('./_shared')>()),
  Modal: ({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) =>
    <div><h2>{title}</h2>{children}{footer}</div>,
}))

const { EinsatzWizard } = await import('./EinsatzWizard')
const ix = appConfig.copy.intake
afterEach(cleanup)

const edit = {
  id: 'i1', title: 'Gebäudebrand Schulhaus', address: 'Schulstrasse 4', started_at: '2026-09-18T03:14:00.000Z', lng: 7.55, lat: 47.48,
} as unknown as IncidentMeta

describe('«Speichern» with the Stichwort emptied', () => {
  it('saves nothing, rings the Stichwort and puts the caret in it', () => {
    render(<EinsatzWizard edit={edit} onClose={() => {}} onCreated={() => {}} />)
    const input = screen.getByDisplayValue('Gebäudebrand Schulhaus')
    fireEvent.change(input, { target: { value: '' } })
    const save = screen.getByRole('button', { name: ix.save })
    expect(save.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(save)
    expect(patchIncident).not.toHaveBeenCalled()
    expect(input.closest('label')?.classList.contains('field-flash')).toBe(true)
    expect(document.activeElement).toBe(input)
  })
})

// sweep F.8 (23.10.2026): the title said «eröffnen», the button «öffnen», and «Übung: Ja» changed neither
describe('one verb on the create form, and «Übung» once the switch says so', () => {
  it('says «Einsatz eröffnen», then «Übung eröffnen», in the title and on the button alike', () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    expect(screen.getByRole('heading', { name: ix.titleNew })).toBeTruthy()
    expect(screen.getByRole('button', { name: ix.open })).toBeTruthy()
    expect(ix.open).toBe(ix.titleNew)
    fireEvent.click(within(screen.getByRole('group', { name: ix.exerciseLabel }))
      .getByRole('button', { name: appConfig.copy.drawingEditor.yes }))
    expect(screen.getByRole('heading', { name: ix.titleNewExercise })).toBeTruthy()
    expect(screen.getByRole('button', { name: ix.openExercise })).toBeTruthy()
  })
})
