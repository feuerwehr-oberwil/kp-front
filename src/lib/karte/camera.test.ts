import { describe, expect, it } from 'vitest'
import { besidePanel, cameraOnClose, NO_PADDING, returnOnSelect, sameCamera, toolTakesTaps, type Camera } from './camera'

const home: Camera = { center: [7.556, 47.512], zoom: 15.5, padding: NO_PADDING }
// a selection framed in the strip above the phone's sheet (KarteApp · panelPad)
const framed: Camera = { center: [7.5571, 47.5132], zoom: 17.6, padding: { top: 80, bottom: 608, left: 0, right: 0 } }
const other: Camera = { center: [7.5590, 47.5101], zoom: 17.6, padding: { top: 80, bottom: 608, left: 0, right: 0 } }

// owner R4
describe('toolTakesTaps · measuring works on top of objects', () => {
  it('Messen, Punkt setzen and Gefahrgut with rings take every tap', () => {
    expect(toolTakesTaps('measure', 'off')).toBe(true)
    expect(toolTakesTaps('pin', 'off')).toBe(true)
    expect(toolTakesTaps('erg', 'small')).toBe(true)
  })
  it('no tool, Ebenen and Gefahrgut without rings leave a tap on an object to the object', () => {
    expect(toolTakesTaps(null, 'small')).toBe(false)
    expect(toolTakesTaps('layers', 'small')).toBe(false)
    expect(toolTakesTaps('erg', 'off')).toBe(false)
  })
})

// owner R4: «doesn't constantly push the map south»
describe('the camera after a selection closes goes back to where it was', () => {
  it('select → close returns to the camera before the selection, padding included', () => {
    const r = returnOnSelect(null, home)
    expect(cameraOnClose(r, framed)).toEqual(home)
  })

  it('a second selection while one is open keeps the ORIGINAL camera as the way back', () => {
    let r = returnOnSelect(null, home)
    r = returnOnSelect(r, framed) // the next object, picked from «In der Nähe» while the first is open
    expect(cameraOnClose(r, other)).toEqual(home)
  })

  it('nothing to do when the selection never moved the camera', () => {
    expect(cameraOnClose(returnOnSelect(null, home), home)).toBeNull()
  })

  it('the user\'s own move drops the way back: the map stays where they put it', () => {
    // KarteApp sets the way back to null on a movestart with an originalEvent
    expect(cameraOnClose(null, other)).toBeNull()
    // …and the next selection starts a new one from there
    expect(cameraOnClose(returnOnSelect(null, other), framed)).toEqual(other)
  })

  it('a search pick keeps the place but drops the padding: centred on the whole map', () => {
    const r = returnOnSelect(null, home, 'search')
    expect(cameraOnClose(r, framed)).toEqual({ center: framed.center, zoom: framed.zoom, padding: NO_PADDING })
    // already unpadded: stays
    expect(cameraOnClose(r, { ...framed, padding: NO_PADDING })).toBeNull()
  })

  it('repeated select → close never drifts', () => {
    let at = home
    for (let i = 0; i < 5; i++) {
      const r = returnOnSelect(null, at)
      at = cameraOnClose(r, i % 2 ? framed : other) ?? at
    }
    expect(sameCamera(at, home)).toBe(true)
  })
})

// owner R6: «isn't neatly in focus»
describe('the free map beside the tablet\'s panel', () => {
  it('starts right of the panel beside the rail, and ends at the tool rail', () => {
    // 1440 wide: panel 92…496, tool rail 1364…1424 – the middle 930 (e2e/karte-plan-back-camera)
    expect(besidePanel(60, 60)).toEqual({ top: 80, bottom: 0, left: 496, right: 76 })
  })
  it('follows the rail\'s chevron: an expanded rail pushes the free map\'s edge out by its growth', () => {
    expect(besidePanel(196, 60).left - besidePanel(60, 60).left).toBe(136)
  })
})
