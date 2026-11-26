// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { DeploymentConfig } from '../lib/deploymentConfig'
import type { MittelEntry } from '../types'
import type { MittelDraft } from './MittelView'
import { clearAllDrafts } from '../lib/draftKeep'

// MittelView reads the deployment catalogue through the getDeploymentConfig() singleton — mock
// just that accessor so each test can put its own catalogue/sources under the component.
const cfg: { current: DeploymentConfig } = { current: {} }
vi.mock('../lib/deploymentConfig', async () => {
  const actual = await vi.importActual<typeof import('../lib/deploymentConfig')>('../lib/deploymentConfig')
  return { ...actual, getDeploymentConfig: () => cfg.current }
})
const { MittelView } = await import('./MittelView')

afterEach(cleanup)
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
beforeEach(() => { cfg.current = {} })

const M = appConfig.copy.mittel
const sources = [{ id: 'tlf', label: 'TLF Oberwil' }, { id: 'mag', label: 'Magazin' }]
// one stocked source, one candidate → fully unambiguous
const tauchpumpe = { id: 'tp', label: 'Tauchpumpe', symbol: 'FW Tauchpumpe', stock: [{ source: 'tlf', qty: 1 }] }
// one candidate, TWO stocked sources → the «booked from where?» question
const oelbinder = { id: 'oel', label: 'Ölbinder', symbol: 'FW Oelbinder', stock: [{ source: 'tlf', qty: 2 }, { source: 'mag', qty: 10 }] }
// TWO cells, but only ONE Fahrzeug actually carries it → a multi-source row with no question
const schaum = { id: 'sm', label: 'Schaummittel', stock: [{ source: 'tlf', qty: 0 }, { source: 'mag', qty: 4 }] }

const mount = (over: Partial<Parameters<typeof MittelView>[0]> = {}) => {
  const onSave = vi.fn<(d: MittelDraft) => void>()
  render(<MittelView entries={[]} canEdit onSave={onSave} {...over} />)
  return onSave
}

/** MittelView is CONTROLLED: it reports a new running total and gets its entries back as props.
 *  «One tap, not two» is a statement about exactly that round trip, so the compact-row tests
 *  drive the real one instead of a vi.fn() that swallows the write. */
function Live({ initial = [], saves }: { initial?: MittelEntry[]; saves: MittelDraft[] }) {
  const [entries, setEntries] = useState<MittelEntry[]>(initial)
  return (
    <MittelView
      entries={entries} canEdit
      onSave={(d) => {
        saves.push(d)
        setEntries((cur) => [...cur, {
          id: `e${cur.length + 1}`, materialId: d.materialId, label: d.label, unit: d.unit,
          sourceId: d.sourceId, sourceLabel: d.sourceLabel, menge: d.menge,
          at: new Date(Date.now() + cur.length).toISOString(),
        }])
      }}
    />
  )
}

describe('«In Verwendung» — the tick filter stays put while active', () => {
  it('never unmounts on click, so it can always be toggled back off', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const onSave = mount({
      entries: [{ id: 'e1', materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1, at: new Date().toISOString() }],
    })
    const btn = screen.getByRole('button', { name: M.viewBySource }) as HTMLButtonElement
    expect(btn.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(btn)
    // same node, now pressed — the control is not conditionally rendered on `view`
    expect(screen.getByRole('button', { name: M.viewBySource })).toBe(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(btn)
    expect(screen.getByRole('button', { name: M.viewBySource })).toBe(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(onSave).not.toHaveBeenCalled()
  })
})

// button sweep HEADS.3 (17.11.2026): a narrowed list says WHAT narrows it, under the line, with the
// way back – the pressed tick alone did not say «only what was used»
describe('the «Gefiltert:» strip', () => {
  it('names «In Verwendung» while it is on and lifts it with «Alle zeigen»', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    mount({
      entries: [{ id: 'e1', materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1, at: new Date().toISOString() }],
    })
    const F = appConfig.copy.filterStrip
    expect(screen.queryByText(F.filtered)).toBeNull()
    const btn = screen.getByRole('button', { name: M.viewBySource })
    fireEvent.click(btn)
    expect(screen.getByText(F.filtered).parentElement!.textContent).toContain(M.viewBySource)
    fireEvent.click(screen.getByRole('button', { name: F.showAll }))
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByText(F.filtered)).toBeNull()
  })
})

