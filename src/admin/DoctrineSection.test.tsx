// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// «Doktrin» — the Atemschutz numbers and the optional station colour per Auftrag. It had no test
// at all, which is how two controls on it came to write documents the API refuses outright:
//
//   · «Automatisch» wrote `doctrine.auftragColors.<id> = null` into a `dict[str, str] | None`
//     (schemas.py:791). A key with a null value is a `string_type` 422 — and because the config
//     is ONE document with a 700 ms autosave, that 422 stops the autosave for every Station page
//     at once. Worse, «Automatisch» is the ALREADY-ACTIVE button on every untouched row: the one
//     control that reads as «leave this alone» was the one that wedged the whole config, and the
//     way out (pick a colour again) is not discoverable from it.
//   · the number boxes carried `step="any"` over `int | None` fields, so «8.5» reached the draft
//     and came back as `int_from_float`; `cylinderLiters` (gt=0, le=30) was unguarded entirely.
//
// The rule these now follow is the one the map centre and the three Alarm-Uhren already follow:
// a value the API would refuse stays in local state with a German line saying why, and the
// stored document — every section of it — is left alone meanwhile.

const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, ApiError }))

import { ConfigProvider } from './ConfigContext'
import { DoctrineSection } from './ConfigSections'
import { appConfig } from '../config/appConfig'
import { expectAccepted } from './configSchema.test-utils'

const N = appConfig.copy.admin.numbers
const AUTO = appConfig.copy.atemschutz.colorAuto
const [BLAU, ROT] = appConfig.drawing.teamColors

/** Let the 700 ms autosave debounce elapse. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })
/** The most recent PUT body, typed just far enough for the assertions below. */
const sent = () => apiPut.mock.calls[apiPut.mock.calls.length - 1]?.[1] as
  { doctrine?: Record<string, unknown> } | undefined
const type = (el: Element, value: string) => act(async () => { fireEvent.change(el, { target: { value } }) })
const click = (el: Element) => act(async () => { fireEvent.click(el) })

/** A station as the API projects it: the doctrine block filled in, no Auftrag colours chosen. */
const STATION = {
  version: 'v1',
  identity: { appName: 'Feuerwehr Steintal' },
  doctrine: {
    defaultFunkkanal: 11, funkkanalMin: 1, funkkanalMax: 9999,
    defaultPressureBar: 300, alarmBar: 100, pressureStep: 10, pressureMax: 320,
    contactIntervalMin: 5, contactGraceSec: 60,
    cylinderLiters: 7, estConsumptionLPerMin: 50, auftragColors: null,
  },
}

/** The doctrine number boxes in DOM order: Funk (3), Druck (5), Kontakt (2), Luft (2). */
const nums = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="number"]'))
const autoButtons = () => screen.getAllByText(AUTO)

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue(structuredClone(STATION))
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function open() {
  await act(async () => { render(<ConfigProvider><DoctrineSection /></ConfigProvider>) })
  await waitFor(() => expect(nums().length).toBe(12))
}

