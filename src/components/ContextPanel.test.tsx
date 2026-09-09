// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ContextPanel, type SymbolView } from './ContextPanel'
import type { SymbolControl } from '../types'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

// Steppers are keyed by their German labels (appConfig.copy.contextPanel).
const L = { floor: 'Geschoss', floorFrom: 'Von Geschoss', floorTo: 'Bis Geschoss', count: 'Anzahl', rotation: 'Drehung' }

function setup(over: Partial<React.ComponentProps<typeof ContextPanel>> = {}) {
  const entity: SymbolView = { id: 's1', symbol: 'VKF Feuer', label: 'Brand', ...(over.entity ?? {}) }
  const props: React.ComponentProps<typeof ContextPanel> = {
    entity,
    onClose: vi.fn(),
    onTitle: vi.fn(),
    onFields: vi.fn(),
    onDelete: vi.fn(),
    // wire every glyph-stepper callback so visibility is driven purely by `controls`
    onFloor: vi.fn(),
    onCount: vi.fn(),
    onRotate: vi.fn(),
    ...over,
  }
  render(<ContextPanel {...props} />)
  return props
}

// a stepper is present iff its label text is rendered
const hasStepper = (label: string) => screen.queryByText(label) !== null

describe('ContextPanel — stepper gating by the `controls` prop', () => {
  it('shows only the steppers the symbol declares (rotation-only)', () => {
    setup({ controls: new Set<SymbolControl>(['rotation']) })
    expect(hasStepper(L.rotation)).toBe(true)
    expect(hasStepper(L.floor)).toBe(false)
    expect(hasStepper(L.count)).toBe(false)
  })

  it('shows floor + count when both are declared, hides rotation', () => {
    setup({ controls: new Set<SymbolControl>(['floor', 'count']) })
    expect(hasStepper(L.floor)).toBe(true)
    expect(hasStepper(L.count)).toBe(true)
    expect(hasStepper(L.rotation)).toBe(false)
  })

  it('hides every glyph-stepper when controls is an empty set', () => {
    setup({ controls: new Set<SymbolControl>([]) })
    expect(hasStepper(L.floor)).toBe(false)
    expect(hasStepper(L.count)).toBe(false)
    expect(hasStepper(L.rotation)).toBe(false)
  })

  it('with no controls prop, shows every WIRED stepper (back-compat for non-symbols)', () => {
    setup({ controls: undefined })
    expect(hasStepper(L.floor)).toBe(true)
    expect(hasStepper(L.count)).toBe(true)
    expect(hasStepper(L.rotation)).toBe(true)
  })

  it('shows the von/bis storeys for a symbol that declares ONLY floorRange (the Lift)', () => {
    // ⚠️ regression: floorRange was missing from the gate around the stepper row, so a Lift —
    // whose preset lists no other control — rendered no steppers at all and its storey span was
    // unreachable on both surfaces.
    setup({ controls: new Set<SymbolControl>(['floorRange']), onFloorFrom: vi.fn(), onFloorTo: vi.fn() })
    expect(hasStepper(L.floorFrom)).toBe(true)
    expect(hasStepper(L.floorTo)).toBe(true)
    expect(hasStepper(L.floor)).toBe(false)
  })

  it('a declared control whose callback is NOT wired stays hidden', () => {
    // controls allows floor, but onFloor is not provided ⇒ the surface can't do it ⇒ hidden
    setup({ controls: new Set<SymbolControl>(['floor', 'rotation']), onFloor: undefined })
    expect(hasStepper(L.floor)).toBe(false)
    expect(hasStepper(L.rotation)).toBe(true)
  })
})

