import { describe, it, expect } from 'vitest'
import { NOTE_SIZE_SCALE, NOTE_WN, NOTE_W_PX, clampNoteWN, clampNoteWPx, isNoteBox, noteScale } from './notes'

describe('note sizing', () => {
  it('treats an absent size as normal', () => {
    expect(noteScale(undefined)).toBe(1)
    expect(noteScale('m')).toBe(1)
  })

  it('scales small down and large up', () => {
    expect(noteScale('s')).toBeLessThan(1)
    expect(noteScale('l')).toBeGreaterThan(1)
  })

  // the Python renderer hard-codes these same three numbers (kroki.py NOTE_SIZE_SCALE); if
  // they drift, a heading on screen prints as body text
  it('keeps the three steps the print side mirrors', () => {
    expect(NOTE_SIZE_SCALE).toEqual({ s: 0.8, m: 1, l: 1.45 })
  })
})

describe('isNoteBox', () => {
  // this is the whole back-compat hinge: every note stored before text boxes existed has no
  // width, and must keep rendering as the one-line pill it was
  it('is false without a width, so a legacy note stays a one-liner', () => {
    expect(isNoteBox(undefined)).toBe(false)
    expect(isNoteBox(0)).toBe(false)
  })

  it('is true once a width is set', () => {
    expect(isNoteBox(0.2)).toBe(true)
    expect(isNoteBox(220)).toBe(true)
  })
})

describe('width clamps', () => {
  it('stops a shaky drag making a sliver or a sheet-wide band on the plan', () => {
    expect(clampNoteWN(0.0001)).toBe(NOTE_WN.min)
    expect(clampNoteWN(5)).toBe(NOTE_WN.max)
    expect(clampNoteWN(0.25)).toBe(0.25)
  })

  it('does the same on the map, in whole screen px', () => {
    expect(clampNoteWPx(2)).toBe(NOTE_W_PX.min)
    expect(clampNoteWPx(9999)).toBe(NOTE_W_PX.max)
    expect(clampNoteWPx(220.4)).toBe(220)
  })

  it('seeds a conversion default that survives its own clamp', () => {
    expect(clampNoteWN(NOTE_WN.def)).toBe(NOTE_WN.def)
    expect(clampNoteWPx(NOTE_W_PX.def)).toBe(NOTE_W_PX.def)
  })
})
