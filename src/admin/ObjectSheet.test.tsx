// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { webcrypto } from 'node:crypto'
import type { ObjectWithPlans, ReferenceDataset } from '../lib/incidents'

// jsdom ships a Crypto without `subtle`; the id derivation is real WebCrypto, so lend it Node's.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

// Only the network calls are mocked — the uuid5 derivation and the slot logic are the point.
const saveObject = vi.fn()
const uploadPlan = vi.fn()
vi.mock('./stationDataApi', async () => {
  const actual = await vi.importActual<typeof import('./stationDataApi')>('./stationDataApi')
  return {
    ...actual,
    saveObject: (id: string, body: unknown) => saveObject(id, body),
    uploadPlan: (o: string, m: string, f: File) => uploadPlan(o, m, f),
  }
})

import { ObjectSheet, planSlots, parseCoords } from './ObjectSheet'

const OBJ_ID = '0f1a3d64-1111-5222-8333-444455556666'

const plan = (over: Partial<ReferenceDataset> = {}): ReferenceDataset => ({
  id: `plan:${OBJ_ID}:modul3`,
  object_id: OBJ_ID,
  module: 'modul3',
  kind: 'pdf',
  title: 'Schulhaus – modul3',
  source_type: 'uploaded',
  source_note: 'modul3.pdf',
  content_type: 'application/pdf',
  size_bytes: 12345,
  feature_count: null,
  current_version: 1,
  updated_at: '2026-08-16T10:00:00Z',
  ...over,
})

const existing = (over: Partial<ObjectWithPlans> = {}): ObjectWithPlans => ({
  id: OBJ_ID,
  name: 'Schulhaus Dorfmatt',
  address: 'Schulstrasse 4',
  lat: 47.4712,
  lng: 7.5501,
  source_note: null,
  updated_at: '2026-08-16T10:00:00Z',
  plans: [],
  distance_m: null,
  ...over,
})

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

const pdfInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))

// ⚠️ Not getByLabelText: a `Field` with a `tip` wraps BOTH the input and the InfoTip trigger
// (aria-label "Info: <label>") in one <label>, and the query resolves to the button. The
// placeholders are the unambiguous handle on the inputs those fields actually own.
const keyInput = () => screen.getByPlaceholderText('schulhaus-dorfmatt')
const latInput = () => screen.getByPlaceholderText('47.4712')
const lngInput = () => screen.getByPlaceholderText('7.5501')

describe('ObjectSheet — a new Einsatzobjekt is addressed by its key, never by a typed UUID', () => {
  it('derives the id from the key and PUTs to it', async () => {
    saveObject.mockResolvedValue({ ...existing(), id: 'f4db7b86-e0fb-5ba7-856d-8e356d2ff3af' })
    render(<ObjectSheet object={null} onClose={() => {}} onChanged={() => {}} />)

    fireEvent.change(keyInput(), { target: { value: 'schulhaus-dorfmatt' } })
    // the same uuid5 admin_objects would derive — shown before anything is written
    await screen.findByText('f4db7b86-e0fb-5ba7-856d-8e356d2ff3af')

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Schulhaus Dorfmatt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))

    await waitFor(() => expect(saveObject).toHaveBeenCalledTimes(1))
    expect(saveObject.mock.calls[0][0]).toBe('f4db7b86-e0fb-5ba7-856d-8e356d2ff3af')
    expect(saveObject.mock.calls[0][1]).toMatchObject({ name: 'Schulhaus Dorfmatt' })
  })

  it('refuses LV95 metres instead of dropping the object somewhere off the planet', async () => {
    render(<ObjectSheet object={null} onClose={() => {}} onChanged={() => {}} />)
    fireEvent.change(keyInput(), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } })
    fireEvent.change(latInput(), { target: { value: '1259000' } })
    fireEvent.change(lngInput(), { target: { value: '2612000' } })

    expect(await screen.findByText(/LV95-Metern/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Speichern' })).toHaveProperty('disabled', true)
    expect(saveObject).not.toHaveBeenCalled()
  })

  it('cannot attach plans before the object exists, and says so', () => {
    render(<ObjectSheet object={null} onClose={() => {}} onChanged={() => {}} />)
    expect(screen.getByText(/sobald das Objekt gespeichert ist/)).toBeTruthy()
    expect(pdfInputs()).toHaveLength(0)
  })
})