describe('ContextPanel — basic wiring', () => {
  it('names the SYMBOL in the header, and it cannot be edited', () => {
    // ⚠️ The header is a name, not a field: renaming a «Rauch» to «Küche» made the panel lie
    // about which symbol was selected. Anything worth saying about one symbol goes in Notizen.
    const p = setup({ controls: new Set<SymbolControl>(['rotation']) })
    expect(screen.getByText('Feuer')).toBeTruthy()          // the symbol's own name
    expect(screen.queryByDisplayValue('Brand')).toBeNull()  // …and no input to overwrite it
    fireEvent.click(screen.getByLabelText('Schliessen'))
    expect(p.onClose).toHaveBeenCalled()
  })

  it('gives a user-labelled symbol its own Bezeichnung field instead', () => {
    // the generic Fahrzeug is the one symbol whose label IS its identity — recognised by the
    // station having configured a title list for it
    setup({ entity: { id: 'v1', symbol: 'VKF Fahrzeug', label: 'TLF' }, titleOptions: ['TLF', 'MTF'] })
    expect(screen.getByText('Bezeichnung')).toBeTruthy()
    // …and the header still SHOWS it (a Fahrzeug is known by its label, not by «Fahrzeug»),
    // it just is not the place you change it any more
    expect(screen.getAllByText('TLF').length).toBeGreaterThan(1)
  })

  it('tapping the header title opens the Bezeichnung menu (people rename where the name shows)', () => {
    setup({ entity: { id: 'v1', symbol: 'VKF Fahrzeug', label: 'TLF' }, titleOptions: ['TLF', 'MTF'] })
    // menu closed: the alternative type is nowhere on screen
    expect(screen.queryByText('MTF')).toBeNull()
    fireEvent.click(document.querySelector('.ctx-title-btn')!)
    expect(screen.getByText('MTF')).toBeTruthy()
  })

  it('keeps the read-only (viewer) Fahrzeug header a plain name, not a button', () => {
    setup({ entity: { id: 'v1', symbol: 'VKF Fahrzeug', label: 'TLF' }, titleOptions: ['TLF', 'MTF'], readOnly: true })
    expect(document.querySelector('.ctx-title-btn')).toBeNull()
  })

  it("a live vehicle's Fahrer sits in the same label+picker row as a placed vehicle's", () => {
    // it used to be its own full-width block — the one field a GPS vehicle offers looked like
    // a different kind of thing than the identical preset field next door
    setup({
      entity: { id: 'v1', symbol: 'VKF Fahrzeug', label: 'TLF' },
      readOnly: true,
      driver: { value: '', options: ['Müller Hans'], onChange: vi.fn() },
    })
    expect(screen.getByText('Fahrer').closest('.field')).toBeTruthy()
  })

  it('stepping rotation up commits via onRotate', () => {
    const p = setup({ controls: new Set<SymbolControl>(['rotation']), entity: { id: 's1', rotation: 0 } })
    fireEvent.pointerDown(screen.getByLabelText('mehr')) // hold-to-repeat: first step fires on pointer-down
    expect(p.onRotate).toHaveBeenCalledWith(15) // ROT_STEP
  })
})

describe('ContextPanel — Geschoss (Untergeschosse are as reachable as Obergeschosse)', () => {
  const floorOnly = new Set<SymbolControl>(['floor'])
  // one stepper on screen ⇒ the ±buttons are unambiguous
  const tapLess = () => fireEvent.pointerDown(screen.getByLabelText('weniger'))

  it('the first tap on − sets EG (0), not nothing', () => {
    // ⚠️ − used to be dead on an unset Geschoss, so a Kellerbrand could only be reached by
    // stepping UP to 0 first and back down again.
    const p = setup({ controls: floorOnly, entity: { id: 's1' } })
    tapLess()
    expect(p.onFloor).toHaveBeenCalledWith(0)
  })

  it('the first tap on + sets EG (0) too', () => {
    const p = setup({ controls: floorOnly, entity: { id: 's1' } })
    fireEvent.pointerDown(screen.getByLabelText('mehr'))
    expect(p.onFloor).toHaveBeenCalledWith(0)
  })

  it('steps on down into the Untergeschosse', () => {
    const p = setup({ controls: floorOnly, entity: { id: 's1', floor: 0 } })
    tapLess()
    expect(p.onFloor).toHaveBeenCalledWith(-1)
  })

  it('takes a typed Untergeschoss', () => {
    const p = setup({ controls: floorOnly, entity: { id: 's1' } })
    fireEvent.click(screen.getByTitle('Tippen zum Eingeben'))
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '-2' } })
    fireEvent.blur(input)
    expect(p.onFloor).toHaveBeenCalledWith(-2)
  })

  it('clears back to unset', () => {
    const p = setup({ controls: floorOnly, entity: { id: 's1', floor: -2 } })
    fireEvent.click(screen.getByLabelText('zurücksetzen'))
    expect(p.onFloor).toHaveBeenCalledWith(null)
  })

  it('has nothing to clear while unset', () => {
    setup({ controls: floorOnly, entity: { id: 's1' } })
    expect((screen.getByLabelText('zurücksetzen') as HTMLButtonElement).disabled).toBe(true)
  })

  it('steps both ends of a von/bis span independently', () => {
    const p = setup({
      controls: new Set<SymbolControl>(['floorRange']),
      entity: { id: 's1', floorFrom: 0, floorTo: 2 },
      onFloorFrom: vi.fn(), onFloorTo: vi.fn(),
    })
    const less = screen.getAllByLabelText('weniger')  // [Von, Bis]
    fireEvent.pointerDown(less[0])
    expect(p.onFloorFrom).toHaveBeenCalledWith(-1)
    expect(p.onFloorTo).not.toHaveBeenCalled()
    fireEvent.pointerDown(less[1])
    expect(p.onFloorTo).toHaveBeenCalledWith(1)
  })

  it('seeds each end of an empty von/bis span on the first − tap', () => {
    const p = setup({
      controls: new Set<SymbolControl>(['floorRange']),
      entity: { id: 's1' },
      onFloorFrom: vi.fn(), onFloorTo: vi.fn(),
    })
    screen.getAllByLabelText('weniger').forEach((b) => fireEvent.pointerDown(b))
    expect(p.onFloorFrom).toHaveBeenCalledWith(0)
    expect(p.onFloorTo).toHaveBeenCalledWith(0)
  })
})

