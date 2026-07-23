// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ContextPanel, type SymbolView } from './ContextPanel'
import type { SymbolControl } from '../types'

afterEach(cleanup)

// Steppers are keyed by their German labels (appConfig.copy.contextPanel).
const L = { floor: 'Geschoss', count: 'Anzahl', rotation: 'Drehung' }

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

  it('a declared control whose callback is NOT wired stays hidden', () => {
    // controls allows floor, but onFloor is not provided ⇒ the surface can't do it ⇒ hidden
    setup({ controls: new Set<SymbolControl>(['floor', 'rotation']), onFloor: undefined })
    expect(hasStepper(L.floor)).toBe(false)
    expect(hasStepper(L.rotation)).toBe(true)
  })
})

describe('ContextPanel — basic wiring', () => {
  it('renders the entity title and calls onClose from the X button', () => {
    const p = setup({ controls: new Set<SymbolControl>(['rotation']) })
    expect((screen.getByDisplayValue('Brand') as HTMLInputElement).value).toBe('Brand')
    fireEvent.click(screen.getByLabelText('Schliessen'))
    expect(p.onClose).toHaveBeenCalled()
  })

  it('stepping rotation up commits via onRotate', () => {
    const p = setup({ controls: new Set<SymbolControl>(['rotation']), entity: { id: 's1', rotation: 0 } })
    fireEvent.pointerDown(screen.getByLabelText('mehr')) // hold-to-repeat: first step fires on pointer-down
    expect(p.onRotate).toHaveBeenCalledWith(15) // ROT_STEP
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
  it('keeps a missing trailing preset field in canonical order (Name before Stv.)', () => {
    setup({
      entity: { id: 'el1', symbol: 'VKF Einsatzleiter', fields: { Name: 'Müller' } },
      protectedKeys: new Set(['Name', 'Stv.']),
    })
    const keys = screen.getAllByText((_t, el) => el?.className === 'kv-key-ro').map((el) => el.textContent)
    expect(keys).toEqual(['Name', 'Stv.'])
  })

  it('does not seed blank rows on a read-only entity', () => {
    setup({
      entity: { id: 'o3', symbol: 'FW Offizier', fields: { Name: 'Hans' } },
      protectedKeys: new Set(['Funktion', 'Name']),
      readOnly: true,
    })
    expect(screen.queryByText('Funktion')).toBeNull()
  })
})

describe('ContextPanel — live title editing', () => {
  it('with onTitleLive, streams every keystroke live and finalises once on blur', () => {
    const onTitleLive = vi.fn(); const onTitle = vi.fn()
    setup({ entity: { id: 'n1', label: '' }, onTitleLive, onTitle })
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
    setup({ entity: { id: 'n2', label: '' }, onTitle })
    const input = screen.getByDisplayValue('') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Hi' } })
    expect(onTitle).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onTitle).toHaveBeenCalledTimes(1)
    expect(onTitle).toHaveBeenCalledWith('Hi')
  })
})