describe('Auftrag-Farben — «Automatisch» is the default state, not a null value', () => {
  it('writes nothing at all when the row is already automatic', async () => {
    await open()
    await click(autoButtons()[0])
    await settle()
    // The old control wrote `auftragColors.retten = null` here — a 422 on the WHOLE document,
    // from the button that was already pressed in.
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('takes a colour back by REMOVING the key, never by nulling it', async () => {
    await open()
    await click(screen.getAllByLabelText(ROT)[0])
    await settle()
    expect(sent()?.doctrine?.auftragColors).toEqual({ retten: ROT })
    expectAccepted(sent())

    await click(autoButtons()[0])
    await settle()
    // the last colour gone → the whole block is null, which is how «none» is said in the schema
    expect(sent()?.doctrine?.auftragColors).toBeNull()
    expectAccepted(sent())
  })

  it('leaves the other Aufträge alone when one is taken back', async () => {
    await open()
    await click(screen.getAllByLabelText(ROT)[0])   // Retten
    await click(screen.getAllByLabelText(BLAU)[1])  // Löschen
    await settle()
    expect(sent()?.doctrine?.auftragColors).toEqual({ retten: ROT, loeschen: BLAU })

    await click(autoButtons()[0])
    await settle()
    expect(sent()?.doctrine?.auftragColors).toEqual({ loeschen: BLAU })
    expectAccepted(sent())
  })

  it('pressing the active colour is the same «zurück auf automatisch», and equally valid', async () => {
    await open()
    await click(screen.getAllByLabelText(ROT)[0])
    await settle()
    await click(screen.getAllByLabelText(ROT)[0])
    await settle()
    expect(sent()?.doctrine?.auftragColors).toBeNull()
    expectAccepted(sent())
  })
})

describe('the doctrine numbers are integers on the backend, so a fraction never leaves the box', () => {
  it('holds «8.5» back and says what is expected — the neighbours still save', async () => {
    await open()
    await type(nums()[0], '8.5') // Funkkanal — `int | None`, so 8.5 is `int_from_float`
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(N.integer)).toBeTruthy()

    await type(nums()[3], '280') // Eingangsdruck, on the same page and untouched by the refusal
    await settle()
    expect(sent()?.doctrine?.defaultPressureBar).toBe(280)
    expect(sent()?.doctrine?.defaultFunkkanal).toBe(11) // the stored value, not the typed one
    expectAccepted(sent())
  })

  it('stores a whole number, and an emptied box goes back to the shipped doctrine (null)', async () => {
    await open()
    await type(nums()[0], '12')
    await settle()
    expect(sent()?.doctrine?.defaultFunkkanal).toBe(12)
    // ⚠️ These fields ARE `int | None`, so empty is a value here — unlike Rapport → Rundung.
    await type(nums()[0], '')
    await settle()
    expect(sent()?.doctrine?.defaultFunkkanal).toBeNull()
    expectAccepted(sent())
  })
})

// The one safety-critical number that was file-only until now: a browser-configured station never
// got it, a CLI-template one silently adopted an invisible 50 bar. It is also the only doctrine
// field with a CROSS-FIELD rule — above `alarmBar` the API refuses the WHOLE document, and the
// autosave for all five Station pages with it.
describe('Alarmdruck im Rückzug — the lower line, bounded by the bare Alarmdruck', () => {
  /** the third box in the Druck group */
  const rueckzug = () => nums()[5]

  it('stores a value at or below the Alarmdruck', async () => {
    await open()
    await type(rueckzug(), '60')
    await settle()
    expect(sent()?.doctrine?.alarmBarRueckzug).toBe(60)
    expectAccepted(sent())
  })

  it('holds a value ABOVE the Alarmdruck back rather than wedging the document', async () => {
    await open()
    await type(rueckzug(), '150') // STATION runs alarmBar 100
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(
      appConfig.copy.admin.doctrine.alarmBarRueckzugInvalid.replace('{max}', '100'),
    )).toBeTruthy()
  })

  it('refuses 0 — a stored zero removes the Rückzug alarm instead of falling back', async () => {
    await open()
    await type(rueckzug(), '0')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
  })
})