describe('ContextPanel — preset fields always surface', () => {
  // an Offizier placed before «Funktion» existed stores only { Name } — the panel must still
  // show the missing preset field (seeded empty), in canonical order (Funktion before Name).
  it('seeds a missing preset field row from protectedKeys', () => {
    setup({
      entity: { id: 'o1', symbol: 'FW Offizier', fields: { Name: 'Hans' } },
      protectedKeys: new Set(['Funktion', 'Name']),
    })
    const keys = screen.getAllByText((_t, el) => el?.className === 'kv-key-ro').map((el) => el.textContent)
    expect(keys).toEqual(['Funktion', 'Name'])
    expect((screen.getByDisplayValue('Hans') as HTMLInputElement).value).toBe('Hans')
  })

  it('does not duplicate a preset field that is already stored', () => {
    setup({
      entity: { id: 'o2', symbol: 'FW Offizier', fields: { Funktion: 'Front', Name: 'Hans' } },
      protectedKeys: new Set(['Funktion', 'Name']),
    })
    const keys = screen.getAllByText((_t, el) => el?.className === 'kv-key-ro').map((el) => el.textContent)
    expect(keys).toEqual(['Funktion', 'Name'])
  })

  // a trailing preset field (Einsatzleiter «Stv.», added after Name) must stay AFTER Name even
  // when it's blank/missing — not hoisted above it just because it isn't stored yet.
  // (The stored keys are still Name/Stv.; this glyph LABELS them by the job — see «the
  // Einsatzleiter pair» below — so the order is read off those labels.)
  it('keeps a missing trailing preset field in canonical order (EL before Stv.)', () => {
    setup({
      entity: { id: 'el1', symbol: 'VKF Einsatzleiter', fields: { Name: 'Müller' } },
      protectedKeys: new Set(['Name', 'Stv.']),
    })
    const keys = screen.getAllByText((_t, el) => el?.className === 'kv-key-ro').map((el) => el.textContent)
    expect(keys).toEqual(['EL', 'Stv. EL'])
  })

  it('keeps blank preset rows in the read-only version of the same sidebar', () => {
    setup({
      entity: { id: 'o3', symbol: 'FW Offizier', fields: { Name: 'Hans' } },
      protectedKeys: new Set(['Funktion', 'Name']),
      readOnly: true,
    })
    expect(screen.getByText('Funktion')).toBeTruthy()
    expect(screen.getAllByText('–').length).toBeGreaterThan(0)
  })
})

