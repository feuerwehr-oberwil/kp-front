import { formatDateTime } from './report'
import { describe, it, expect } from 'vitest'
import { buildDirectReportPayload, einsatzleiterForPdf, floorStackPages, forPaper, planAnnosForPdf, usedStackFloors } from './reportPdfDirect'
import { TILE_AR } from './whiteboard'
import type { BoardAnno, BuildingDoc, PlanDocument, TimelineEvent, Trupp } from '../types'

describe('planAnnosForPdf', () => {
  it('resolves a plan shape to a client-rendered svg glyph with its plan-relative size', () => {
    const annos: BoardAnno[] = [{ id: 'sh1', kind: 'shape', shape: 'cloud', x: 0.5, y: 0.5, sizeN: 0.2, color: '#123456', label: 'Rauch' }]
    const [out] = planAnnosForPdf(annos)
    expect(out.kind).toBe('symbol') // travels through the server's existing symbol branch
    expect(String(out.symbolSvg)).toContain('#123456')
    expect(out.sizeN).toBe(0.2)
    expect(out.label).toBeUndefined() // the implicit shape name must not print as a label
  })

  it('sends the badges the board draws on the glyph – storey, von/bis, count, Entwicklung', () => {
    const annos: BoardAnno[] = [{
      id: 's1', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.3,
      storey: 2, floorFrom: -1, floorTo: 3, count: 4, spread: { up: true },
    }]
    const [out] = planAnnosForPdf(annos)
    expect(out.storey).toBe(2)
    expect(out.floorFrom).toBe(-1)
    expect(out.floorTo).toBe(3)
    expect(out.count).toBe(4)
    expect(out.spread).toEqual({ up: true })
  })

  it('never sends the floor-stack TILE INDEX as a storey badge', () => {
    // ⚠️ `floor` on a BoardAnno is the tile the symbol sits on, `storey` the signed badge
    // (types · BoardAnno). Sending the tile index would stamp «+3» on the fourth sheet.
    const [out] = planAnnosForPdf([{ id: 's2', kind: 'symbol', symbol: 'VKF Feuer', x: 0.5, y: 0.5, floor: 3 }])
    expect(out.storey).toBeUndefined()
    expect(out.floor).toBeUndefined()
  })

  it('sends the symbol\'s LEGEND line – Art first, then what was typed on it', () => {
    // ⚠️ Same call as the Kroki payload (lib/symbols · symbolLegendText), so every sheet of the
    // rapport words the same symbol the same way. NOT the screen's value-only caption: lifted
    // into a legend, «Benzin» alone names no object (18.09.2026).
    const anno: BoardAnno = { id: 's3', kind: 'symbol', symbol: 'FW Gefahr Tafel', x: 0.5, y: 0.5, fields: { 'UN-Nr.': '1203', Stoff: 'Benzin' } }
    expect(planAnnosForPdf([anno])[0].caption).toBe('Gefahrentafel · 1203 · Benzin')
    expect(planAnnosForPdf([anno], 'off')[0].caption).toBeUndefined()   // Beschriftungen aus
  })

  it('gives a symbol with nothing typed on it a legend line too – its Art', () => {
    // every glyph on the sheet can be looked up; the reader need not know the FKS signature
    const [out] = planAnnosForPdf([{ id: 's4', kind: 'symbol', symbol: 'SI Ueberflurhydrant', x: 0.5, y: 0.5 }])
    expect(out.caption).toBe('Überflurhydrant')
  })

  it('falls back to the shape defaults when colour/size were never touched', () => {
    const [out] = planAnnosForPdf([{ id: 'sh2', kind: 'shape', shape: 'arrow', x: 0.1, y: 0.1 }])
    expect(String(out.symbolSvg)).toContain('<svg')
    expect(typeof out.sizeN).toBe('number')
  })

  it('sends a stretched shape\'s aspect, and only when it stretches', () => {
    const [rect] = planAnnosForPdf([{ id: 'sh3', kind: 'shape', shape: 'square', x: 0.5, y: 0.5, sizeN: 0.2, aspect: 0.5 }])
    expect(rect.aspect).toBe(0.5)
    // absent / 1 stays off the wire; the aspect-locked Pfeil never stretches on paper
    expect(planAnnosForPdf([{ id: 'sh4', kind: 'shape', shape: 'square', x: 0.5, y: 0.5, sizeN: 0.2 }])[0].aspect).toBeUndefined()
    expect(planAnnosForPdf([{ id: 'sh5', kind: 'shape', shape: 'arrow', x: 0.5, y: 0.5, sizeN: 0.2, aspect: 3 }])[0].aspect).toBeUndefined()
  })

  it('bakes the arrow\'s Stopp-Balken into the printed glyph', () => {
    const [out] = planAnnosForPdf([{ id: 'sh6', kind: 'shape', shape: 'arrow', x: 0.5, y: 0.5, stop: true }])
    expect(String(out.symbolSvg)).toContain('M20 7 L80 7')
    const [plain] = planAnnosForPdf([{ id: 'sh7', kind: 'shape', shape: 'arrow', x: 0.5, y: 0.5 }])
    expect(String(plain.symbolSvg)).not.toContain('M20 7')
  })
})