describe('Alarmdruck — zero belongs to the public demo only', () => {
  /** the middle box in the Druck group */
  const alarm = () => nums()[4]
  const rueckzug = () => nums()[5]

  it('holds 0 back on an ordinary station', async () => {
    await open()
    await type(alarm(), '0')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(N.integerRange.replace('{min}', '1').replace('{max}', '300'))).toBeTruthy()
  })

  it('stores 0 on the public demo and disables the Rückzug line too', async () => {
    apiGet.mockResolvedValueOnce({
      ...structuredClone(STATION),
      identity: { appName: 'KP Front Demo', demoMode: true },
      doctrine: { ...structuredClone(STATION.doctrine), alarmBarRueckzug: 50 },
    })
    await open()
    await type(alarm(), '0')
    await settle()

    expect(sent()?.doctrine).toMatchObject({ alarmBar: 0, alarmBarRueckzug: null })
    expect(rueckzug().disabled).toBe(true)
    expect(rueckzug().value).toBe('0')
  })

  /** A station that has CHOSEN a Rückzug line, rather than running on the shipped default. */
  const openWithRueckzug = async (rueckzugBar: number) => {
    apiGet.mockResolvedValueOnce({
      ...structuredClone(STATION),
      doctrine: { ...structuredClone(STATION.doctrine), alarmBarRueckzug: rueckzugBar },
    })
    await open()
  }

  it('clamps the Rückzug line when the working Alarmdruck is lowered below it', async () => {
    await openWithRueckzug(50)
    await type(alarm(), '40')
    await settle()

    expect(sent()?.doctrine).toMatchObject({ alarmBar: 40, alarmBarRueckzug: 40 })
    expectAccepted(sent())
  })

  it('keeps the chosen Rückzug line when the Alarmdruck is RAISED through it', async () => {
    // ⚠️ The regression this exists for. `onAccepted` fires per KEYSTROKE and every prefix of a
    // number is a valid number, so typing 150 passes through alarmBar 1 and 15. A clamp that
    // only ever lowers rewrote the Rückzug line to 1 there and never brought it back: the
    // document was saved as «150 / 1», which the API accepts and which alarms a retreating
    // Trupp at a pressure no cylinder reaches.
    await openWithRueckzug(50)
    await type(alarm(), '1')
    await type(alarm(), '15')
    await type(alarm(), '150')
    await settle()

    expect(sent()?.doctrine).toMatchObject({ alarmBar: 150, alarmBarRueckzug: 50 })
    expectAccepted(sent())
  })

  it('restores the chosen line after the demo zero is lifted again', async () => {
    apiGet.mockResolvedValueOnce({
      ...structuredClone(STATION),
      identity: { appName: 'KP Front Demo', demoMode: true },
      doctrine: { ...structuredClone(STATION.doctrine), alarmBarRueckzug: 60 },
    })
    await open()
    await type(alarm(), '0')
    await type(alarm(), '200')
    await settle()

    expect(sent()?.doctrine).toMatchObject({ alarmBar: 200, alarmBarRueckzug: 60 })
  })

  it('leaves an UNSET Rückzug line unset — the shipped one is already clamped on both sides', async () => {
    // deploymentConfig · atemschutzDoctrine and push.py · due_trupps both read it as
    // min(50, alarmBar), so pinning a number here would only freeze this station to today's
    // default for no safety gain.
    await open()
    await type(alarm(), '40')
    await settle()

    expect(sent()?.doctrine).toMatchObject({ alarmBar: 40 })
    expect(sent()?.doctrine?.alarmBarRueckzug).toBeUndefined()
  })
})

describe('the air estimate — the two decimals with hard bounds', () => {
  /** cylinderLiters, estConsumptionLPerMin — the last two boxes on the page. */
  const cylinder = () => nums()[10]

  it('takes a 9-litre cylinder, which is the point of the field', async () => {
    await open()
    await type(cylinder(), '9')
    await settle()
    expect(sent()?.doctrine?.cylinderLiters).toBe(9)
    expectAccepted(sent())
  })

  it('refuses 0 — the API says gt=0, and a 0-litre cylinder divides by zero in the estimate', async () => {
    await open()
    await type(cylinder(), '0')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
    expect(screen.getByText(N.decimalOver.replace('{min}', '0').replace('{max}', '30'))).toBeTruthy()
  })

  it('refuses a cylinder past the API maximum', async () => {
    await open()
    await type(cylinder(), '45')
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('keeps the decimal a decimal: 6.8 L is a real cylinder', async () => {
    await open()
    await type(cylinder(), '6.8')
    await settle()
    expect(sent()?.doctrine?.cylinderLiters).toBe(6.8)
    expectAccepted(sent())
  })
})