describe('suchen heisst erfassen — die Suche trägt den Namen in den Composer', () => {
  const fromQuery = (name: string) => fillTemplate(M.composerFromQuery, { name })
  const type = (q: string) => fireEvent.change(
    screen.getByPlaceholderText(M.searchPlaceholder), { target: { value: q } },
  )

  it('offers the typed name even while the catalogue still has partial matches', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe, oelbinder], sources } }
    mount()
    // nothing typed → no door here: the bare «+» on the search line is the empty-query entry
    expect(screen.queryByRole('button', { name: fromQuery('') })).toBeNull()
    type('Tauch')
    // «Tauchpumpe» still matches, and the door stands beside it — a Tauchpumpe-Adapter is not
    // found by deleting characters until the list gives up
    expect(screen.getByRole('button', { name: fillTemplate(M.addOne, { label: 'Tauchpumpe' }) })).toBeTruthy()
    expect(screen.getByRole('button', { name: fromQuery('Tauch') })).toBeTruthy()
  })

  it('opens the composer with the query as the Bezeichnung — and saves it without retyping', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const onSave = mount()
    type('Kanister')

    // no matches: the note and the door, nothing else
    expect(screen.getByText(fillTemplate(appConfig.copy.noHits, { q: 'Kanister' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: fromQuery('Kanister') }))

    // the composer stands open with the name already in its Material field
    expect(screen.getByText(M.composerTitle)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Kanister/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: M.save }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ label: 'Kanister', menge: 1, materialId: undefined })
    // recorded → the sheet is gone
    expect(screen.queryByText(M.composerTitle)).toBeNull()
  })

  it('resolves a query that IS a catalogue material to that material, not to a free line', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const onSave = mount()
    type('Tauchpumpe')
    fireEvent.click(screen.getByRole('button', { name: fromQuery('Tauchpumpe') }))
    fireEvent.click(screen.getByRole('button', { name: M.save }))

    expect(onSave.mock.calls[0][0]).toMatchObject({ materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.' })
  })
})