describe('floorStackPages', () => {
  const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
  const building: BuildingDoc = { ring, ringAspect: 0.8, floors: [1, 0, -1], src: [ring], orientDeg: 0, northUp: true }
  const plan: PlanDocument = { id: 'gebaeude', code: 'GB', title: 'Gebäude', subtitle: '', imageUrl: '', orientation: 'portrait', floorStack: true }
  // one mark per storey: only a storey that carries something prints (see the last test here)
  const onEvery = (floors: number[]): BoardAnno[] => floors.map((f) => ({ id: `m${f}`, kind: 'text', x: 0.5, y: 0.5, floor: f, text: `m${f}` }))

  it('chunks max 2 storeys per page, top storey first, with matching aspects and labels', () => {
    const pages = floorStackPages(plan, building, onEvery(building.floors))
    expect(pages).toHaveLength(2)
    expect(pages[0].label).toBe('Gebäude · 1. OG – EG')
    expect(pages[0].blankAspect).toBeCloseTo(2 * TILE_AR)
    expect(pages[1].label).toBe('Gebäude · 1. UG')
    // every page is the SAME shape, whether it carries two storeys or one: a mixed stack came
    // out of the printer half upright and half sideways
    expect(pages[1].blankAspect).toBeCloseTo(2 * TILE_AR)
  })

  it('lifts tile-local annos into page space on the right page', () => {
    const annos: BoardAnno[] = [
      { id: 'a', kind: 'symbol', symbol: 'VKF Feuer', x: 0.5, y: 0.5, floor: 0 },   // EG → page 1, lower tile
      { id: 'b', kind: 'draw', pts: [[0.2, 0.4], [0.8, 0.6]], floor: -1, color: '#1f6feb' }, // UG → page 2
      ...onEvery([1]),                                                               // keeps the 1. OG on page 1
    ]
    const pages = floorStackPages(plan, building, annos)
    const sym = pages[0].annos.find((x) => x.symbol === 'VKF Feuer')!
    expect(sym.y).toBeCloseTo((1 + 0.5) / 2) // second tile of a 2-tile page
    // the last page keeps the page's band grid, so its single storey sits in the TOP band
    expect(pages[1].annos.some((x) => x.kind === 'draw' && Array.isArray(x.pts) && (x.pts as number[][])[0][1] === 0.2)).toBe(true)
    // an anno on a storey the building no longer has is dropped, not misplaced
    expect(floorStackPages(plan, building, [{ id: 'c', kind: 'text', x: 0.5, y: 0.5, floor: 4, text: 'x' }])
      .flatMap((p) => p.annos).some((x) => x.text === 'x')).toBe(false)
  })

  it('draws chrome on every page: outline area, floor-label pill, dial only on the first', () => {
    const pages = floorStackPages(plan, building, onEvery(building.floors))
    for (const p of pages) {
      expect(p.annos.some((x) => x.kind === 'area')).toBe(true)
      expect(p.annos.some((x) => x.kind === 'text')).toBe(true)
    }
    // the dial is a 'north' anno carrying only the ANGLE — the glyph itself is the server's, so
    // the Gebäude page and the Kroki cannot drift into two different north marks again
    expect(pages[0].annos.filter((x) => x.kind === 'north')).toHaveLength(1)
    expect(pages[0].annos.find((x) => x.kind === 'north')).toMatchObject({ deg: 0 })
    expect(pages[1].annos.some((x) => x.kind === 'north')).toBe(false)
    // outline points stay inside the page box
    const pts = pages[0].annos.filter((x) => x.kind === 'area').flatMap((x) => x.pts as number[][])
    for (const [x, y] of pts) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1) }
  })

  // ⚠️ A Geschossplan page carries whatever bearing the architect's sheet had, and only the pack's
  // approved map fit knows it – which this function is not given. Printing the dial at the view
  // angle was a printed claim that the page is north-up (16.09.2026).
  it('prints no north dial for a plan-based Gebäude, and draws no frame outline either', () => {
    const pack: BuildingDoc = {
      ring: [], rings: [], ringAspect: 0.4, floors: [1, 0],
      pack: { aspect: 1, frame: [0.1, 0.1, 0.3, 0.9] }, viewDeg: 90,
    }
    const pages = floorStackPages(plan, pack, onEvery(pack.floors))
    expect(pages[0].annos.some((x) => x.kind === 'north')).toBe(false)
    expect(pages[0].annos.some((x) => x.kind === 'area')).toBe(false)
    // the storey labels are still there – the page is a stack, dial or no dial
    expect(pages[0].annos.filter((x) => x.kind === 'text' && !String(x.text).startsWith('m'))).toHaveLength(2)
  })

  // ⚠️ 18.09.2026: the demo Einsatz printed two Gebäude sheets for ONE Trupp chip — the second a
  // bare EG outline. An empty storey tells the reader nothing the storey labels do not.
  it('prints only the storeys that carry something, and no page at all for an untouched stack', () => {
    expect(floorStackPages(plan, building, [])).toEqual([])
    const pages = floorStackPages(plan, building, [
      { id: 'a', kind: 'resource', x: 0.4, y: 0.2, floor: 1, text: 'Müller H.' },
      // a Leitung counts on every storey it PASSES, not only the one it is filed under
      { id: 'b', kind: 'draw', floor: 1, pts: [[0.2, 0.4, 1], [0.8, 0.6, -1]], color: '#1f6feb' },
    ])
    expect(pages.map((p) => p.label)).toEqual(['Gebäude · 1. OG – 1. UG'])
    expect(usedStackFloors(building, [{ id: 'c', kind: 'text', x: 0.5, y: 0.5, floor: 4, text: 'x' }])).toEqual([])
  })
})

