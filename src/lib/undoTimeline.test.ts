import { describe, it, expect, vi } from 'vitest'
import { createUndoTimeline, type UndoDomain, type UndoEntry } from './undoTimeline'

/** A domain that keeps its own LIFO stack, exactly like the Karte doc or a Plan document. The
 *  timeline only ever tells it «one step back» – so this is the model the delegation has to keep
 *  honest: if the timeline ever asked it out of order, the recorded log would show it. */
function fakeDomain(domain: UndoDomain, scope?: string) {
  const applied: string[] = []
  const entry = (label: string): UndoEntry => ({
    domain,
    scope,
    label,
    undo: () => { applied.push(`-${label}`) },
    redo: () => { applied.push(`+${label}`) },
  })
  return { entry, applied }
}

describe('undoTimeline', () => {
  it('takes back the most recent action wherever it happened', () => {
    const t = createUndoTimeline()
    const karte = fakeDomain('karte')
    const trupps = fakeDomain('trupps')
    t.push(karte.entry('Symbol platziert'))
    t.push(trupps.entry('Kontakt Trupp 2'))

    expect(t.peekUndo()?.label).toBe('Kontakt Trupp 2')
    expect(t.undo()).toMatchObject({ status: 'done', entry: { domain: 'trupps' } })
    expect(t.undo()).toMatchObject({ status: 'done', entry: { domain: 'karte' } })
    expect(t.undo()).toEqual({ status: 'empty' })
    expect(trupps.applied).toEqual(['-Kontakt Trupp 2'])
    expect(karte.applied).toEqual(['-Symbol platziert'])
  })

  it('hands each domain its own steps in that domain’s own order', () => {
    // The whole case for delegating instead of rewriting: interleave two domains, walk the global
    // stack back, and each domain still sees a plain LIFO of its own actions.
    const t = createUndoTimeline()
    const karte = fakeDomain('karte')
    const anw = fakeDomain('anwesenheit')
    t.push(karte.entry('K1')); t.push(anw.entry('A1')); t.push(karte.entry('K2')); t.push(anw.entry('A2'))
    t.undo(); t.undo(); t.undo(); t.undo()

    expect(karte.applied).toEqual(['-K2', '-K1'])
    expect(anw.applied).toEqual(['-A2', '-A1'])
  })

  it('redoes in the order the actions originally happened', () => {
    const t = createUndoTimeline()
    const d = fakeDomain('mittel')
    t.push(d.entry('M1')); t.push(d.entry('M2'))
    t.undo(); t.undo()
    expect(t.peekRedo()?.label).toBe('M1')
    t.redo(); t.redo()

    expect(d.applied).toEqual(['-M2', '-M1', '+M1', '+M2'])
    expect(t.canRedo()).toBe(false)
    expect(t.canUndo()).toBe(true)
  })

  it('clears the ENTIRE redo tail on a new action, not just its own domain’s', () => {
    const t = createUndoTimeline()
    const karte = fakeDomain('karte')
    const trupps = fakeDomain('trupps')
    t.push(karte.entry('K1')); t.push(trupps.entry('T1'))
    t.undo(); t.undo()
    expect(t.canRedo()).toBe(true)

    t.push(trupps.entry('T2'))
    expect(t.canRedo()).toBe(false)
    expect(t.peekUndo()?.label).toBe('T2')
  })

  it('drops a domain’s entries when its history dies, and leaves the others standing', () => {
    const t = createUndoTimeline()
    const karte = fakeDomain('karte')
    const anw = fakeDomain('anwesenheit')
    t.push(karte.entry('K1')); t.push(anw.entry('A1')); t.push(karte.entry('K2'))
    t.undo() // K2 onto the redo tail

    t.invalidate('karte') // a remote hydrate replaced the document

    expect(t.peekUndo()?.label).toBe('A1')
    expect(t.canRedo()).toBe(false)
    t.undo()
    expect(karte.applied).toEqual(['-K2'])
    expect(anw.applied).toEqual(['-A1'])
  })

  it('invalidates one plan document without touching its siblings', () => {
    const t = createUndoTimeline()
    const a = fakeDomain('plan', 'plan-a')
    const b = fakeDomain('plan', 'plan-b')
    t.push(a.entry('A1')); t.push(b.entry('B1'))

    t.invalidate('plan', 'plan-a')

    expect(t.peekUndo()?.label).toBe('B1')
    t.undo()
    expect(t.canUndo()).toBe(false)
    expect(a.applied).toEqual([])
  })

  it('fails soft when the target is gone: the entry is discarded, nothing throws', () => {
    const t = createUndoTimeline()
    const gone: UndoEntry = { domain: 'trupps', label: 'Kontakt Trupp 2', undo: () => false, redo: () => false }
    const live = fakeDomain('karte')
    t.push(live.entry('K1'))
    t.push(gone)

    expect(t.undo()).toMatchObject({ status: 'lost', entry: { label: 'Kontakt Trupp 2' } })
    // it is on neither stack now – a step that could not act is not one you can walk forward into
    expect(t.canRedo()).toBe(false)
    expect(t.peekUndo()?.label).toBe('K1')
    expect(t.undo()).toMatchObject({ status: 'done' })
  })

  it('lets a still-standing undo toast take its own entry off the stack', () => {
    // Löschen keeps its confirm-with-undo toast for now, so the same act has two doors. Whichever
    // one is used, the other must stop offering it – or ↶ would delete the Trupp a second time.
    const t = createUndoTimeline()
    const d = fakeDomain('trupps')
    t.push(d.entry('Trupp 1 angemeldet'))
    const drop = t.push(d.entry('Trupp 2 gelöscht'))

    drop() // the operator took the toast's own «Rückgängig»
    expect(t.peekUndo()?.label).toBe('Trupp 1 angemeldet')
    drop() // idempotent – a second dismissal changes nothing
    expect(t.peekUndo()?.label).toBe('Trupp 1 angemeldet')
  })

  it('caps the past and keeps the newest end', () => {
    const t = createUndoTimeline(3)
    const d = fakeDomain('karte')
    for (const n of ['1', '2', '3', '4']) t.push(d.entry(n))

    t.undo(); t.undo(); t.undo()
    expect(d.applied).toEqual(['-4', '-3', '-2'])
    expect(t.canUndo()).toBe(false)
  })

  it('tells its subscribers whenever the stacks move', () => {
    const t = createUndoTimeline()
    const d = fakeDomain('karte')
    const seen = vi.fn()
    const off = t.subscribe(seen)

    t.push(d.entry('K1')); expect(seen).toHaveBeenCalledTimes(1)
    t.undo(); expect(seen).toHaveBeenCalledTimes(2)
    t.redo(); expect(seen).toHaveBeenCalledTimes(3)
    t.invalidate('karte'); expect(seen).toHaveBeenCalledTimes(4)
    t.invalidate('mittel'); expect(seen).toHaveBeenCalledTimes(4) // nothing moved, nothing said

    off()
    t.push(d.entry('K2'))
    expect(seen).toHaveBeenCalledTimes(4)
  })
})
