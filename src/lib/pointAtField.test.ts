// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pointAtField } from './pointAtField'

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })

describe('pointAtField — the answer to a tap on a blocked save', () => {
  it('rings the field, scrolls to it, focuses what it is asked to, and lets the ring go', () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<label id="f"><input id="i"></label>'
    const field = document.getElementById('f')!
    const input = document.getElementById('i')!
    field.scrollIntoView = vi.fn()
    pointAtField(field, { focus: input })
    expect(field.classList.contains('field-flash')).toBe(true)
    // jsdom has no layout, which counts as «not in view»
    expect(field.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(input)
    vi.advanceTimersByTime(1900)
    expect(field.classList.contains('field-flash')).toBe(false)
  })

  it('takes a module ring in place of the global one, and ignores a field that is not there', () => {
    document.body.innerHTML = '<div id="f"></div>'
    const field = document.getElementById('f')!
    pointAtField(field, { className: 'formFlash' })
    expect(field.className).toBe('formFlash')
    expect(() => pointAtField(null)).not.toThrow()
  })
})
