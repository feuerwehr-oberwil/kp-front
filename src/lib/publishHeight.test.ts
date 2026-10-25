// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { publishHeight } from './publishHeight'

describe('publishHeight', () => {
  it('puts the height on :root while mounted and removes it on unmount', () => {
    const el = document.createElement('section')
    el.getBoundingClientRect = () => ({ height: 214.4 }) as DOMRect
    const cleanup = publishHeight('--card-h')(el)
    expect(document.documentElement.style.getPropertyValue('--card-h')).toBe('215px')
    cleanup?.()
    expect(document.documentElement.style.getPropertyValue('--card-h')).toBe('')
  })
})
