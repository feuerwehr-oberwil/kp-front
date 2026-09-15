import { describe, expect, it } from 'vitest'
import type { Trupp } from '../types'
import { leitungOptions, lineTakesTrupp, lineTruppId, markerTakesLineEnd, nextFreeLineNo, resolveLinkNumber, truppForLine, truppIdForAttachment, teamLineBadges, truppLineNo, truppLineTone, truppTagText, usedLineNos } from './truppLines'

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

// ── The automatic join (15.09.2026) ────────────────────────────────────────────────────────
// The armed «Leitung wählen» tap mode is gone: a hose end coupled to a Trupp's marker IS the
// pick. This is the half that reads the coupling; the geometry half lives in lineAttachments
// (nearestFreeEndpoint), and the writing half in useTruppActions · linkLineToAttachedTrupp.
describe('truppIdForAttachment (a hose end docked onto a Trupp)', () => {
  const markers = [{ id: 'e1', truppId: 'T1' }, { id: 'e2' }]

  it('names the Trupp standing on the object the end docked onto', () => {
    expect(truppIdForAttachment({ target: { kind: 'object', id: 'e1' }, routing: 'trace' }, markers)).toBe('T1')
  })

  it('says nothing for a marker nobody is standing on, or one that is not there', () => {
    expect(truppIdForAttachment({ target: { kind: 'object', id: 'e2' }, routing: 'trace' }, markers)).toBeUndefined()
    expect(truppIdForAttachment({ target: { kind: 'object', id: 'nope' }, routing: 'direct' }, markers)).toBeUndefined()
  })

  it('says nothing for a branch docked onto another Leitung, or for a free end', () => {
    expect(truppIdForAttachment({ target: { kind: 'line', id: 'd1', endpoint: 'end' }, routing: 'direct' }, markers)).toBeUndefined()
    expect(truppIdForAttachment(undefined, markers)).toBeUndefined()
  })
})

// ── «Ein Etikett» (15.09.2026) ─────────────────────────────────────────────────────────────
// The Karte draws a joined Trupp ONCE: the marker carries the Leitung's number in the hose's
// ink, and that hose draws no end tag. Both halves of that decision come out of one call, so a
// merged label and a suppressed tag can never disagree — and the tag is only ever suppressed for
// the one Leitung a marker actually states.
describe('teamLineBadges (the Leitung merged into its Trupp marker)', () => {
  const line = (id: string, extra: Partial<Parameters<typeof teamLineBadges>[0][number]> = {}) =>
    ({ id, color: '#1f6feb', tone: 'idle' as const, ...extra })

  it('gives the marker the hose\'s number and ink, and takes that hose\'s tag away', () => {
    const { byMarker, merged } = teamLineBadges(
      [line('d1', { lineNo: 2, truppId: 'T1' })], [{ id: 'e1', truppId: 'T1' }],
    )
    expect(byMarker.get('e1')).toEqual({ lineId: 'd1', lineNo: 2, color: '#1f6feb', tone: 'idle', coupled: false })
    expect([...merged]).toEqual(['d1'])
  })

  it('draws the coupling only where the hose really ends ON this marker', () => {
    const coupled = teamLineBadges(
      [line('d1', { lineNo: 1, truppId: 'T1', endObjects: [undefined, 'e1'] })], [{ id: 'e1', truppId: 'T1' }],
    )
    expect(coupled.byMarker.get('e1')?.coupled).toBe(true)
    // linked by NUMBER alone (typed on the Atemschutz board, hose drawn across the street):
    // the label states the link, the picture claims no join nobody made
    const byNumber = teamLineBadges(
      [line('d1', { lineNo: 1, truppId: 'T1', endObjects: [undefined, 'v9'] })], [{ id: 'e1', truppId: 'T1' }],
    )
    expect(byNumber.byMarker.get('e1')?.coupled).toBe(false)
  })

  it('leaves a marker nobody stands on, and a Trupp with no hose, exactly as they were', () => {
    const { byMarker, merged } = teamLineBadges(
      [line('d1', { lineNo: 1, truppId: 'T2' })], [{ id: 'e1' }, { id: 'e2', truppId: 'T1' }],
    )
    expect(byMarker.size).toBe(0)
    expect(merged.size).toBe(0)
  })

  it('states ONE Leitung per marker — the coupled one — and the other hose keeps its tag', () => {
    const { byMarker, merged } = teamLineBadges([
      line('d1', { lineNo: 1, truppId: 'T1' }),
      line('d2', { lineNo: 7, truppId: 'T1', endObjects: ['e1', undefined] }),
    ], [{ id: 'e1', truppId: 'T1' }])
    expect(byMarker.get('e1')?.lineId).toBe('d2')
    expect([...merged]).toEqual(['d2'])
  })

  it('carries the tone across, so a merged marker can inherit the tag\'s label rank', () => {
    const { byMarker } = teamLineBadges(
      [line('d1', { lineNo: 1, truppId: 'T1', tone: 'crit' })], [{ id: 'e1', truppId: 'T1' }],
    )
    expect(byMarker.get('e1')?.tone).toBe('crit')
  })
})

