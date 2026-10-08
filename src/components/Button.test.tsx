// @vitest-environment jsdom
// THE button, THE icon button and THE choice chip (07.10.2026, UI sweep C4). What is pinned is
// what a call site relies on without looking: it never submits a form by accident, the variant
// and size land as classes, an icon button always carries its word, a chip says it is chosen.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, IconButton } from './Button'
import { Chip } from './Chip'
import s from './Button.module.css'
import c from './Chip.module.css'

afterEach(cleanup)

describe('Button', () => {
  it('is type=button unless told otherwise, so it never submits a form by accident', () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault())
    render(<form onSubmit={e => onSubmit(e.nativeEvent)}><Button>Später</Button><Button type="submit">OK</Button></form>)
    expect(screen.getByRole('button', { name: 'Später' }).getAttribute('type')).toBe('button')
    fireEvent.click(screen.getByRole('button', { name: 'Später' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'OK' }).getAttribute('type')).toBe('submit')
  })

  it('wears its variant and size, keeps a placement class, passes the rest through', () => {
    const onClick = vi.fn()
    render(<Button variant="primary" size="lg" block className="here" onClick={onClick} data-x="1">Los</Button>)
    const b = screen.getByRole('button', { name: 'Los' })
    // the look is the global `.ip-btn` family (13-incident · «THE button») — one definition for
    // <Button> and every hand-written .ip-btn
    for (const k of ['ip-btn', 'primary', 'lg', 'block', 'here']) expect(b.classList.contains(k)).toBe(true)
    expect(b.dataset.x).toBe('1')
    fireEvent.click(b)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('go is its own class, the green primary', () => {
    render(<Button variant="go">Am Einsatzort lassen</Button>)
    expect(screen.getByRole('button').className).toBe('ip-btn go')
    expect(readFileSync('src/styles/13-incident.css', 'utf8')).toMatch(/\.ip-btn\.go \{[^}]*var\(--green\)/)
  })

  it('secondary is the base look — no variant class', () => {
    render(<Button>Ändern</Button>)
    expect(screen.getByRole('button').className).toBe('ip-btn')
  })

  it('a disabled button does not fire', () => {
    const onClick = vi.fn()
    render(<Button variant="danger" disabled onClick={onClick}>Löschen</Button>)
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }))
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('IconButton', () => {
  it('its label is the accessible name and the tooltip', () => {
    render(<IconButton label="Schliessen"><svg /></IconButton>)
    const b = screen.getByRole('button', { name: 'Schliessen' })
    expect(b.getAttribute('title')).toBe('Schliessen')
    expect(b.getAttribute('type')).toBe('button')
    expect(b.classList.contains(s.icon)).toBe(true)
  })

  it('takes a different title and the secondary look', () => {
    render(<IconButton label="Standort" title="Standort wird geteilt" variant="secondary"><svg /></IconButton>)
    const b = screen.getByRole('button', { name: 'Standort' })
    expect(b.getAttribute('title')).toBe('Standort wird geteilt')
    expect(b.classList.contains(s.iconSecondary)).toBe(true)
  })
})

describe('Chip', () => {
  it('says chosen with aria-pressed and the selected class', () => {
    render(<><Chip selected>Alle</Chip><Chip selected={false}>Keine</Chip><Chip>Mehr</Chip></>)
    const on = screen.getByRole('button', { name: 'Alle' })
    expect(on.getAttribute('aria-pressed')).toBe('true')
    expect(on.classList.contains(c.on)).toBe(true)
    expect(screen.getByRole('button', { name: 'Keine' }).getAttribute('aria-pressed')).toBe('false')
    // an action chip is not a toggle: no aria-pressed at all
    expect(screen.getByRole('button', { name: 'Mehr' }).hasAttribute('aria-pressed')).toBe(false)
  })
})

// The floor is the point of the components: 44px for every one, 52 for the big action — read
// from the stylesheets, since jsdom lays nothing out.
describe('the touch floor', () => {
  const css = (f: string) => readFileSync(`${process.cwd()}/src/${f}`, 'utf8')
  it('every button and chip stands on --tap', () => {
    expect(css('styles/13-incident.css')).toMatch(/\n\.ip-btn \{[^}]*min-height: var\(--tap\)/)
    expect(css('styles/13-incident.css')).toMatch(/\.ip-btn\.lg \{[^}]*min-height: var\(--tap-lg\)/)
    expect(css('components/Button.module.css')).toMatch(/\.icon \{[^}]*width: var\(--tap\); height: var\(--tap\)/)
    expect(css('components/Chip.module.css')).toMatch(/\.chip \{[^}]*min-height: var\(--tap\)/)
  })
})
