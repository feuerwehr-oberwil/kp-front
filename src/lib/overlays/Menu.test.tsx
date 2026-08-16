// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Menu } from './Menu'

afterEach(cleanup)

describe('Menu', () => {
  it('opens on trigger click and renders its items', () => {
    render(<Menu trigger={<button>Aktionen</button>} items={[{ label: 'Umbenennen', onClick: vi.fn() }, { label: 'Löschen', onClick: vi.fn(), danger: true }]} />)
    expect(screen.queryByText('Umbenennen')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Aktionen' }))
    expect(screen.getByRole('menuitem', { name: 'Umbenennen' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Löschen' })).toBeTruthy()
  })

  // The popup is portalled to <body> inside a positioner that Base UI transforms — which makes
  // the positioner a stacking context, so a z-index on the popup is inert. `.ui-menu-pos` is the
  // one hook the stylesheet has to lift the whole menu over fixed chrome; without it every row
  // action in the admin opened invisible and unclickable (shipped that way in v0.6.0). jsdom has
  // no compositor, so this guards the hook, and e2e/admin-row-menu.spec.ts guards the paint.
  it('puts the class the stylesheet stacks on onto the positioner, not the popup', () => {
    render(<Menu trigger={<button>Aktionen</button>} items={[{ label: 'Umbenennen', onClick: vi.fn() }]} popupClassName="adm-menu-list" />)
    fireEvent.click(screen.getByRole('button', { name: 'Aktionen' }))
    const popup = screen.getByRole('menu')
    expect(popup.className).toContain('adm-menu-list')
    expect(popup.parentElement?.className).toContain('ui-menu-pos')
  })

  it('runs the item onClick and closes on select', () => {
    const onClick = vi.fn()
    render(<Menu trigger={<button>Aktionen</button>} items={[{ label: 'Umbenennen', onClick }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Aktionen' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Umbenennen' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menuitem', { name: 'Umbenennen' })).toBeNull()
  })

  it('does not fire onClick for a disabled item', () => {
    const onClick = vi.fn()
    render(<Menu trigger={<button>Aktionen</button>} items={[{ label: 'Gesperrt', onClick, disabled: true }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Aktionen' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Gesperrt' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  // A heading used to render a bare Base UI GroupLabel, which reads the id it announces out of a
  // group context and THROWS when there is none — opening the Rapport's print menu took the whole
  // app down. The shape of the Rapport's menu is reproduced here (action · rule · heading · ticks
  // split by a second rule) because that combination is what broke.
  it('renders a heading without crashing, and groups the rows under it', () => {
    render(
      <Menu
        trigger={<button>Drucken</button>}
        items={[
          { label: 'Einsatzrapport (PDF)', onClick: vi.fn() },
          { kind: 'sep' },
          { kind: 'head', label: 'Abschnitte' },
          { kind: 'check', label: 'Kroki', checked: true, onChange: vi.fn() },
          { kind: 'sep' },
          { kind: 'check', label: 'Verlauf', checked: false, onChange: vi.fn() },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Drucken' }))
    expect(screen.getByText('Abschnitte')).toBeTruthy()
    // the rule between the two runs of ticks divides the group, it does not end it — otherwise
    // «Abschnitte» would name only the ticks above the rule
    const group = screen.getByRole('group')
    expect(group.textContent).toContain('Kroki')
    expect(group.textContent).toContain('Verlauf')
    // the action above the heading stays OUT of it — it is not one of the sections
    expect(group.textContent).not.toContain('Einsatzrapport (PDF)')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Kroki' }).getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the menu open when a checkbox row is flipped', () => {
    const onChange = vi.fn()
    render(
      <Menu
        trigger={<button>Drucken</button>}
        items={[{ kind: 'head', label: 'Abschnitte' }, { kind: 'check', label: 'Kroki', checked: false, onChange }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Drucken' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Kroki' }))
    expect(onChange).toHaveBeenCalledWith(true, expect.anything())
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Kroki' })).toBeTruthy()
  })
})