// The Gefahrentafel's UN-Nr. row drives the ADR chain (Stoff autofill, hazard readout, the
// orange-plate glyph). Operators transcribe the physical plate top-to-bottom — Gefahrnummer,
// then UN — so the classic mis-entry is the swap; fillFromUN repairs it when it is unambiguous.
describe('ContextPanel — Gefahrentafel UN-Nr. autofill', () => {
  const tafel = (fields: Record<string, string>) => ({
    entity: { id: 'g1', symbol: 'FW Gefahr Tafel', fields } as SymbolView,
    protectedKeys: new Set(['UN-Nr.', 'Stoff']),
  })

  it('fills an empty Stoff from a typed UN number', () => {
    const onFields = vi.fn()
    setup({ ...tafel({ 'UN-Nr.': '1', Stoff: '' }), onFields })
    const un = screen.getByDisplayValue('1') as HTMLInputElement
    fireEvent.change(un, { target: { value: '1233' } })
    fireEvent.blur(un)
    expect(onFields).toHaveBeenCalledWith({ 'UN-Nr.': '1233', Stoff: 'METHYLAMYLACETAT' })
  })

  it('repairs the plate-order swap: Kemler in UN-Nr., UN in Stoff', () => {
    const onFields = vi.fn()
    setup({ ...tafel({ 'UN-Nr.': '3', Stoff: '1233' }), onFields })
    const un = screen.getByDisplayValue('3') as HTMLInputElement
    fireEvent.change(un, { target: { value: '30' } }) // 30 = the ADR Kemler of UN 1233
    fireEvent.blur(un)
    expect(onFields).toHaveBeenCalledWith({ 'UN-Nr.': '1233', Stoff: 'METHYLAMYLACETAT' })
  })

  it('leaves a non-matching pair alone — no swap on a guess', () => {
    const onFields = vi.fn()
    setup({ ...tafel({ 'UN-Nr.': '4', Stoff: '1233' }), onFields })
    const un = screen.getByDisplayValue('4') as HTMLInputElement
    fireEvent.change(un, { target: { value: '44' } }) // 44 is not 1233's Kemler
    fireEvent.blur(un)
    expect(onFields).toHaveBeenCalledWith({ 'UN-Nr.': '44', Stoff: '1233' })
  })

  // the other half of the 08.09. pair (see the Stoff → UN-Nr. block below): a CHANGED UN-Nr.
  // replaces the substance name instead of leaving the previous Stoff standing beside it
  it('a changed UN-Nr. replaces the stale Stoff', () => {
    const onFields = vi.fn()
    setup({ ...tafel({ 'UN-Nr.': '0027', Stoff: 'SCHWARZPULVER, gekörnt oder in Mehlform' }), onFields })
    const un = screen.getByDisplayValue('0027') as HTMLInputElement
    fireEvent.change(un, { target: { value: '1203' } })
    fireEvent.blur(un)
    expect(onFields).toHaveBeenCalledWith({ 'UN-Nr.': '1203', Stoff: 'BENZIN oder OTTOKRAFTSTOFF' })
  })

  // a symbol saved before the key gained its dot stores 'UN-Nr' — the panel absorbs it into
  // the canonical preset row (no duplicate) and the next commit writes it back renamed
  it('absorbs the legacy dotless UN-Nr key into the preset row', () => {
    const onFields = vi.fn()
    setup({ ...tafel({ 'UN-Nr': '1233' }), onFields })
    const keys = screen.getAllByText((_t, el) => el?.className === 'kv-key-ro').map((el) => el.textContent)
    expect(keys).toEqual(['UN-Nr.', 'Stoff'])
    const un = screen.getByDisplayValue('1233') as HTMLInputElement
    fireEvent.blur(un)
    expect(onFields).toHaveBeenCalledWith({ 'UN-Nr.': '1233', Stoff: 'METHYLAMYLACETAT' })
  })
})

/* The ADR readout explains its codes (Feldtest 07.09.: «keine Ahnung, was 6.1 heisst»), and
 * every ERG distance carries an «Übernehmen» that turns it into a real Absperrkreis. */
