// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { Menu } from './Menu'
import { slideRow } from './menuSlide'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('slideRow', () => {
  const popup = document.createElement('div')
  popup.innerHTML = `<div role="menuitem" id="a"><span id="a-label">A</span></div>
    <div role="menuitemcheckbox" id="b"></div>
    <div role="menuitem" id="off" aria-disabled="true"></div>
    <div role="separator" id="sep"></div>`
  const outside = document.createElement('div')
  outside.innerHTML = '<div role="menuitem" id="x"></div>'
  const $ = (root: Element, id: string) => root.querySelector(`#${id}`)

  it('finds the row under the finger, from any part of it', () => {
    expect(slideRow($(popup, 'a-label'), popup)?.id).toBe('a')
    expect(slideRow($(popup, 'b'), popup)?.id).toBe('b')
  })
  it('ignores a disabled row, a separator, nothing, and another menu’s row', () => {
    expect(slideRow($(popup, 'off'), popup)).toBeNull()
    expect(slideRow($(popup, 'sep'), popup)).toBeNull()
    expect(slideRow(null, popup)).toBeNull()
    expect(slideRow($(outside, 'x'), popup)).toBeNull()
  })
})

describe('Menu · finger slide', () => {
  /** the row elementFromPoint reports — jsdom has no layout, so the finger's target is staged */
  function under(el: Element | null) { vi.spyOn(document, 'elementFromPoint').mockReturnValue(el) }

  async function openMenu(items: Parameters<typeof Menu>[0]['items']) {
    render(<Menu trigger={<button>Filter</button>} items={items} />)
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    return screen.findByRole('menu')
  }

  it('highlights the row under a sliding finger and presses the one it lifts on', async () => {
    const a = vi.fn(), b = vi.fn()
    document.elementFromPoint ??= () => null
    const menu = await openMenu([{ label: 'Alle', onClick: a }, { label: 'Anwesend', onClick: b }])
    const [rowA, rowB] = screen.getAllByRole('menuitem')
    fireEvent.touchStart(menu, { touches: [{ clientX: 10, clientY: 10 }] })
    under(rowB)
    fireEvent.touchMove(menu, { touches: [{ clientX: 10, clientY: 60 }] })
    await waitFor(() => expect(rowB.hasAttribute('data-highlighted')).toBe(true))
    expect(rowA.hasAttribute('data-highlighted')).toBe(false)
    fireEvent.touchEnd(menu, { changedTouches: [{ clientX: 10, clientY: 60 }] })
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
  })

  it('toggles a checkbox row on lift and stays open; lifting off the rows does nothing', async () => {
    const onChange = vi.fn()
    const act = vi.fn()
    document.elementFromPoint ??= () => null
    const menu = await openMenu([{ label: 'Aktion', onClick: act }, { kind: 'check', label: 'Nur Offiziere', checked: false, onChange }])
    const check = screen.getByRole('menuitemcheckbox')
    fireEvent.touchStart(menu, { touches: [{ clientX: 10, clientY: 10 }] })
    under(check)
    fireEvent.touchMove(menu, { touches: [{ clientX: 10, clientY: 60 }] })
    fireEvent.touchEnd(menu, { changedTouches: [{ clientX: 10, clientY: 60 }] })
    expect(onChange).toHaveBeenCalledWith(true, expect.anything())
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.touchStart(menu, { touches: [{ clientX: 10, clientY: 10 }] })
    under(document.body)
    fireEvent.touchMove(menu, { touches: [{ clientX: 300, clientY: 300 }] })
    fireEvent.touchEnd(menu, { changedTouches: [{ clientX: 300, clientY: 300 }] })
    expect(act).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