describe('kompakte Ruhezeile — eine Position bei 0 trägt nur ein «+»', () => {
  const addOne = (label: string) => fillTemplate(M.addOne, { label })
  const pickSource = (label: string) => fillTemplate(M.addPickSource, { label })
  /** the ±stepper of a row, by the aria-label MittelView gives it */
  const stepper = (name: string) => screen.queryByRole('group', { name })

  it('shows the «+» instead of the ±stepper while nothing is used', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    mount()
    expect(screen.getByRole('button', { name: addOne('Tauchpumpe') })).toBeTruthy()
    expect(stepper('Tauchpumpe Stk.')).toBeNull()
  })

  it('books 1 AND expands the row on the FIRST tap — one tap, not two', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const saves: MittelDraft[] = []
    render(<Live saves={saves} />)

    fireEvent.click(screen.getByRole('button', { name: addOne('Tauchpumpe') }))

    expect(saves).toEqual([{
      materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1,
    }])
    // the very same tap left the full form standing — «noch eine» lands on the ±stepper
    expect(stepper('Tauchpumpe Stk.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: addOne('Tauchpumpe') })).toBeNull()
    // …and the head counts it in the singular – it said «1 Positionen» (sweep F.7)
    expect(screen.getByText('1 Position')).toBeTruthy()
  })

  it('folds straight back to the «+» when the count is taken to 0 — not only on the next visit', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const saves: MittelDraft[] = []
    render(<Live saves={saves} />)

    fireEvent.click(screen.getByRole('button', { name: addOne('Tauchpumpe') }))
    // the ±buttons step on pointerdown (press-and-hold repeats — lib/useHoldRepeat), not on click
    fireEvent.pointerDown(screen.getByRole('button', { name: appConfig.copy.stepper.less }), { button: 0 })
    fireEvent.pointerUp(window)

    expect(saves.map((d) => d.menge)).toEqual([1, 0])
    expect(stepper('Tauchpumpe Stk.')).toBeNull()
    expect(screen.getByRole('button', { name: addOne('Tauchpumpe') })).toBeTruthy()
  })

  it('and the «+» it hands back still books — the round trip survives the fold', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const saves: MittelDraft[] = []
    render(<Live saves={saves} />)

    fireEvent.click(screen.getByRole('button', { name: addOne('Tauchpumpe') }))
    fireEvent.pointerDown(screen.getByRole('button', { name: appConfig.copy.stepper.less }), { button: 0 })
    fireEvent.pointerUp(window)
    fireEvent.click(screen.getByRole('button', { name: addOne('Tauchpumpe') }))

    expect(saves.map((d) => d.menge)).toEqual([1, 0, 1])
    expect(stepper('Tauchpumpe Stk.')).toBeTruthy()
  })

  // UX pick B2·31 (25.11.2026): the booked row names its vehicle and says the stock in words;
  // red only past what is there
  it('names the vehicle it was booked from and the stock in words, red only past it', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const saves: MittelDraft[] = []
    render(<Live saves={saves} />)
    expect(screen.getByText(fillTemplate(M.stockLeft, { n: 1, total: 1 }))).toBeTruthy()
    expect(screen.queryByText('TLF Oberwil')).toBeNull() // nothing booked yet: no vehicle
    fireEvent.click(screen.getByRole('button', { name: addOne('Tauchpumpe') }))
    expect(screen.getByText('TLF Oberwil')).toBeTruthy()
    const left = screen.getByText(fillTemplate(M.stockLeft, { n: 0, total: 1 }))
    expect(left.className).not.toMatch(/over/)
    fireEvent.pointerDown(screen.getByRole('button', { name: appConfig.copy.stepper.more }), { button: 0 })
    fireEvent.pointerUp(window)
    expect(screen.getByText(fillTemplate(M.stockOver, { n: 1 })).className).toMatch(/over/)
  })

  it('leaves a row that already carries a count in today\'s full form', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    mount({
      entries: [{ id: 'e1', materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1, at: new Date().toISOString() }],
    })
    expect(stepper('Tauchpumpe Stk.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: addOne('Tauchpumpe') })).toBeNull()
  })

  it('opens the sources instead of guessing when several Fahrzeuge carry the material', () => {
    cfg.current = { mittel: { catalogue: [oelbinder], sources } }
    const onSave = mount()

    fireEvent.click(screen.getByRole('button', { name: pickSource('Ölbinder') }))

    expect(onSave).not.toHaveBeenCalled()
    expect(stepper('Ölbinder · TLF Oberwil')).toBeTruthy()
    expect(stepper('Ölbinder · Magazin')).toBeTruthy()
  })

  it('books onto the one Fahrzeug that carries it when only one does', () => {
    cfg.current = { mittel: { catalogue: [schaum], sources } }
    const onSave = mount()

    fireEvent.click(screen.getByRole('button', { name: addOne('Schaummittel') }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith({
      materialId: 'sm', label: 'Schaummittel', unit: 'Stk.', sourceId: 'mag', sourceLabel: 'Magazin', menge: 1,
    })
  })
})

describe('«Gesetzt, aber nicht erfasst» — unambiguous vs. ambiguous', () => {
  it('books a fully unambiguous set with today\'s one-tap «Übernehmen», no sheet', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    const onSave = mount({ placedSymbols: [{ symbol: 'FW Tauchpumpe' }] })

    fireEvent.click(screen.getByRole('button', { name: M.lageStripTake }))

    expect(screen.queryByText(M.lagePickTitle)).toBeNull()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith({
      materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1,
    })
  })

  it('reads «Erfassen …» when anything is ambiguous and opens the picker sheet instead of booking', () => {
    cfg.current = { mittel: { catalogue: [oelbinder], sources } }
    const onSave = mount({ placedSymbols: [{ symbol: 'FW Oelbinder' }] })

    expect(screen.queryByRole('button', { name: M.lageStripTake })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: M.lageStripCapture }))

    expect(screen.getByText(M.lagePickTitle)).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
    // the footer counts the open question and stays disabled until it is answered
    const foot = screen.getByRole('button', { name: M.lagePickOpenOne })
    expect((foot as HTMLButtonElement).disabled).toBe(true)
  })

  it('books the per-item source pick through onSave, and the unambiguous rest with it', () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe, oelbinder], sources } }
    const onSave = mount({ placedSymbols: [{ symbol: 'FW Oelbinder' }, { symbol: 'FW Tauchpumpe' }] })

    fireEvent.click(screen.getByRole('button', { name: M.lageStripCapture }))
    // the Ölbinder group offers both stocked sources; pick the NON-default one (Magazin)
    fireEvent.click(screen.getByRole('radio', { name: /Magazin/ }))

    // answered → the footer now counts what one tap books
    fireEvent.click(screen.getByRole('button', { name: fillTemplate(M.lagePickConfirm, { n: 2 }) }))

    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave.mock.calls.map(([d]) => d)).toEqual(expect.arrayContaining([
      { materialId: 'oel', label: 'Ölbinder', unit: 'Stk.', sourceId: 'mag', sourceLabel: 'Magazin', menge: 1 },
      { materialId: 'tp', label: 'Tauchpumpe', unit: 'Stk.', sourceId: 'tlf', sourceLabel: 'TLF Oberwil', menge: 1 },
    ]))
    // booking everything closes the sheet
    expect(screen.queryByText(M.lagePickTitle)).toBeNull()
  })
})

