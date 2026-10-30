import { describe, expect, it } from 'vitest'
import { pickActiveSection } from './scrollSpy'

// a 1000px pane (band line at 300) over a 5000px document
const pane = { viewHeight: 1000, scrollHeight: 5000 }

describe('pickActiveSection', () => {
  it('picks the last section whose top has passed the band line', () => {
    expect(pickActiveSection({ ...pane, scrollTop: 1200, tops: [-1200, -400, 250, 900] })).toBe(2)
    expect(pickActiveSection({ ...pane, scrollTop: 1200, tops: [-1200, -400, 301, 900] })).toBe(1)
  })

  it('re-activates the section above when scrolling back up', () => {
    // the same sections, 700px further up the document: section 1 is the one under the line again
    expect(pickActiveSection({ ...pane, scrollTop: 500, tops: [-500, 300, 950, 1600] })).toBe(1)
  })

  it('stays on the first section before any has reached the line', () => {
    expect(pickActiveSection({ ...pane, scrollTop: 0, tops: [320, 900] })).toBe(0)
  })

  it('picks the last section at the scroll bottom, even when its top never reached the line', () => {
    expect(pickActiveSection({ ...pane, scrollTop: 4000, tops: [-900, 100, 620, 840] })).toBe(3)
    // fractional scroll positions count as the bottom
    expect(pickActiveSection({ ...pane, scrollTop: 3999.4, tops: [-900, 100, 620, 840] })).toBe(3)
  })

  it('reads a pane that does not scroll as its top, not its bottom', () => {
    expect(pickActiveSection({ scrollTop: 0, viewHeight: 1000, scrollHeight: 800, tops: [10, 400, 700] })).toBe(0)
  })

  it('has nothing to pick without sections', () => {
    expect(pickActiveSection({ ...pane, scrollTop: 0, tops: [] })).toBe(-1)
  })
})
