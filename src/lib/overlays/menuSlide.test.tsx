// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Menu } from './Menu'
import { attachMenuSlide, slideRow } from './menuSlide'

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

describe('slideRow', () => {
  const popup = document.createElement('div')
  popup.innerHTML = `<div role="menuitem" id="a"><span id="a-label">A</span></div>
    <div role="menuitemcheckbox" id="b"></div>
    <div role="menuitem" id="off" aria-disabled="true"></div>
    <div role="separator" id="sep"></div>
    <button class="row" id="btn"><span id="btn-label">B</span></button>
    <button class="row" id="btn-off" disabled></button>`
  const outside = document.createElement('div')
  outside.innerHTML = '<div role="menuitem" id="x"></div>'
  const $ = (root: Element, id: string) => root.querySelector(`#${id}`)

  it('finds the row under the finger, from any part of it', () => {
    expect(slideRow($(popup, 'a-label'), popup)?.id).toBe('a')
    expect(slideRow($(popup, 'b'), popup)?.id).toBe('b')
    expect(slideRow($(popup, 'btn-label'), popup, '.row')?.id).toBe('btn')
  })
  it('ignores a disabled row, a separator, nothing, and another menu’s row', () => {
    expect(slideRow($(popup, 'off'), popup)).toBeNull()
    expect(slideRow($(popup, 'btn-off'), popup, '.row')).toBeNull()
    expect(slideRow($(popup, 'sep'), popup)).toBeNull()
    expect(slideRow(null, popup)).toBeNull()
    expect(slideRow($(outside, 'x'), popup)).toBeNull()
  })
})

/** the element elementFromPoint reports — jsdom has no layout, so the finger's target is staged */
function under(el: Element | null) { vi.spyOn(document, 'elementFromPoint').mockReturnValue(el) }
document.elementFromPoint ??= () => null
const at = (y: number) => [{ clientX: 10, clientY: y }]
const lit = (el: Element) => el.hasAttribute('data-slide-on')

describe('Menu · finger slide', () => {
  async function openMenu(items: Parameters<typeof Menu>[0]['items']) {
    render(<Menu trigger={<button>Filter</button>} items={items} />)
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    return screen.findByRole('menu')
  }

  it('lights the row under a sliding finger, unlights it when the finger leaves, presses the one it lifts on', async () => {
    const a = vi.fn(), b = vi.fn()
    const menu = await openMenu([{ label: 'Alle', onClick: a }, { label: 'Anwesend', onClick: b }])
    const [rowA, rowB] = screen.getAllByRole('menuitem')
    fireEvent.touchStart(menu, { touches: at(10) })
    under(rowA)
    fireEvent.touchMove(menu, { touches: at(30) })
    expect(lit(rowA)).toBe(true)
    under(rowB)
    fireEvent.touchMove(menu, { touches: at(60) })
    expect([lit(rowA), lit(rowB)]).toEqual([false, true])
    fireEvent.touchEnd(menu, { changedTouches: at(60) })
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
    expect(lit(rowB)).toBe(false)
  })

  it('toggles a checkbox row on lift and stays open; lifting off the rows does nothing and lights nothing', async () => {
    const onChange = vi.fn()
    const act = vi.fn()
    const menu = await openMenu([{ label: 'Aktion', onClick: act }, { kind: 'check', label: 'Nur Offiziere', checked: false, onChange }])
    const check = screen.getByRole('menuitemcheckbox')
    fireEvent.touchStart(menu, { touches: at(10) })
    under(check)
    fireEvent.touchMove(menu, { touches: at(60) })
    fireEvent.touchEnd(menu, { changedTouches: at(60) })
    expect(onChange).toHaveBeenCalledWith(true, expect.anything())
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.touchStart(menu, { touches: at(10) })
    under(check)
    fireEvent.touchMove(menu, { touches: at(60) })
    under(document.body)
    fireEvent.touchMove(menu, { touches: at(300) })
    expect(lit(check)).toBe(false)
    fireEvent.touchEnd(menu, { changedTouches: at(300) })
    expect(act).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('attachMenuSlide · a hand-rolled menu (the Einsatz menu’s rows)', () => {
  function popup(scrolls = false) {
    const el = document.createElement('div')
    el.innerHTML = `<button class="row" id="a">Alle Einsätze</button>
      <button class="row" id="b">Einsatz eröffnen</button>
      <input id="q" />`
    if (scrolls) {
      Object.defineProperty(el, 'scrollHeight', { value: 600 })
      Object.defineProperty(el, 'clientHeight', { value: 300 })
    }
    document.body.append(el)
    const [a, b] = [el.querySelector<HTMLButtonElement>('#a')!, el.querySelector<HTMLButtonElement>('#b')!]
    const clicks = { a: vi.fn(), b: vi.fn() }
    a.onclick = clicks.a
    b.onclick = clicks.b
    return { el, a, b, clicks, detach: attachMenuSlide(el, '.row') }
  }

  it('the highlight follows the finger from row to row; the lift picks the row it ends on', () => {
    const { el, a, b, clicks } = popup()
    fireEvent.touchStart(a, { touches: at(10) })
    under(a)
    fireEvent.touchMove(a, { touches: at(20) })
    expect(lit(a)).toBe(true)
    under(b)
    const move = fireEvent.touchMove(a, { touches: at(60) })
    expect(move).toBe(false) // preventDefault: the slide owns the touch, nothing pans
    expect([lit(a), lit(b)]).toEqual([false, true])
    expect(fireEvent.touchEnd(a, { changedTouches: at(60) })).toBe(false) // no click on the start row
    expect(clicks.b).toHaveBeenCalledTimes(1)
    expect(clicks.a).not.toHaveBeenCalled()
    expect(el.querySelector('[data-slide-on]')).toBeNull()
  })

  it('a plain tap is the browser’s: nothing is lit, the lift is not taken', () => {
    const { a, clicks } = popup()
    fireEvent.touchStart(a, { touches: at(10) })
    under(a)
    fireEvent.touchMove(a, { touches: at(13) })
    expect(lit(a)).toBe(false)
    expect(fireEvent.touchEnd(a, { changedTouches: at(13) })).toBe(true)
    expect(clicks.a).not.toHaveBeenCalled()
  })

  it('a list that scrolls keeps its scroll, and a drag from a text field stays the field’s', () => {
    const scrolling = popup(true)
    fireEvent.touchStart(scrolling.a, { touches: at(10) })
    under(scrolling.b)
    expect(fireEvent.touchMove(scrolling.a, { touches: at(60) })).toBe(true)
    expect(lit(scrolling.b)).toBe(false)
    scrolling.detach()

    const field = popup()
    const q = field.el.querySelector('#q')!
    fireEvent.touchStart(q, { touches: at(10) })
    under(field.b)
    expect(fireEvent.touchMove(q, { touches: at(60) })).toBe(true)
    fireEvent.touchEnd(q, { changedTouches: at(60) })
    expect(field.clicks.b).not.toHaveBeenCalled()
  })
})
