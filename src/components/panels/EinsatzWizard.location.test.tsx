// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react'
import { getIncident, geocodeSearch, patchIncident } from '../../lib/incidents'
import { appConfig } from '../../config/appConfig'
import { clearAllDrafts, keepDraft } from '../../lib/draftKeep'
import type { GeoHit, IncidentMeta, IncidentFull, ObjectWithPlans } from '../../lib/incidents'
import { fillTemplate } from '../../lib/format'

// The location on the Einsatz form (owner picks 1A + round 2, 15.11.2026): every method rides the
// address field, ONE list under it holds the typed objects and addresses, and the coordinate itself
// is no longer shown – only its ABSENCE is, as one warning line under the field.

const obj = (id: string, name: string, address: string, distance_m: number) =>
  ({ id, name, address, distance_m, lng: 7.56, lat: 47.49, plans: [] }) as unknown as ObjectWithPlans
const DEPOT = obj('o1', 'Tramdepot', 'Grenzweg 1, 9999 Musterdorf', 120)
const SCHOOL = obj('o2', 'Schulhaus Mitte', 'Schulstrasse 4, 9999 Musterdorf', 2400)
const HIT: GeoHit = { label: 'Grenzweg 3, 9999 Musterdorf', lng: 7.561, lat: 47.491 } as GeoHit