describe('ContextPanel — ADR meanings and ERG Übernehmen', () => {
  const tafel = (fields: Record<string, string>) => ({
    entity: { id: 'g1', symbol: 'FW Gefahr Tafel', fields } as SymbolView,
    protectedKeys: new Set(['UN-Nr.', 'Stoff']),
  })

  it('prints the meaning beside class, label and packing-group codes', () => {
    // UN 1230 (METHANOL): class 3, labels 3 + 6.1, packing group II
    setup(tafel({ 'UN-Nr.': '1230', Stoff: '' }))
    expect(screen.getAllByText(/3 – Entzündbare flüssige Stoffe/).length).toBeGreaterThan(0)
    expect(screen.getByText(/6\.1 – Giftige Stoffe/)).toBeTruthy()
    expect(screen.getByText(/II – mittlere Gefahr/)).toBeTruthy()
  })

  it('«Übernehmen» hands the parsed distance to onAdoptRadius', () => {
    const onAdoptRadius = vi.fn()
    // UN 1005 (Ammoniak): si 30 m / pd 0.1 km / pn 0.2 km
    setup({ ...tafel({ 'UN-Nr.': '1005', Stoff: '' }), onAdoptRadius })
    const buttons = screen.getAllByRole('button', { name: appConfig.copy.contextPanel.ergAdopt })
    expect(buttons.length).toBe(3)
    fireEvent.click(buttons[0])
    expect(onAdoptRadius).toHaveBeenCalledWith(30)
    fireEvent.click(buttons[2])
    expect(onAdoptRadius).toHaveBeenCalledWith(200)
  })

  it('without onAdoptRadius the rows stay plain (Plan side)', () => {
    setup(tafel({ 'UN-Nr.': '1005', Stoff: '' }))
    expect(screen.queryByRole('button', { name: appConfig.copy.contextPanel.ergAdopt })).toBeNull()
  })

  // the transcribed yellow pages drop the class-1 explosives (no id numbers in the source), so
  // the guide is synthesized from the printed rule: class 1 → 112, division 1.4 → 114
  // (Feldtest 08.09.: UN 0027 — Schwarzpulver — showed no ERG guide at all)
  it('synthesizes the ERG guide for class-1 explosives', () => {
    setup(tafel({ 'UN-Nr.': '0027', Stoff: '' })) // 1.1D
    expect(screen.getByText(appConfig.copy.contextPanel.ergGuide)).toBeTruthy()
    expect(screen.getByText('112')).toBeTruthy()
  })

  it('…and 114 for division 1.4', () => {
    setup(tafel({ 'UN-Nr.': '0012', Stoff: '' })) // PATRONEN FÜR HANDFEUERWAFFEN, 1.4S
    expect(screen.getByText('114')).toBeTruthy()
  })
})

/* The reverse door (Feldtest Manuel, 07.09.): on the Gas/Chemie hazard symbols the operator
 * knows the SUBSTANCE, not the number. The Stoff row is a search combobox — the station-common
 * list first, the full ADR table behind the search — and a committed Stoff resolves its UN-Nr.,
 * which is what lights the ADR readout and the Schutzabstand rings. */