describe('ObjectSheet — a corrected PDF replaces the module plan', () => {
  it('uploads to the same module slot and shows the bumped version, not a second plan', async () => {
    const onChanged = vi.fn()
    uploadPlan.mockResolvedValue(plan({ current_version: 2, size_bytes: 22222 }))
    render(<ObjectSheet object={existing({ plans: [plan()] })} onClose={() => {}} onChanged={onChanged} />)

    expect(screen.getByText(/^v1 ·/)).toBeTruthy()
    // the modul3 row already holds a plan, so its button offers a replacement
    const replace = screen.getAllByRole('button', { name: 'PDF ersetzen' })
    expect(replace).toHaveLength(1)

    const file = new File(['%PDF-1.7 corrected'], 'modul3-korrigiert.pdf', { type: 'application/pdf' })
    const input = replace[0].parentElement?.querySelector<HTMLInputElement>('input[type="file"]')
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } })

    await waitFor(() => expect(uploadPlan).toHaveBeenCalledTimes(1))
    expect(uploadPlan.mock.calls[0].slice(0, 2)).toEqual([OBJ_ID, 'modul3'])

    await screen.findByText(/^v2 ·/)
    expect(screen.queryByText(/^v1 ·/)).toBeNull()
    // exactly one modul3 row survives — the dataset id is the module, so the server replaced it
    const lastChange = onChanged.mock.calls[onChanged.mock.calls.length - 1]
    expect(lastChange[0].plans).toHaveLength(1)
  })
})

describe('planSlots', () => {
  const mods = [
    { id: 'modul1', code: 'M1', title: 'Übersicht', order: 1 },
    { id: 'modul5', code: 'M5', title: 'Spezialpläne', order: 5, family: true },
  ]

  it('gives every catalogue module a slot and fills the one that has a plan', () => {
    const slots = planSlots(mods, [plan({ module: 'modul1' })])
    expect(slots.map((s) => s.id)).toEqual(['modul1'])
    expect(slots[0].plan?.current_version).toBe(1)
  })

  it('expands a family module into one slot per stored sub-slot', () => {
    const slots = planSlots(mods, [plan({ module: 'modul5-wasser' }), plan({ module: 'modul5-pv' })])
    expect(slots.map((s) => s.id)).toEqual(['modul1', 'modul5-pv', 'modul5-wasser'])
  })

  it('still shows a plan whose module the catalogue dropped, flagged as off-catalogue', () => {
    const slots = planSlots(mods, [plan({ module: 'modul9' })])
    expect(slots.find((s) => s.id === 'modul9')?.offCatalogue).toBe(true)
  })
})

describe('parseCoords', () => {
  const msg = { coordsPair: 'pair', coordsInvalid: 'invalid', coordsProjected: 'projected' }
  it('accepts an empty pair — coordinates are optional', () => {
    expect(parseCoords('', '', msg)).toEqual({ ok: true, lat: null, lng: null })
  })
  it('accepts a comma decimal separator', () => {
    expect(parseCoords('47,4712', '7,5501', msg)).toEqual({ ok: true, lat: 47.4712, lng: 7.5501 })
  })
  it('refuses half a pair', () => {
    expect(parseCoords('47.4712', '', msg)).toEqual({ ok: false, error: 'pair' })
  })
  it('names LV95 metres specifically, rather than "invalid"', () => {
    expect(parseCoords('1259000', '2612000', msg)).toEqual({ ok: false, error: 'projected' })
  })
  it('refuses a latitude outside ±90', () => {
    expect(parseCoords('147', '7.55', msg)).toEqual({ ok: false, error: 'invalid' })
  })
})