// The app writes «EL → Sanität» with a real arrow; ReportLab sets the rapport in Helvetica, which
// has no glyph for one and would draw a black box on the copy that gets signed.
describe('forPaper', () => {
  it('maps both arrows to what Helvetica can set, anywhere in the payload', () => {
    expect(forPaper({
      journal: [{ text: 'EL → Sanität: Patient stabil' }, { text: 'Polizei ← EL' }],
      draft: { kurzbericht: 'Übergabe → KSBL' },
    })).toEqual({
      journal: [{ text: 'EL -> Sanität: Patient stabil' }, { text: 'Polizei <- EL' }],
      draft: { kurzbericht: 'Übergabe -> KSBL' },
    })
  })

  it('leaves everything else exactly as it was — numbers, nulls, plain text', () => {
    const payload = { n: 3, ok: true, nothing: null, s: 'Hauptstrasse 4 – 2. OG', list: ['a', 'b'] }
    expect(forPaper(payload)).toEqual(payload)
  })
})

// The rapport field only holds the LATEST Einsatzleiter; a mid-Einsatz handover is read out of
// the Verlauf's own Rapportangaben rows (lib/report · einsatzleiterSuccession) and printed as
// one continuous chain — the «bis» of one span is the «ab» of the next.
describe('einsatzleiterForPdf', () => {
  // local ISO (no Z), so the printed hh:mm is timezone-independent in the test
  const row = (id: string, at: string, name: string): TimelineEvent =>
    ({ id, t: at.slice(11, 16), at, text: `Rapportangaben: Einsatzleiter «${name}»` }) as TimelineEvent
  const bounds = { alarmedAt: '2026-08-29T12:50:00', endedAt: '2026-08-29T16:00:00' }
  // newest first, like the Verlauf array
  const rotated = [
    row('e2', '2026-08-29T14:20:00', 'Huber Beat'),
    row('e1', '2026-08-29T13:00:00', 'Meier Anna'),
  ]

  it('single span → the field value, unchanged', () => {
    expect(einsatzleiterForPdf('Meier Anna', [rotated[1]], bounds)).toBe('Meier Anna')
    expect(einsatzleiterForPdf('Meier Anna', [], bounds)).toBe('Meier Anna')
  })

  it('a rotation prints the succession: «A (bis t), B (ab t)» on the shared handover instant', () => {
    expect(einsatzleiterForPdf('Huber Beat', rotated, bounds))
      .toBe('Meier Anna (bis 14:20), Huber Beat (ab 14:20)')
  })

  it('re-saving the unchanged name is no handover', () => {
    const events = [row('e3', '2026-08-29T15:00:00', 'Meier Anna'), row('e1', '2026-08-29T13:00:00', 'Meier Anna')]
    expect(einsatzleiterForPdf('Meier Anna', events, bounds)).toBe('Meier Anna')
  })

  it('a just-typed name the log window has not settled yet joins as the newest span', () => {
    expect(einsatzleiterForPdf('Neu Nina', rotated, bounds))
      .toBe('Meier Anna (bis 14:20), Huber Beat, Neu Nina')
  })

  it('the field stays the authority — empty prints the blank write-in rule as always', () => {
    expect(einsatzleiterForPdf(undefined, rotated, bounds)).toBeUndefined()
  })

  it('spans days → the clocks carry their date (the sheet’s one midnight rule)', () => {
    const overnight = { alarmedAt: '2026-08-29T22:00:00', endedAt: '2026-08-30T03:00:00' }
    const events = [row('e2', '2026-08-30T00:15:00', 'Huber Beat'), row('e1', '2026-08-29T22:30:00', 'Meier Anna')]
    expect(einsatzleiterForPdf('Huber Beat', events, overnight))
      .toBe('Meier Anna (bis 30.08. 00:15), Huber Beat (ab 30.08. 00:15)')
  })
})