// the network and the map are not what is being tested
vi.mock('../../lib/incidents', () => ({
  createIncident: vi.fn(), patchIncident: vi.fn(),
  getIncident: vi.fn(() => Promise.resolve({ text: '' })),
  listObjects: vi.fn(() => Promise.resolve([DEPOT, SCHOOL])),
  geocodeSearch: vi.fn(() => Promise.resolve([HIT])),
  geocodeReverse: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../MapPicker', () => ({ MapPicker: () => null }))
// the Sheet portals and traps focus; the field is plain markup inside it
vi.mock('./_shared', async (orig) => ({
  ...(await orig<typeof import('./_shared')>()),
  Modal: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => <div>{children}{footer}</div>,
}))

const { EinsatzWizard } = await import('./EinsatzWizard')

const ix = appConfig.copy.intake
// a typed address is kept as a draft (lib/draftKeep) – it must not open the next test's form
afterEach(() => { cleanup(); clearAllDrafts() })

const BASE = {
  id: 'i1', title: 'Gebäudebrand Schulhaus', address: 'Schulstrasse 4' as string | null,
  started_at: '2026-09-18T03:14:00.000Z', lng: 7.55 as number | null, lat: 47.48 as number | null,
}
const meta = (over: Partial<typeof BASE>): IncidentMeta => ({ ...BASE, ...over }) as unknown as IncidentMeta
const warning = () => screen.queryByText(ix.coordMissing)
const field = () => screen.getByPlaceholderText(ix.addressPlaceholder)
const group = (label: string) => screen.findByRole('region', { name: label })

describe('the one list under the address field', () => {
  it('shows the matching objects and the addresses for one query, objects first', async () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    fireEvent.change(field(), { target: { value: 'Grenzweg' } })
    const objects = await group(ix.objectsGroup)
    const addresses = await group(ix.addressGroup)
    expect(within(objects).getByRole('button', { name: /Tramdepot/ })).toBeTruthy()
    expect(within(objects).queryByRole('button', { name: /Schulhaus/ })).toBeNull()
    expect(addresses.contains(await screen.findByRole('button', { name: /Grenzweg 3/ }))).toBe(true)
    expect(objects.compareDocumentPosition(addresses) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // no second search field anywhere – the object picker's own went (round 2)
    expect(document.querySelector('.ui-search')).toBeNull()
  })

  // «Aus Plänen» went (owner, 15.11.2026: «the map and current location are enough») – an
  // object is found by typing, and a tap into the empty field drops no list over the form
  it('has no «Aus Plänen» button, and a tap into the empty field opens nothing', async () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Aus Plänen' })).toBeNull()
    fireEvent.focus(field())
    await Promise.resolve()
    expect(screen.queryByRole('button', { name: /Tramdepot/ })).toBeNull()
  })
})

// Duck sweep LISTS.1, 17.11.2026: a failed lookup said «Keine Adresse gefunden»
describe('the address search tells «failed» from «nothing found»', () => {
  it('a failed lookup says so, and is not a no-hit line', async () => {
    vi.mocked(geocodeSearch).mockRejectedValueOnce(new Error('502'))
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    fireEvent.change(field(), { target: { value: 'Hauptstrasse' } })
    expect(await screen.findByText(ix.addressFailed)).toBeTruthy()
    expect(screen.queryByText(/Keine Treffer/)).toBeNull()
  })
  it('an answer with nothing in it is the shared no-hit line', async () => {
    vi.mocked(geocodeSearch).mockResolvedValueOnce([])
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    fireEvent.change(field(), { target: { value: 'Hauptstrasse' } })
    expect(await screen.findByText(fillTemplate(appConfig.copy.noHits, { q: 'Hauptstrasse' }))).toBeTruthy()
  })
})

describe('«Noch kein Standort»', () => {
  it('says nothing when the Einsatz has a coordinate', () => {
    render(<EinsatzWizard edit={meta({})} onClose={() => {}} onCreated={() => {}} />)
    expect(warning()).toBeNull()
  })

  // an address typed by hand is not a location: the warning follows the COORDINATE
  it('shows on an Einsatz with an address but no coordinate', () => {
    render(<EinsatzWizard edit={meta({ lng: null, lat: null })} onClose={() => {}} onCreated={() => {}} />)
    expect(warning()).toBeTruthy()
  })

  it('shows on a blank create, and goes once an object gives the form a coordinate', async () => {
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    expect(warning()).toBeTruthy()
    fireEvent.change(field(), { target: { value: 'Tramdepot' } })
    fireEvent.click(await screen.findByRole('button', { name: /Tramdepot/ }))
    expect(warning()).toBeNull()
    expect((field() as HTMLInputElement).value).toBe(DEPOT.address)
  })
})

describe('saving dispatch corrections', () => {
  afterEach(() => { vi.mocked(geocodeSearch).mockReset().mockResolvedValue([HIT]) })
  const edit: IncidentMeta = { ...meta({}), type: 'Brand', alarm_update: {
    state: 'pending', at: BASE.started_at, title: null, lat: null, lng: null,
    fields: [{ field: 'address', alarm: 'New street 8', current: BASE.address, edited: false }],
  } }
  async function open(incident = edit) {
    vi.mocked(patchIncident).mockClear().mockImplementation(() => new Promise(() => {}))
    vi.mocked(getIncident).mockResolvedValueOnce({ text: 'Initial alarm' } as IncidentFull)
    const form = render(<EinsatzWizard edit={incident} onClose={() => {}} onCreated={() => {}} />)
    await screen.findByDisplayValue('Initial alarm')
    return form
  }
  it.each(['hit', 'miss', 'offline'])('resolves the accepted address before saving (%s)', async (outcome) => {
    let resolve!: (value: GeoHit[]) => void
    let reject!: () => void
    vi.mocked(geocodeSearch).mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no }))
    await open()
    fireEvent.click(screen.getByText(ix.alarmUpdate.take))
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).not.toHaveBeenCalled()
    await act(async () => { if (outcome === 'offline') reject(); else resolve(outcome === 'hit' ? [HIT] : []) })
    if (outcome !== 'hit') expect(warning()).toBeTruthy()
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).toHaveBeenCalledWith(edit.id, {
      address: 'New street 8', lng: outcome === 'hit' ? HIT.lng : null, lat: outcome === 'hit' ? HIT.lat : null,
    })
  })
  it('resumes a dismissed dispatch lookup and waits for the new answer before saving', async () => {
    let finishFirst!: (value: GeoHit[]) => void
    let finishSecond!: (value: GeoHit[]) => void
    vi.mocked(geocodeSearch)
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve }))
    const first = await open()
    fireEvent.click(screen.getByText(ix.alarmUpdate.take))
    first.unmount()
    await open()
    expect(screen.getByText(ix.addressSearching)).toBeTruthy()
    await act(async () => finishFirst([]))
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).not.toHaveBeenCalled()
    await act(async () => finishSecond([HIT]))
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).toHaveBeenCalledWith(edit.id, { address: 'New street 8', lat: HIT.lat, lng: HIT.lng })
  })
  it('reopening a completed miss leaves the address unlocated without another lookup', async () => {
    vi.mocked(geocodeSearch).mockResolvedValueOnce([])
    const first = await open()
    fireEvent.click(screen.getByText(ix.alarmUpdate.take))
    await screen.findByText(ix.coordMissing)
    first.unmount()
    vi.mocked(geocodeSearch).mockClear()
    await open()
    expect(geocodeSearch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).toHaveBeenCalledWith(edit.id, { address: 'New street 8', lat: null, lng: null })
  })
  it('clearing an accepted address cancels the lookup across dismissal', async () => {
    vi.mocked(geocodeSearch).mockImplementationOnce(() => new Promise(() => {}))
    const first = await open()
    fireEvent.click(screen.getByText(ix.alarmUpdate.take))
    fireEvent.change(field(), { target: { value: '' } })
    first.unmount()
    vi.mocked(geocodeSearch).mockClear()
    await open()
    expect(geocodeSearch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).toHaveBeenCalledWith(edit.id, { address: null, lat: null, lng: null })
  })
  it('uses the alarm coordinates directly, including a coordinate unchanged on one axis', async () => {
    const update = { ...edit.alarm_update!, lng: BASE.lng, lat: HIT.lat }
    await open({ ...edit, alarm_update: update })
    fireEvent.click(screen.getByText(ix.alarmUpdate.take))
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).toHaveBeenCalledWith(edit.id, { address: 'New street 8', lng: BASE.lng, lat: HIT.lat })
  })
  it.each(['dispatch', 'geocoder', 'unlocated'] as const)('submits the accepted address and its unchanged %s pin together', async (source) => {
    const coords = source === 'unlocated' ? { lng: null, lat: null } : { lng: HIT.lng, lat: HIT.lat }
    const update = source === 'dispatch' ? { ...edit.alarm_update!, ...coords } : edit.alarm_update
    vi.mocked(geocodeSearch).mockResolvedValue(source === 'geocoder' ? [HIT] : [])
    await open({ ...edit, ...coords, alarm_update: update })
    fireEvent.click(screen.getByText(ix.alarmUpdate.take))
    await waitFor(() => expect((screen.getByText(ix.save) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).toHaveBeenCalledWith(edit.id, { address: 'New street 8', ...coords })
  })
  it('restores the explicitly accepted pin if the server pin moved before reopening the draft', async () => {
    const update = { ...edit.alarm_update!, lng: BASE.lng, lat: BASE.lat }
    const first = await open({ ...edit, alarm_update: update })
    fireEvent.click(screen.getByText(ix.alarmUpdate.take))
    first.unmount()
    await open({ ...edit, lng: HIT.lng, lat: HIT.lat })
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).toHaveBeenCalledWith(edit.id, { address: 'New street 8', lng: BASE.lng, lat: BASE.lat })
  })
  it('keeps the pin out of a typed address correction without a location pick', async () => {
    await open()
    fireEvent.change(field(), { target: { value: 'Typed street 3' } })
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).toHaveBeenCalledWith(edit.id, { address: 'Typed street 3' })
  })
  it('a later explicit pick outranks a pending lookup', async () => {
    let resolve!: (value: GeoHit[]) => void
    vi.mocked(geocodeSearch).mockImplementationOnce(() => new Promise((yes) => { resolve = yes }))
    await open()
    fireEvent.click(screen.getByText(ix.alarmUpdate.take))
    fireEvent.change(field(), { target: { value: 'Tramdepot' } })
    fireEvent.click(await screen.findByRole('button', { name: /Tramdepot/ }))
    await act(async () => resolve([HIT]))
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).toHaveBeenCalledWith(edit.id, { address: DEPOT.address, lng: DEPOT.lng, lat: DEPOT.lat })
  })
  it('restores a picked location beside the draft only while the page stays open', async () => {
    const form = () => render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    const first = form()
    fireEvent.change(field(), { target: { value: 'Tramdepot' } })
    fireEvent.click(await screen.findByRole('button', { name: /Tramdepot/ }))
    first.unmount()
    const stored = sessionStorage.getItem('kp-draft:einsatz-wizard:new')
    if (!stored) throw new Error('missing wizard text draft')
    expect(JSON.parse(stored)).not.toHaveProperty('coord')
    const reopened = form()
    expect(warning()).toBeNull()
    reopened.unmount()
    // A reload restores the serialized text into a fresh page; the picked position has gone.
    clearAllDrafts()
    sessionStorage.setItem('kp-draft:einsatz-wizard:new', stored)
    form()
    expect((field() as HTMLInputElement).value).toBe(DEPOT.address)
    expect(warning()).toBeTruthy()
  })
  it('an older draft without coordinates does not clear a pin supplied by another device', async () => {
    keepDraft('einsatz-wizard:i1', { title: 'Draft title', address: BASE.address, kategorie: 'Brand', coord: null, isExercise: false })
    await open()
    expect(warning()).toBeNull()
    fireEvent.click(screen.getByText(ix.save))
    expect(patchIncident).toHaveBeenCalledWith(edit.id, { title: 'Draft title' })
  })
  it('sends an intentionally cleared message', async () => {
    await open()
    fireEvent.change(screen.getByDisplayValue('Initial alarm'), { target: { value: '' } })
    fireEvent.click(screen.getByText(ix.save))
    await waitFor(() => expect(patchIncident).toHaveBeenCalledWith(edit.id, { text: null }))
  })
})

// toast diet, 17.11.2026: «Hier» without a position is said in the field's warning slot, not as a
// toast over the open form – and it ends once anything else gives the form a coordinate
describe('«Hier» finds no position', () => {
  const failGeo = () => vi.stubGlobal('navigator', {
    ...navigator,
    geolocation: { getCurrentPosition: (_ok: unknown, fail: () => void) => fail() },
  })
  afterEach(() => vi.unstubAllGlobals())

  it('says «Standort nicht verfügbar» under the address field', () => {
    failGeo()
    render(<EinsatzWizard edit={meta({})} onClose={() => {}} onCreated={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: ix.hereButton }))
    expect(screen.getByText(ix.hereFailed).closest('.form-warn')).toBeTruthy()
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('goes once an object gives the form a coordinate', async () => {
    failGeo()
    render(<EinsatzWizard onClose={() => {}} onCreated={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: ix.hereButton }))
    expect(screen.getByText(ix.hereFailed)).toBeTruthy()
    fireEvent.change(field(), { target: { value: 'Tramdepot' } })
    fireEvent.click(await screen.findByRole('button', { name: /Tramdepot/ }))
    expect(screen.queryByText(ix.hereFailed)).toBeNull()
  })
})
