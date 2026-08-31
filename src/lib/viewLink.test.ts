import { describe, expect, it } from 'vitest'
import { viewLinkUrl } from './viewLink'

describe('viewLinkUrl', () => {
  it('composes the address from the browser’s own origin', () => {
    expect(viewLinkUrl({ enabled: true, token: 'vAbC123' }, 'https://front.fwo.li'))
      .toBe('https://front.fwo.li/l/vAbC123')
  })

  // the «noch keiner» state is rendered off `enabled` — a half-built URL must never be offered
  it('is empty while there is no link', () => {
    expect(viewLinkUrl({ enabled: false, token: null }, 'https://front.fwo.li')).toBe('')
  })
})