// ── EINE Leitung, EIN Trupp (Bastian, 15.09.2026) ──────────────────────────────────────────
// «lines should only get one trupp per line (i.e not on both ends or similar)». The rule is
// these two functions; every join entry point on the map reads them — the ring pass that offers
// «Anschluss frei» (MapView · freeHoseEnds), the automatic link (useTruppActions ·
// linkLineToAttachedTrupp) and the marker drop (IncidentWorkspace · finishEntityMove).
describe('lineTruppId / lineTakesTrupp (one Trupp per Leitung)', () => {
  it('a free hose takes a Trupp; an anchored one takes no second', () => {
    expect(lineTakesTrupp({ id: 'd1' }, [trupp('t1')])).toBe(true)
    expect(lineTakesTrupp({ id: 'd1', truppId: 't1' }, [trupp('t1')])).toBe(false)
    expect(lineTruppId({ id: 'd1', truppId: 't1' }, [trupp('t1')])).toBe('t1')
  })

  it('…and a hose linked by NUMBER alone is taken too — the far end is just a free end', () => {
    const numbered = [trupp('t1', { lineNo: 2 })]
    expect(lineTakesTrupp({ id: 'd1', lineNo: 2 }, numbered)).toBe(false)
    expect(lineTruppId({ id: 'd1', lineNo: 2 }, numbered)).toBe('t1')
  })

  it('refuses the Trupp that is already on it — that is the both-ends case', () => {
    // the marker in the hand belongs to t1, and t1 is the crew on this very hose
    expect(lineTakesTrupp({ id: 'd1', truppId: 't1' }, [trupp('t1'), trupp('t2')])).toBe(false)
  })

  it('a legacy line carrying TWO Trupps renders the first and is left untouched', () => {
    // recorded before the rule existed: two active Trupps typed the same Leitung number. An
    // incident is a legal record — nothing is rewritten, it simply reads as one.
    const both = [
      trupp('t1', { lineNo: 1, entryTime: '2026-08-05T10:00:00Z' }),
      trupp('t2', { lineNo: 1, entryTime: '2026-08-05T10:20:00Z' }),
    ]
    expect(lineTruppId({ id: 'd1', lineNo: 1 }, both)).toBe('t2') // truppForLine's own order
    expect(lineTakesTrupp({ id: 'd1', lineNo: 1 }, both)).toBe(false)
    expect(both.map((t) => t.lineNo)).toEqual([1, 1])
  })

  it('a Trupp that is OUT still holds its Leitung — the tag is the record of who was on it', () => {
    expect(lineTakesTrupp({ id: 'd1', truppId: 't1' }, [trupp('t1', { status: 'raus' })])).toBe(false)
  })

  it('the ring pass offers no free end on a taken Leitung', () => {
    const lines = [{ id: 'free' }, { id: 'taken', truppId: 't1' }]
    expect(lines.filter((l) => lineTakesTrupp(l, [trupp('t1')])).map((l) => l.id)).toEqual(['free'])
  })
})

// ── …und schon am Magneten (Bastian, 15.09.2026) ───────────────────────────────────────────
// Refusing only the LINK let the hose dock onto a second crew anyway, so the picture still
// showed a Trupp at each end. A taken Leitung therefore does not SEE another Trupp's marker as a
// target: no ring, no dwell, no attach. Read by both snap sites (MapView · candidatesAt,
// Whiteboard · planCandidatesAt); symbols and Fahrzeuge are untouched by it.
describe('markerTakesLineEnd (the hose-end magnet)', () => {
  const nina = { id: 'e1', truppId: 'T1' }
  const hans = { id: 'e2', truppId: 'T2' }
  const trupps = [trupp('T1'), trupp('T2')]

  it('a free Leitung may end at any Trupp marker', () => {
    expect(markerTakesLineEnd({ id: 'd1' }, trupps, nina)).toBe(true)
    expect(markerTakesLineEnd({ id: 'd1' }, trupps, hans)).toBe(true)
  })

  it('a taken Leitung offers ANOTHER Trupp\'s marker no candidate at all', () => {
    expect(markerTakesLineEnd({ id: 'd1', truppId: 'T1' }, trupps, hans)).toBe(false)
  })

  it('…but keeps its OWN, so a coupling pulled off can be put back on', () => {
    expect(markerTakesLineEnd({ id: 'd1', truppId: 'T1' }, trupps, nina)).toBe(true)
  })

  it('holds inside ONE stroke: a draft is judged by the claim its first end made', () => {
    // the surface builds this from truppIdForAttachment over the draft's startAttachment
    const draft = { id: '__draft__', truppId: truppIdForAttachment({ target: { kind: 'object', id: 'e1' }, routing: 'trace' }, [nina, hans]) }
    expect(draft.truppId).toBe('T1')
    expect(markerTakesLineEnd(draft, trupps, hans)).toBe(false)
    expect(markerTakesLineEnd(draft, trupps, nina)).toBe(true)
  })

  it('a marker nobody stands on is never refused — it says nothing about who works the hose', () => {
    expect(markerTakesLineEnd({ id: 'd1', truppId: 'T1' }, trupps, { id: 'e3' })).toBe(true)
    // …and with no line at all (a gesture that is not a hose) nothing is filtered
    expect(markerTakesLineEnd(undefined, trupps, hans)).toBe(true)
  })
})
