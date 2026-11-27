// @vitest-environment jsdom
// The Plan's «Nächstes Objekt» banner stands in the message lane UNDER the top bar (owner, Üben
// feedback 27.11.2026, «what is going on here»): at `top: 12px` it lay under the bar, which floats
// over the full-bleed stage, and only «Anderes Objekt wählen» and its ✕ peeked out beside it.
import { beforeAll, expect, it } from 'vitest'
import { addStyles, appStylesheets } from '../test/dom.test-utils'

// what the app's global stylesheets give the banner on a tablet or laptop – jsdom applies no @media
beforeAll(() => { addStyles(...appStylesheets()) })

it('hangs from the rails\' top, under the top bar, and steps under a standing Meldeleiste', () => {
  document.body.innerHTML = '<div class="wb-nearby-banner"></div>'
  const banner = document.querySelector<HTMLElement>('.wb-nearby-banner')!
  expect(getComputedStyle(banner).top).toBe('var(--rail-top)')
  document.body.insertAdjacentHTML('afterbegin', '<div class="ml"></div>')
  expect(getComputedStyle(banner).top).toBe('calc(var(--rail-top) + var(--ml-h, 0px) + var(--float-gap))')
})
