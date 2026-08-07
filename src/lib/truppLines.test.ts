import { describe, expect, it } from 'vitest'
import type { Trupp } from '../types'
import { leitungOptions, nextFreeLineNo, resolveLinkNumber, truppForLine, truppLineNo, truppLineTone, truppTagText, usedLineNos } from './truppLines'

const trupp = (id: string, over: Partial<Trupp> = {}): Trupp => ({
  id, name: `Leader ${id}`, entryPressureBar: 300, entryTime: '2026-08-05T10:00:00Z',
  lastContactTime: '2026-08-05T10:05:00Z', status: 'aktiv', ...over,
})

describe('truppLineNo (which Leitung a Trupp works on)', () => {
  it('prefers the numeric field and reads legacy free text', () => {
    expect(truppLineNo(trupp('a', { lineNo: 3 }))).toBe(3)
    expect(truppLineNo(trupp('a', { lineNumber: '1' }))).toBe(1)
    expect(truppLineNo(trupp('a', { lineNumber: '01' }))).toBe(1)
    expect(truppLineNo(trupp('a', { lineNumber: 'Ltg 2' }))).toBe(2)
    // the numeric field wins over a stale legacy string
    expect(truppLineNo(trupp('a', { lineNo: 5, lineNumber: '9' }))).toBe(5)
  })

  it('matches nothing when the legacy text names no number', () => {
    expect(truppLineNo(trupp('a', { lineNumber: 'Res' }))).toBeUndefined()
    expect(truppLineNo(trupp('a', { lineNumber: '' }))).toBeUndefined()
    expect(truppLineNo(trupp('a'))).toBeUndefined()
  })
})

describe('truppForLine (anchor OR number)', () => {
  it('resolves by the number alone — one Leitung, drawn on both surfaces', () => {
    const t = trupp('t1', { lineNo: 1 })
    expect(truppForLine({ id: 'lage-line', lineNo: 1 }, [t])?.id).toBe('t1')
    expect(truppForLine({ id: 'plan-line', lineNo: 1 }, [t])?.id).toBe('t1')
    expect(truppForLine({ id: 'other', lineNo: 2 }, [t])).toBeUndefined()
  })

  it('resolves by either side of the anchor, so one surviving half is enough', () => {
    // the drawing remembers (a merge kept the drawing's write)
    expect(truppForLine({ id: 'd1', truppId: 't1' }, [trupp('t1')])?.id).toBe('t1')
    // the Trupp remembers (an undo took the stamped number off the drawing)
    expect(truppForLine({ id: 'd1' }, [trupp('t1', { lineId: 'd1' })])?.id).toBe('t1')
  })

  it('prefers the Trupp that is IN, so a relieved line names who is on it now', () => {
    const out = trupp('old', { lineNo: 1, status: 'raus', exitTime: '2026-08-05T10:20:00Z' })
    const inside = trupp('new', { lineNo: 1, entryTime: '2026-08-05T10:25:00Z' })
    expect(truppForLine({ id: 'd1', lineNo: 1 }, [out, inside])?.id).toBe('new')
    // …and keeps naming the one who left while nobody has taken over
    expect(truppForLine({ id: 'd1', lineNo: 1 }, [out])?.id).toBe('old')
  })

  it('breaks a two-active tie by the later entry (the people currently inside)', () => {
    const early = trupp('early', { lineNo: 1, entryTime: '2026-08-05T10:00:00Z' })
    const late = trupp('late', { lineNo: 1, entryTime: '2026-08-05T10:30:00Z' })
    expect(truppForLine({ id: 'd1', lineNo: 1 }, [early, late])?.id).toBe('late')
  })

  it('lets the explicit anchor beat a bare number match', () => {
    const numbered = trupp('bynum', { lineNo: 1 })
    const picked = trupp('picked', { lineId: 'd1' })
    expect(truppForLine({ id: 'd1', lineNo: 1 }, [numbered, picked])?.id).toBe('picked')
  })
})

describe('tone and tag', () => {
  it('mutes a Trupp that is out and escalates with the tier', () => {
    expect(truppLineTone(trupp('a'), 0)).toBe('idle')
    expect(truppLineTone(trupp('a'), 1)).toBe('warn')
    expect(truppLineTone(trupp('a'), 2)).toBe('crit')
    // out = the record of who worked this Leitung, never an alarm colour
    expect(truppLineTone(trupp('a', { status: 'raus' }), 2)).toBe('muted')
    expect(truppLineTone(trupp('a', { exitTime: '2026-08-05T10:20:00Z' }), 0)).toBe('muted')
  })

  it('abbreviates the leader on the tag — the Trupp symbol is where the full name goes', () => {
    expect(truppTagText(trupp('a', { name: 'Müller Hans' }))).toBe('Müller H.')
  })
})