/* ── The Atemschutz page is a SAFETY document (03.09.) ────────────────────────────────────────
 * It is about cylinders, contact intervals and the Alarmdruck. A Trupp without Atemschutz
 * (types · TruppKind) has none of those, so it is not on that page — it would print an
 * Eingangsdruck of 0 bar and an empty Druckverlauf under a heading asserting it was monitored.
 * Its own actions still reach the paper through the printed Journal. */
describe('buildDirectReportPayload · trupps', () => {
  const trupp = (over: Partial<Trupp>): Trupp => ({
    id: 'x', name: 'X', entryPressureBar: 300, entryTime: '2026-09-03T10:00:00.000Z',
    lastContactTime: '2026-09-03T10:00:00.000Z', status: 'aktiv', readings: [], ...over,
  })
  const payload = (trupps: Trupp[], atemschutz = true) => buildDirectReportPayload({
    incident: { id: 'i1', title: 'Brand', started_at: '2026-09-03T09:50:00.000Z' } as never,
    draft: {
      meta: {}, generatedAt: '2026-09-03T12:00:00.000Z',
      proof: {}, options: { atemschutz },
    } as never,
    trupps, attendance: {}, events: [], plans: [],
  }) as { trupps: { name: string }[] }

  it('prints Trupps under Atemschutz and leaves the plain work squads off the page', () => {
    const out = payload([trupp({ id: 'a', name: 'Meier' }), trupp({ id: 'b', name: 'Verkehr', kind: 'einfach', entryPressureBar: 0 })])
    expect(out.trupps.map((t) => t.name)).toEqual(['Meier'])
  })

  it('a Trupp with no kind is one under Atemschutz — every record written before 03.09.', () => {
    expect(payload([trupp({ name: 'Meier' })]).trupps.map((t) => t.name)).toEqual(['Meier'])
  })

  it('still prints nothing at all when the Atemschutz page is switched off', () => {
    expect(payload([trupp({ name: 'Meier' })], false).trupps).toEqual([])
  })

  // the number, the leader at registration and the crew per cycle travel; the crew rows
  // themselves stay OUT of the Druckverlauf (12.09., docs/trupp-naming.md §5)
  it('carries Trupp N, its leader and the crew per cycle, and keeps crew rows out of the readings', () => {
    const t = trupp({
      id: 'a', no: 2, name: 'Keller Andreas', members: [],
      readings: [
        { t: '2026-09-03T10:00:00.000Z', bar: 300, kind: 'registered' },
        { t: '2026-09-03T10:00:00.000Z', bar: 300, kind: 'crew', crew: { name: 'Meier Anna', members: ['Dürring Jan'] } },
        { t: '2026-09-03T10:05:00.000Z', bar: 300, kind: 'entry' },
        { t: '2026-09-03T10:32:00.000Z', bar: 250, kind: 'crew', crew: { name: 'Keller Andreas', members: ['Dürring Jan'] } },
      ],
    })
    const out = payload([t]) as unknown as { trupps: { no?: number; leader: string; cycles: unknown[]; readings: { kindLabel: string }[] }[] }
    // clocks through the sheet's own formatter — the test must not assume the runner's timezone
    expect(out.trupps[0]).toMatchObject({
      no: 2, leader: 'Meier Anna',
      cycles: [{ entry: formatDateTime('2026-09-03T10:05:00.000Z'), crew: 'Meier Anna / Dürring Jan',
        changes: [{ t: formatDateTime('2026-09-03T10:32:00.000Z'), text: 'Gruppenführer Meier Anna -> Keller Andreas' }] }],
    })
    expect(out.trupps[0].readings.map((r) => r.kindLabel)).toEqual(['Angemeldet', 'Eintritt'])
  })
})