describe('ContextPanel — Stoff → UN-Nr. (Gas/Chemie substance search)', () => {
  const chemie = (fields: Record<string, string>) => ({
    entity: { id: 'c1', symbol: 'FW Gefahr C', fields } as SymbolView,
    protectedKeys: new Set(['Stoff', 'UN-Nr.']),
  })
  const openStoff = () => fireEvent.click(screen.getByRole('button', { name: /Wert/ }))

  it('a common substance is one pick away and fills its UN number', () => {
    const onFields = vi.fn()
    setup({ ...chemie({ Stoff: '', 'UN-Nr.': '' }), onFields })
    openStoff()
    fireEvent.click(screen.getByRole('button', { name: 'Salzsäure' }))
    expect(onFields).toHaveBeenCalledWith({ Stoff: 'Salzsäure', 'UN-Nr.': '1789' })
  })

  it('an official ADR name found through the search resolves by name', () => {
    const onFields = vi.fn()
    setup({ ...chemie({ Stoff: '', 'UN-Nr.': '' }), onFields })
    openStoff()
    fireEvent.change(screen.getByPlaceholderText(appConfig.copy.contextPanel.stoffSearch), { target: { value: 'Methylamylacetat' } })
    fireEvent.click(screen.getByRole('button', { name: 'METHYLAMYLACETAT' }))
    expect(onFields).toHaveBeenCalledWith({ Stoff: 'METHYLAMYLACETAT', 'UN-Nr.': '1233' })
  })

  it('an unknown substance stays as typed, the UN row honestly empty', () => {
    const onFields = vi.fn()
    setup({ ...chemie({ Stoff: '', 'UN-Nr.': '' }), onFields })
    openStoff()
    fireEvent.change(screen.getByPlaceholderText(appConfig.copy.contextPanel.stoffSearch), { target: { value: 'Wundermittel' } })
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.combo.useTyped.replace('{name}', 'Wundermittel') }))
    expect(onFields).toHaveBeenCalledWith({ Stoff: 'Wundermittel', 'UN-Nr.': '' })
  })

  /* Fill-only-if-empty left the plate lying twice over (Feldtest 08.09.): a new UN-Nr. kept the
   * previous Stoff standing, a newly picked Stoff kept the previous UN-Nr. — and the readout and
   * the rings follow the UN, so the mismatch was live on the Karte. Whichever of the pair the
   * commit touched pulls the other one along. */
  it('a newly picked Stoff replaces the standing UN-Nr.', () => {
    const onFields = vi.fn()
    setup({ ...chemie({ Stoff: 'Salzsäure', 'UN-Nr.': '1789' }), onFields })
    fireEvent.click(screen.getByRole('button', { name: /Salzsäure/ }))
    fireEvent.change(screen.getByPlaceholderText(appConfig.copy.contextPanel.stoffSearch), { target: { value: 'Methylamylacetat' } })
    fireEvent.click(screen.getByRole('button', { name: 'METHYLAMYLACETAT' }))
    expect(onFields).toHaveBeenCalledWith({ Stoff: 'METHYLAMYLACETAT', 'UN-Nr.': '1233' })
  })

  it('an unresolvable substance clears the standing UN-Nr. rather than leaving the old one', () => {
    const onFields = vi.fn()
    setup({ ...chemie({ Stoff: 'Salzsäure', 'UN-Nr.': '1789' }), onFields })
    fireEvent.click(screen.getByRole('button', { name: /Salzsäure/ }))
    fireEvent.change(screen.getByPlaceholderText(appConfig.copy.contextPanel.stoffSearch), { target: { value: 'Wundermittel' } })
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.combo.useTyped.replace('{name}', 'Wundermittel') }))
    expect(onFields).toHaveBeenCalledWith({ Stoff: 'Wundermittel', 'UN-Nr.': '' })
  })
})

// A NOTE is the surface that still types into `label` — its text IS its content. Every other
// symbol's header became read-only on 11.08., so this is where the live-edit path lives now.
describe('ContextPanel — live text editing on a note', () => {
  it('with onTitleLive, streams every keystroke live and finalises once on blur', () => {
    const onTitleLive = vi.fn(); const onTitle = vi.fn()
    setup({ entity: { id: 'n1', label: '' }, onTitleLive, onTitle, onNotePlain: vi.fn() })
    const input = screen.getByDisplayValue('') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.change(input, { target: { value: 'An' } })
    expect(onTitleLive).toHaveBeenCalledTimes(2)
    expect(onTitleLive).toHaveBeenLastCalledWith('An')
    expect(onTitle).not.toHaveBeenCalled() // not committed mid-typing
    fireEvent.blur(input)
    expect(onTitle).toHaveBeenCalledTimes(1)
    expect(onTitle).toHaveBeenCalledWith('An')
  })

  it('without onTitleLive, falls back to commit-only-on-blur', () => {
    const onTitle = vi.fn()
    setup({ entity: { id: 'n2', label: '' }, onTitle, onNotePlain: vi.fn() })
    const input = screen.getByDisplayValue('') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Hi' } })
    expect(onTitle).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onTitle).toHaveBeenCalledTimes(1)
    expect(onTitle).toHaveBeenCalledWith('Hi')
  })
})