describe('numbering helpers', () => {
  it('collects the numbers taken on a surface, ignoring the line being edited', () => {
    const lines = [{ id: 'a', lineNo: 1 }, { id: 'b', lineNo: 4 }, { id: 'c' }]
    expect(usedLineNos(lines)).toEqual(new Set([1, 4]))
    expect(usedLineNos(lines, 'a')).toEqual(new Set([4]))
  })

  it('stamps the next free number, skipping ones a Trupp already claims', () => {
    expect(nextFreeLineNo([{ id: 'a', lineNo: 1 }])).toBe(2)
    // Trupp 2 says "Leitung 2" but hasn't drawn it yet — don't hand that number to someone else
    expect(nextFreeLineNo([{ id: 'a', lineNo: 1 }], [trupp('t', { lineNo: 2 })])).toBe(3)
    expect(nextFreeLineNo([])).toBe(1)
  })
})

describe('resolveLinkNumber (what an explicit pick stamps)', () => {
  it('stamps the Trupp’s own number onto the line', () => {
    const t = trupp('t', { lineNo: 1 })
    expect(resolveLinkNumber(t, { id: 'd1' }, [{ id: 'd1' }])).toBe(1)
    // …also when the line already carries a different one
    expect(resolveLinkNumber(t, { id: 'd1', lineNo: 7 }, [{ id: 'd1', lineNo: 7 }])).toBe(1)
  })

  it('lets the drawing win when that number is already taken here', () => {
    const t = trupp('t', { lineNo: 1 })
    const lines = [{ id: 'other', lineNo: 1 }, { id: 'd1', lineNo: 5 }]
    // stamping 1 would make «Leitung 1» ambiguous on this surface — the drawn number stands
    expect(resolveLinkNumber(t, lines[1], lines)).toBe(5)
  })

  it('adopts the line’s number when the Trupp has none, else takes the next free one', () => {
    const t = trupp('t')
    expect(resolveLinkNumber(t, { id: 'd1', lineNo: 4 }, [{ id: 'd1', lineNo: 4 }])).toBe(4)
    expect(resolveLinkNumber(t, { id: 'd1' }, [{ id: 'a', lineNo: 1 }, { id: 'd1' }])).toBe(2)
  })
})

// The shipped demo scene is what a first-time visitor sees — and the one place the whole chain
// (scene file → resolution → tag) is exercised against real data rather than a fixture.
describe('the demo scene resolves to the tag an operator will see', () => {
  it('names Müller H. on Leitung 1 and leaves the feed line anonymous', async () => {
    const { readFileSync } = await import('node:fs')
    const scene = JSON.parse(readFileSync('examples/demo-data/incident.workspace.json', 'utf-8'))
    const t = trupp('trupp1', { name: 'Müller Hans', lineNo: 1, lineId: 'd1784735796244' })
    const angriff = scene.drawings.find((d: { id: string }) => d.id === 'd1784735796244')
    expect(`Ltg ${angriff.lineNo} · ${truppTagText(truppForLine(angriff, [t])!)}`).toBe('Ltg 1 · Müller H.')
    // the hydrant feed carries no Trupp — the link never spreads along the chain
    expect(truppForLine(scene.drawings.find((d: { id: string }) => d.id === 'd1784735505412'), [t])).toBeUndefined()
  })
})

describe('leitungOptions (what the Trupp form offers)', () => {
  it('lists the drawn numbers lowest first and names who is already on one', () => {
    const map = [{ id: 'a', lineNo: 2 }, { id: 'b', lineNo: 1 }, { id: 'c' }]
    const plan = [{ id: 'p', lineNo: 5 }]
    const trupps = [trupp('t1', { name: 'Peter Schmid', lineNo: 2 })]
    expect(leitungOptions(map, plan, trupps)).toEqual([
      { no: 1, onPlan: false, takenBy: undefined },
      { no: 2, onPlan: false, takenBy: 'Peter Schmid' },
      { no: 5, onPlan: true, takenBy: undefined },
    ])
  })

  it('never reads a Trupp’s own Leitung as taken, and ignores one that is out', () => {
    const map = [{ id: 'a', lineNo: 1 }]
    const mine = trupp('me', { name: 'Müller Hans', lineNo: 1 })
    expect(leitungOptions(map, [], [mine], 'me')[0].takenBy).toBeUndefined()
    const gone = trupp('old', { name: 'Alt', lineNo: 1, status: 'raus' })
    expect(leitungOptions(map, [], [gone])[0].takenBy).toBeUndefined()
  })

  it('collapses one Leitung drawn on BOTH surfaces into a single option', () => {
    expect(leitungOptions([{ id: 'm', lineNo: 1 }], [{ id: 'p', lineNo: 1 }], [])).toEqual([
      { no: 1, onPlan: false, takenBy: undefined },
    ])
  })
})
