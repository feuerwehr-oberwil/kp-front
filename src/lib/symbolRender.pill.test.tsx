// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ReadingPill } from './symbolRender'

afterEach(cleanup)

// ENT.3 (17.11.2026): an «erledigt» Messpunkt recedes like every done symbol – its value readable
describe('ReadingPill', () => {
  it('greys an «erledigt» point and keeps its value', () => {
    const props = { symbol: 'FW Messpunkt', fields: { CO: '650' } }
    const live = render(<ReadingPill props={props} />).container.querySelector('.sym-pill')!
    expect(live.className).not.toContain('done')
    cleanup()
    const done = render(<ReadingPill props={{ ...props, done: { at: '2026-11-17T02:00:00Z' } }} />).container.querySelector('.sym-pill')!
    expect(done.className).toContain('done')
    expect(done.textContent).toContain('650')
  })
})