// Details are stored as a key→value map, so two rows sharing a Bezeichnung collapse into one
// (last wins). The panel doesn't block or rename — it just says so on the later row.
describe('ContextPanel — duplicate custom field names', () => {
  const hint = (key: string) =>
    screen.queryByText(`«${key}» gibt es schon – nur der letzte Wert bleibt erhalten.`)

  it('stays quiet while every Bezeichnung is unique', () => {
    setup({ entity: { id: 's1', symbol: 'VKF Feuer', fields: { Test: 'a', 'Test 2': 'b' } } })
    expect(hint('Test')).toBeNull()
    expect(hint('Test 2')).toBeNull()
  })

  it('flags the SECOND row once a key is typed twice, and clears once it is made unique', () => {
    setup({ entity: { id: 's1', symbol: 'VKF Feuer', fields: { Test: 'a', Andere: 'b' } } })
    const key2 = screen.getByDisplayValue('Andere') as HTMLInputElement
    fireEvent.change(key2, { target: { value: 'Test' } })
    expect(hint('Test')).not.toBeNull()
    // exactly one warning — the first occurrence keeps its plain row
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    fireEvent.change(key2, { target: { value: 'Test 3' } })
    expect(hint('Test')).toBeNull()
  })

  it('warns but still commits — nothing is blocked or silently renamed', () => {
    const onFields = vi.fn()
    setup({ entity: { id: 's1', symbol: 'VKF Feuer', fields: { Test: 'a', Andere: 'b' } }, onFields })
    const key2 = screen.getByDisplayValue('Andere') as HTMLInputElement
    fireEvent.change(key2, { target: { value: 'Test' } })
    fireEvent.blur(key2)
    expect(onFields).toHaveBeenCalledWith({ Test: 'b' })
  })
})

// The Einsatzleiter glyph carries the two halves of ONE job. «Name» beside «Stv.» named the value
// on one row and the job on the other, and a handover meant clearing both dropdowns and finding
// both names again — at the one moment nobody has thirty seconds.
describe('ContextPanel — the Einsatzleiter pair', () => {
  const el = (fields: Record<string, string>) => ({
    entity: { id: 's1', symbol: 'VKF Einsatzleiter', fields },
    protectedKeys: new Set(['Name', 'Stv.']),
    fieldOptions: { Name: ['Widmer Céline', 'Müller Hans'], 'Stv.': ['Widmer Céline', 'Müller Hans'] },
  })
  const SWAP = 'Führung übergeben (EL ⇄ Stv.)'

  it('labels the rows by the JOB, not by «Name»', () => {
    setup(el({ Name: 'Widmer Céline', 'Stv.': 'Müller Hans' }))
    expect(screen.getByText('EL')).toBeTruthy()
    expect(screen.getByText('Stv. EL')).toBeTruthy()
    expect(screen.queryByText('Name')).toBeNull()
  })

  it('hands the Einsatz over in one tap — both fields, one commit', () => {
    const onFields = vi.fn()
    setup({ ...el({ Name: 'Widmer Céline', 'Stv.': 'Müller Hans' }), onFields })
    fireEvent.click(screen.getByRole('button', { name: SWAP }))
    expect(onFields).toHaveBeenCalledTimes(1)
    expect(onFields).toHaveBeenCalledWith({ Name: 'Müller Hans', 'Stv.': 'Widmer Céline' })
  })

  it('works with only one of the two filled — that is a handover to nobody yet', () => {
    const onFields = vi.fn()
    setup({ ...el({ Name: 'Widmer Céline', 'Stv.': '' }), onFields })
    fireEvent.click(screen.getByRole('button', { name: SWAP }))
    expect(onFields).toHaveBeenCalledWith({ Name: '', 'Stv.': 'Widmer Céline' })
  })

  it('offers nothing to swap while both are empty', () => {
    setup(el({ Name: '', 'Stv.': '' }))
    expect(screen.queryByRole('button', { name: SWAP })).toBeNull()
  })

  it('leaves every other symbol alone', () => {
    setup({
      entity: { id: 's1', symbol: 'VKF Fahrzeug', fields: { Fahrer: 'Müller Hans' } },
      protectedKeys: new Set(['Fahrer']),
      fieldOptions: { Fahrer: ['Müller Hans'] },
    })
    expect(screen.getByText('Fahrer')).toBeTruthy()
    expect(screen.queryByRole('button', { name: SWAP })).toBeNull()
  })
})

