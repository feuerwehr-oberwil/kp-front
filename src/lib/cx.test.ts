import { describe, expect, it } from 'vitest'
import { cx } from './cx'

describe('cx', () => {
  it('joins truthy class names with a space', () => {
    expect(cx('a', 'b', 'c')).toBe('a b c')
  })

  it('drops falsy entries (false / null / undefined / empty string)', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b')
  })

  it('supports the conditional-class idiom', () => {
    const sel = true
    const off = false
    expect(cx('row', sel && 'sel', off && 'hidden')).toBe('row sel')
  })

  it('returns an empty string when nothing is truthy', () => {
    expect(cx(false, null, undefined, '')).toBe('')
    expect(cx()).toBe('')
  })
})