describe('the pencil of a hand-added line', () => {
  const kanister: MittelEntry = { id: 'e1', label: 'Kanister', unit: 'Stk.', menge: 2, at: '2026-10-20T10:00:00.000Z' }
  const openPencil = () => fireEvent.click(screen.getByRole('button', { name: `Kanister – ${M.editLabel}` }))

  // UX sweep F3: Bestand is the shared Stepper like «Menge» — no native number field, «–» until set
  it('asks Bestand with the shared Stepper, «–» until set, and saves what it was stepped to', () => {
    const onSave = mount({ entries: [kanister] })
    openPencil()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    const stock = screen.getByRole('group', { name: M.stockLabel })
    expect(stock.textContent).toContain('–')
    fireEvent.pointerDown(stock.querySelectorAll('button')[2], { pointerId: 1 }) // the «+»
    fireEvent.pointerUp(stock.querySelectorAll('button')[2], { pointerId: 1 })
    fireEvent.click(screen.getByRole('button', { name: M.save }))
    expect(onSave.mock.lastCall?.[0]).toMatchObject({ label: 'Kanister', stock: 1 })
  })

  // owner, 17.11.2026 (duck sweep CONT.3): any close but «Abbrechen» saves a change
  it('saves a change on ✕ and drops it on «Abbrechen»', () => {
    const onSave = mount({ entries: [kanister] })
    // the Material field holds the caret from the open: with it, the first ✕ only puts the keys
    // down (overlays/fieldFirst) – leave it first, as a tap on the stepper does on a device
    const stepUp = () => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      const plus = screen.getByRole('group', { name: M.stockLabel }).querySelectorAll('button')[2]
      fireEvent.pointerDown(plus, { pointerId: 1 }); fireEvent.pointerUp(plus, { pointerId: 1 })
    }
    openPencil(); stepUp()
    fireEvent.click(screen.getByRole('button', { name: M.cancel }))
    expect(onSave).not.toHaveBeenCalled()
    openPencil(); stepUp()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.closeDialog }))
    expect(onSave.mock.lastCall?.[0]).toMatchObject({ label: 'Kanister', stock: 1 })
  })
})

// «Abbrechen» is the deliberate discard everywhere (owner, 17.11.2026): the composer's kept draft goes with it
describe('the composer\'s kept draft', () => {
  const fromQuery = (name: string) => fillTemplate(M.composerFromQuery, { name })
  const type = (q: string) => fireEvent.change(screen.getByPlaceholderText(M.searchPlaceholder), { target: { value: q } })
  it('survives ✕ and is dropped by «Abbrechen»', () => {
    clearAllDrafts()
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    mount()
    type('Kanister')
    fireEvent.click(screen.getByRole('button', { name: fromQuery('Kanister') }))
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.closeDialog }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(M.add) }))
    expect(screen.getByRole('button', { name: /Kanister/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: M.cancel }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(M.add) }))
    expect(screen.queryByRole('button', { name: /Kanister/ })).toBeNull()
  })
})

// UX sweep F2: «Speichern» was a native `disabled` — grey, mute, the tap swallowed. It now stays
// tappable (aria-disabled) and rings the empty field it is waiting for, as the Trupp form does.
describe('a blocked «Speichern» in the composer', () => {
  it('records nothing and points at the empty Material field instead', () => {
    const onSave = mount()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(M.add) }))
    const save = screen.getByRole('button', { name: M.save })
    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect((save as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
    const ringed = document.querySelector('.field-flash')
    expect(ringed?.textContent).toContain(M.materialLabel)
  })
})

// owner pick 28 (17.11.2026): the bin's save is the Mittel slice's ↶ step, so no toast doubles it
describe('removing a hand-added line', () => {
  const kanister: MittelEntry = { id: 'e1', label: 'Kanister', unit: 'Stk.', menge: 2, at: '2026-10-20T10:00:00.000Z' }

  it('saves the tombstone once, and raises no toast', async () => {
    const { Overlays } = await import('../lib/ui')
    render(<Overlays />)
    const onSave = vi.fn((_: MittelDraft) => {})
    render(<MittelView entries={[kanister]} canEdit onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: `Kanister – ${M.editLabel}` }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(M.deleteLine) }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.lastCall?.[0]).toMatchObject({ label: 'Kanister', deleted: true })
    expect(document.querySelector('.toast')).toBeNull()
  })
})

// Sol review, PR #702: «+ Anderes Material» unmounted while its sheet was open, so Enter → Escape
// left the focus on <body>. It stays mounted, and the sheet hands the focus back to it.
describe('«+ Anderes Material» in the head', () => {
  it('gets the focus back when its sheet closes', async () => {
    cfg.current = { mittel: { catalogue: [tauchpumpe], sources } }
    mount()
    const trigger = screen.getByRole('button', { name: M.customMaterial })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByText(M.composerTitle)).toBeTruthy()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(M.composerTitle)).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
