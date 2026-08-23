import { describe, it, expect } from 'vitest'
import { rankMeldungen, type Meldung, type MeldungKind, type MeldungTone } from './meldungen'

const TONE: Record<MeldungKind, MeldungTone> = {
  alarm: 'alarm', reminder: 'warn', gps: 'warn', review: 'info', tabLock: 'info', update: 'calm', install: 'calm',
}
const m = (kind: MeldungKind, id: string = kind): Meldung => ({ id, kind, tone: TONE[kind], icon: 'bell', title: kind })

describe('rankMeldungen', () => {
  it('renders nothing when nothing is pending', () => {
    // the whole reason the strip is allowed to exist: a quiet Einsatz pays 0px for it
    expect(rankMeldungen([])).toEqual({ lead: null, queue: [], pillTone: null })
  })

  it('ranks by class, not by arrival — «Update bereit» never takes the row from a due Wiedervorlage', () => {
    const { lead, queue } = rankMeldungen([m('update'), m('install'), m('reminder')])
    expect(lead?.kind).toBe('reminder')
    expect(queue.map((q) => q.kind)).toEqual(['update', 'install'])
  })

  it('orders the queue by class too, so «what else is waiting» reads best-first', () => {
    const all: MeldungKind[] = ['install', 'update', 'tabLock', 'review', 'gps', 'reminder', 'alarm']
    const { lead, queue } = rankMeldungen(all.map((k) => m(k)))
    expect(lead?.kind).toBe('alarm')
    expect(queue.map((q) => q.kind)).toEqual(['reminder', 'gps', 'review', 'tabLock', 'update', 'install'])
  })

  it('keeps arrival order inside one class — two paused GPS connections stay in the order they came', () => {
    const { lead, queue } = rankMeldungen([m('gps', 'gps:a'), m('gps', 'gps:b')])
    expect([lead?.id, ...queue.map((q) => q.id)]).toEqual(['gps:a', 'gps:b'])
  })

  it('never demotes rank 1–2, whatever else is on screen', () => {
    const noise: MeldungKind[] = ['gps', 'review', 'tabLock', 'update', 'install']
    for (const protectedKind of ['alarm', 'reminder'] as const) {
      const { lead } = rankMeldungen([...noise.map((k) => m(k)), m(protectedKind)])
      expect(lead?.kind).toBe(protectedKind)
    }
  })

  it('lets the operator pin a queued message forward…', () => {
    const { lead, queue } = rankMeldungen([m('gps'), m('review'), m('update')], 'update')
    expect(lead?.kind).toBe('update')
    expect(queue.map((q) => q.kind)).toEqual(['gps', 'review'])
  })

  it('…including the due Wiedervorlage over an alarm — the two may displace each other…', () => {
    const { lead } = rankMeldungen([m('alarm'), m('reminder')], 'reminder')
    expect(lead?.kind).toBe('reminder')
  })

  it('…but a pin can never hold a calm message in front of one of them', () => {
    const { lead, queue } = rankMeldungen([m('alarm'), m('update')], 'update')
    expect(lead?.kind).toBe('alarm')
    expect(queue.map((q) => q.kind)).toEqual(['update'])
  })

  it('ignores a pin whose message is gone (handled while the list was open)', () => {
    const { lead } = rankMeldungen([m('review'), m('update')], 'reminder')
    expect(lead?.kind).toBe('review')
  })

  it('gives the +n pill the tone of the highest waiting message', () => {
    // a due Wiedervorlage behind an alarm: the counter goes amber, so the queue is not silent
    expect(rankMeldungen([m('alarm'), m('reminder'), m('update')]).pillTone).toBe('warn')
    // …and stays neutral when only calm/informational messages wait
    expect(rankMeldungen([m('reminder'), m('review'), m('update')]).pillTone).toBe('info')
    expect(rankMeldungen([m('reminder')]).pillTone).toBeNull()
  })
})
