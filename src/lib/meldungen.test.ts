import { describe, it, expect, vi } from 'vitest'
import { meldungTap, rankMeldungen, type Meldung, type MeldungKind, type MeldungTone } from './meldungen'

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
    // no pin exists to override this any more (23.08.), so the sort IS the guarantee
    const noise: MeldungKind[] = ['gps', 'review', 'tabLock', 'update', 'install']
    for (const protectedKind of ['alarm', 'reminder'] as const) {
      const { lead } = rankMeldungen([...noise.map((k) => m(k)), m(protectedKind)])
      expect(lead?.kind).toBe(protectedKind)
    }
  })

  it('gives the disclosure the tone of the highest waiting message', () => {
    // a due Wiedervorlage behind an alarm: the control goes amber, so the queue is not silent
    expect(rankMeldungen([m('alarm'), m('reminder'), m('update')]).pillTone).toBe('warn')
    // …and stays neutral when only calm/informational messages wait
    expect(rankMeldungen([m('reminder'), m('review'), m('update')]).pillTone).toBe('info')
    expect(rankMeldungen([m('reminder')]).pillTone).toBeNull()
  })
})

// The tap is what stopped a queued message being a second-class citizen: the same resolution runs
// on the strip and in the queue, so nothing has to be promoted before it can be acted on. Each
// case below is shaped like the publisher it names.
describe('meldungTap', () => {
  const withActions = (kind: MeldungKind, actions: Meldung['actions'], onOpen?: () => void): Meldung =>
    ({ ...m(kind), actions, onOpen })

  it('runs the publisher\'s own «open» where it has one — the Wiedervorlage goes to the Verlauf, not to Erledigt', () => {
    const done = vi.fn()
    const open = vi.fn()
    // ReminderBanner: [Erledigt (primary), +10 min] and onOpen → Verlauf
    meldungTap(withActions('reminder', [{ label: 'Erledigt', primary: true, onClick: done }], open))?.()
    expect(open).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
  })

  it('otherwise runs the FIRST action — «Bearbeiten», never the «Passt» that confirms unread data', () => {
    const edit = vi.fn()
    const ok = vi.fn()
    // ReviewBanner: the forward move is listed first, the primary is the confirm
    meldungTap(withActions('review', [
      { label: 'Bearbeiten', onClick: edit },
      { label: 'Passt', primary: true, onClick: ok },
    ]))?.()
    expect(edit).toHaveBeenCalledOnce()
    expect(ok).not.toHaveBeenCalled()
  })

  it('takes the alarm — the row is for reaching the Einsatz, and that is where the tap goes', () => {
    const take = vi.fn()
    const attach = vi.fn()
    meldungTap(withActions('alarm', [
      { label: 'Übernehmen', primary: true, onClick: take },
      { label: 'Anhängen', onClick: attach },
    ]))?.()
    expect(take).toHaveBeenCalledOnce()
    expect(attach).not.toHaveBeenCalled()
  })

  it('gives an announce-only message no tap at all — «Update bereit» must not vanish when you touch it', () => {
    // UpdateBanner publishes a single «Später»: a retreat, not a forward move, so there is no
    // primary and the row stays plain text
    expect(meldungTap(withActions('update', [{ label: 'Später', onClick: vi.fn() }]))).toBeNull()
    expect(meldungTap(m('update'))).toBeNull()
  })

  it('goes dead while the row\'s action is running, so a second tap cannot take the alarm twice', () => {
    const take = vi.fn()
    expect(meldungTap(withActions('alarm', [
      { label: 'Wird geöffnet…', primary: true, busy: true, disabled: true, onClick: take },
    ]))).toBeNull()
  })
})