/* ⚠️ ONE list per sheet. The board view a sheet draws already contains the Karte's objects
 * projected onto it, so a print path that concatenated a second «mirrored content» list beside
 * it printed every annotation on a linked plan TWICE — the sheet's own ink included. */
describe('buildDirectReportPayload · plan pages', () => {
  const plan = { id: 'm2', code: 'Modul 2', title: 'Modul 2', subtitle: '', imageUrl: '/m2.pdf', orientation: 'landscape' } as PlanDocument
  const pages = (board: Record<string, BoardAnno[]>) => (buildDirectReportPayload({
    incident: { id: 'i1', title: 'Brand', started_at: '2026-09-03T09:50:00.000Z' } as never,
    draft: { meta: {}, generatedAt: '2026-09-03T12:00:00.000Z', proof: {}, options: { annotatedPlans: true } } as never,
    trupps: [], attendance: {}, events: [], plans: [plan], board,
  }) as { planPages?: { annos: { x?: number }[] }[] }).planPages ?? []

  it('prints each object on a linked sheet exactly ONCE', () => {
    const [page] = pages({ m2: [
      { id: 'own', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.3 },   // the sheet's own
      { id: 'fromMap', kind: 'symbol', symbol: 'VKF Fahrzeug', x: 0.6, y: 0.4 }, // …and the Karte's
    ] })
    expect(page.annos.map((a) => a.x)).toEqual([0.2, 0.6]) // each exactly once, in the sheet's order
  })

  // one figure-page template: the heading, then which Einsatz and which moment — on a plan or
  // Gebäude sheet too, because a sheet pulled out of the stapled rapport has to say what it is
  it('dates every figure page, not only the Kroki', () => {
    const [page] = pages({ m2: [{ id: 'own', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.3 }] }) as unknown as { caption?: string }[]
    expect(page.caption).toContain('Brand')
    expect(page.caption).toContain(formatDateTime('2026-09-03T12:00:00.000Z'))
  })

  it('…and a sheet whose only marks come from the Karte still gets its page', () => {
    expect(pages({ m2: [{ id: 'fromMap', kind: 'symbol', symbol: 'VKF Fahrzeug', x: 0.6, y: 0.4 }] })).toHaveLength(1)
    expect(pages({})).toHaveLength(0)
  })
})
