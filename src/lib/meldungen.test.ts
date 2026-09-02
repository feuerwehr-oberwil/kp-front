import { describe, it, expect } from 'vitest'
import { rankMeldungen, type Meldung, type MeldungKind, type MeldungTone } from './meldungen'

// The order is the ONE guarantee the strip still makes: since 23.08. every pending message is a
// visible row, so nothing can be hidden — but a tier-1/2 message must stand at the top, above
// anything that would go away by itself.

const TONE: Record<MeldungKind, MeldungTone> = {
  atemschutz: 'alarm', alarm: 'alarm', reminder: 'warn', gps: 'warn', review: 'info', tabLock: 'info', symbols: 'warn', basemap: 'warn', session: 'warn', update: 'calm', install: 'calm',
}
const m = (kind: MeldungKind, id: string = kind): Meldung => ({ id, kind, tone: TONE[kind], icon: 'bell', title: kind })

describe('rankMeldungen', () => {
  it('has nothing to order when nothing is pending — the strip pays 0px on a quiet Einsatz', () => {
    expect(rankMeldungen([])).toEqual([])
  })

  it('ranks by class, not by arrival — «Update bereit» never stands above a due Wiedervorlage', () => {
    const rows = rankMeldungen([m('update'), m('install'), m('reminder')])
    expect(rows.map((r) => r.kind)).toEqual(['reminder', 'update', 'install'])
  })

  it('orders every kind, so the strip reads best-first from the top down', () => {
    const all: MeldungKind[] = ['install', 'update', 'session', 'basemap', 'symbols', 'tabLock', 'review', 'gps', 'reminder', 'alarm', 'atemschutz']
    expect(rankMeldungen(all.map((k) => m(k))).map((r) => r.kind))
      .toEqual(['atemschutz', 'alarm', 'reminder', 'gps', 'review', 'tabLock', 'symbols', 'basemap', 'session', 'update', 'install'])
  })

  it('keeps arrival order inside one class — two paused GPS connections stay in the order they came', () => {
    expect(rankMeldungen([m('gps', 'gps:a'), m('gps', 'gps:b')]).map((r) => r.id)).toEqual(['gps:a', 'gps:b'])
  })

  it('puts rank 1–3 first whatever else is pending', () => {
    const noise: MeldungKind[] = ['gps', 'review', 'tabLock', 'update', 'install']
    for (const urgent of ['atemschutz', 'alarm', 'reminder'] as const) {
      expect(rankMeldungen([...noise.map((k) => m(k)), m(urgent)])[0].kind).toBe(urgent)
    }
  })

  // ⚠️ The one ordering that is a safety statement, not a preference: the Atemschutz alarm is the
  // only message here about a person who can die, and the tone that comes with it must not point
  // at the row UNDER an untaken dispatch.
  it('stands the Atemschutz alarm above a waiting dispatch', () => {
    expect(rankMeldungen([m('alarm'), m('atemschutz')]).map((r) => r.kind)).toEqual(['atemschutz', 'alarm'])
  })

  it('does not mutate what the publishers handed it', () => {
    const given = [m('update'), m('alarm')]
    rankMeldungen(given)
    expect(given.map((g) => g.kind)).toEqual(['update', 'alarm'])
  })
})