// D-06: a Georeferenz twin's plaque is read-only because its KIND has no editor on this surface,
// not because the object is protected — and its original's own panel offers Löschen.
describe('ContextPanel — Löschen on an otherwise read-only panel', () => {
  // rendered twice on purpose (pinned footer + the phone's inline copy); CSS shows exactly one
  const del = () => screen.queryAllByRole('button', { name: appConfig.copy.delete })

  it('is hidden on a read-only panel, as it always was', () => {
    setup({ readOnly: true })
    expect(del()).toHaveLength(0)
  })

  it('…and back when the caller says so, without unlocking anything else', () => {
    const props = setup({ readOnly: true, allowDelete: true })
    fireEvent.click(del()[0])
    expect(props.onDelete).toHaveBeenCalled()
    // the fields stay read-only: `allowDelete` is about ONE button, not about the panel
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

// A just-placed Notiz opens with the caret in its text field — and on a phone the sheet has to be
// FULL for that field to be above the iOS keyboard (05.09.). `.sheet-full` rides on the panel's
// own `.ctx` root (SheetGrip · CtxShell), which is the element the sheet height hangs off and the
// one the grip's tap toggles. `onNoteSize` is what makes this panel a note editor.
describe('ContextPanel — a placed Notiz opens the sheet full', () => {
  const note = (autoFocusNote: boolean) => {
    render(
      <ContextPanel entity={{ id: 'n1', label: '' }} onClose={vi.fn()} onTitle={vi.fn()}
        onFields={vi.fn()} onDelete={vi.fn()}
        onTitleLive={vi.fn()} onNoteSize={vi.fn()} autoFocusNote={autoFocusNote} />,
    )
    return document.querySelector('.ctx')!
  }

  it('expands the sheet and puts the caret in the note text', () => {
    const ctx = note(true)
    expect(ctx.classList.contains('sheet-full')).toBe(true)
    expect(document.activeElement?.className).toBe('ctx-note-input')
  })

  it('leaves a sheet reopened on an existing Notiz at whatever height it had', () => {
    const ctx = note(false)
    expect(ctx.classList.contains('sheet-full')).toBe(false)
  })
})

describe('ContextPanel — Notizen survive every way the sheet can close', () => {
  const notesBox = () =>
    screen.getByPlaceholderText(appConfig.copy.contextPanel.notesPlaceholder) as HTMLTextAreaElement

  // Regression (Feldtest 07.09.): the field committed only on BLUR, and a swipe-dismiss /
  // slot swap unmounts the focused textarea without one — the typed Notiz died with the sheet.
  it('commits a draft on unmount, when no blur ever fired', () => {
    const onNotes = vi.fn()
    const { unmount } = render(
      <ContextPanel entity={{ id: 's1', symbol: 'VKF Feuer', label: 'Brand' }} onClose={vi.fn()}
        onTitle={vi.fn()} onFields={vi.fn()} onDelete={vi.fn()} onNotes={onNotes} />,
    )
    fireEvent.change(notesBox(), { target: { value: 'EG stark verraucht' } })
    unmount()
    expect(onNotes).toHaveBeenCalledExactlyOnceWith('EG stark verraucht')
  })

  it('does not commit twice when blur already wrote the value (the ordinary close)', () => {
    const onNotes = vi.fn()
    const { unmount } = render(
      <ContextPanel entity={{ id: 's1', symbol: 'VKF Feuer', label: 'Brand' }} onClose={vi.fn()}
        onTitle={vi.fn()} onFields={vi.fn()} onDelete={vi.fn()} onNotes={onNotes} />,
    )
    fireEvent.change(notesBox(), { target: { value: 'EG stark verraucht' } })
    fireEvent.blur(notesBox())
    unmount()
    expect(onNotes).toHaveBeenCalledExactlyOnceWith('EG stark verraucht')
  })

  it('writes nothing on unmount when nothing was typed', () => {
    const onNotes = vi.fn()
    const { unmount } = render(
      <ContextPanel entity={{ id: 's1', symbol: 'VKF Feuer', label: 'Brand', notes: 'alt' }} onClose={vi.fn()}
        onTitle={vi.fn()} onFields={vi.fn()} onDelete={vi.fn()} onNotes={onNotes} />,
    )
    unmount()
    expect(onNotes).not.toHaveBeenCalled()
  })
})
