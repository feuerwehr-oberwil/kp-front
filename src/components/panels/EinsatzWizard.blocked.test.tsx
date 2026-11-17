// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import { patchIncident, type IncidentMeta } from '../../lib/incidents'
import { clearAllDrafts } from '../../lib/draftKeep'

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
// the wizard keeps a half-typed form across unmounts (lib/draftKeep) – each test starts blank
afterEach(() => { cleanup(); clearAllDrafts() })

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
describe('one verb on the create form, and «Übung» once the kind says so', () => {
  it('says «Einsatz eröffnen», then «Übung eröffnen», in the title and on the button alike', () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    expect(screen.getByRole('heading', { name: ix.titleNew })).toBeTruthy()
    expect(screen.getByRole('button', { name: ix.open })).toBeTruthy()
    expect(ix.open).toBe(ix.titleNew)
    fireEvent.click(within(screen.getByRole('group', { name: ix.kindLabel }))
      .getByRole('button', { name: ix.exerciseLabel }))
    expect(screen.getByRole('heading', { name: ix.titleNewExercise })).toBeTruthy()
    expect(screen.getByRole('button', { name: ix.openExercise })).toBeTruthy()
  })
})

// C7 (17.11.2026): the kind was an «Übung? Nein | Ja» switch under Kategorie and got missed
describe('«Ernstfall | Übung» is the first question of the form', () => {
  const kind = () => within(screen.getByRole('group', { name: ix.kindLabel })).getAllByRole('button')

  it('comes before every field, «Ernstfall» preselected', () => {
    const { container } = render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    const first = container.querySelector('.ip-kind, .ip-field, label')
    expect(first?.classList.contains('ip-kind')).toBe(true)
    expect(kind().map((b) => [b.textContent, b.getAttribute('aria-pressed')]))
      .toEqual([[ix.kindReal, 'true'], [ix.exerciseLabel, 'false']])
  })

  it('shows an Übung as «Übung» when editing', () => {
    render(<EinsatzWizard edit={{ ...edit, is_exercise: true }} onClose={() => {}} onCreated={() => {}} />)
    expect(kind().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
  })
})
