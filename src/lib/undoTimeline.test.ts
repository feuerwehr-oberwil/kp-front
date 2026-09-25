import { describe, it, expect, vi } from 'vitest'
import { createUndoTimeline, undoCaption, type UndoDomain, type UndoEntry } from './undoTimeline'

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

  // ── a remote merge drops what it invalidated and nothing else (25.09.2026) ────────────────────
  const keyed = (label: string, keys: string[] | null, log: string[] = []): UndoEntry => ({
    domain: 'karte', label, touches: keys === null ? undefined : () => keys,
    undo: () => { log.push(`-${label}`) }, redo: () => { log.push(`+${label}`) },
  })

  it('a merge drops only the entries whose records it changed', () => {
    const t = createUndoTimeline()
    t.push(keyed('Symbol', ['objects:s1']))
    t.push(keyed('Kontakt', ['trupps:t1']))
    t.rebase(['trupps:t2']) // another device, another Trupp
    expect(t.entries().past.map((e) => e.label)).toEqual(['Symbol', 'Kontakt'])
    t.rebase(['trupps:t1'])
    expect(t.entries().past.map((e) => e.label)).toEqual(['Symbol'])
    expect(t.peekUndo()?.label).toBe('Symbol')
  })

  it('an echo (nothing changed) drops nothing, not even an entry of unknown reach', () => {
    const t = createUndoTimeline()
    t.push(keyed('?', null))
    t.rebase([])
    expect(t.canUndo()).toBe(true)
  })

  it('an older entry that writes what a dropped one wrote goes too — its effect is now permanent', () => {
    const t = createUndoTimeline()
    t.push(keyed('K1', ['objects:a']))
    t.push(keyed('K2', ['objects:a', 'objects:b']))
    t.push(keyed('K3', ['objects:c']))
    t.rebase(['objects:b'])
    expect(t.entries().past.map((e) => e.label)).toEqual(['K3'])
  })

  it('a NEWER entry sharing a record with a dropped older one stays: it is taken first', () => {
    const t = createUndoTimeline()
    t.push(keyed('K1', ['objects:a', 'objects:b']))
    t.push(keyed('K2', ['objects:a']))
    t.rebase(['objects:b'])
    expect(t.entries().past.map((e) => e.label)).toEqual(['K2'])
  })

  it('an entry that cannot say what it writes is dropped by a real change, and everything older with it', () => {
    const t = createUndoTimeline()
    t.push(keyed('K1', ['objects:a']))
    t.push(keyed('?', null))
    t.push(keyed('K3', ['objects:c']))
    t.rebase(['settings:x'])
    expect(t.entries().past.map((e) => e.label)).toEqual(['K3'])
    // …and so is one whose `touches` throws — rebase itself never does
    const u = createUndoTimeline()
    u.push({ ...keyed('boom', []), touches: () => { throw new Error('x') } })
    expect(() => u.rebase(['objects:a'])).not.toThrow()
    expect(u.canUndo()).toBe(false)
  })

  it('walks the redo side in the order it would be redone', () => {
    const t = createUndoTimeline()
    t.push(keyed('K1', ['objects:a']))
    t.push(keyed('K2', ['objects:a', 'objects:b']))
    t.push(keyed('K3', ['objects:c']))
    t.undo(); t.undo(); t.undo() // future: K1, K2, K3
    t.rebase(['objects:a'])
    expect(t.entries().future.map((e) => e.label)).toEqual(['K3'])
  })

  it('names the domain steps still standing', () => {
    const t = createUndoTimeline()
    t.push({ ...keyed('K1', ['objects:a']), step: 'k1' })
    t.push({ ...keyed('K2', ['objects:b']), step: 'k2' })
    t.rebase(['objects:a'])
    expect([...t.steps()]).toEqual(['k2'])
  })

  // F8 (staging r3): after a merge dropped the Karte steps, ↶ read «Trupp 1 (…): Ausrüstung: WBK»
  // with nothing saying it was on another surface — a tap meant for the map took back a Trupp edit
  it('names the SURFACE in front of an action that does not already say it', () => {
    expect(undoCaption({ domain: 'trupps', label: 'Trupp 1 (Tst Anna): Ausrüstung: WBK' })).toBe('Trupps · Trupp 1 (Tst Anna): Ausrüstung: WBK')
    expect(undoCaption({ domain: 'karte', label: 'Änderung auf der Karte' })).toBe('Änderung auf der Karte')
    expect(undoCaption({ domain: 'anwesenheit', label: 'Anwesenheit' })).toBe('Anwesenheit')
    expect(undoCaption({ domain: 'gebaeude', label: 'Gebäude übernommen' })).toBe('Gebäude übernommen')
    expect(undoCaption({ domain: 'ansicht', label: 'Ansicht' })).toBe('Karte · Ansicht')
  })

  it('tells a toast whether its entry still stands on the ↶ side', () => {
    const t = createUndoTimeline()
    const drop = t.push(keyed('Geschoss', ['building:']))
    expect(drop.standing()).toBe(true)
    t.rebase(['building:'])
    expect(drop.standing()).toBe(false)
    const again = t.push(keyed('Geschoss', ['building:']))
    t.undo()
    expect(again.standing()).toBe(false) // already taken by ↶ — the toast must not do it twice
  })
})

/* staging r3 F1: a Trupp registration files Gäste and writes their AS-Funktion in the Anwesenheit.
 * Those are parts of ONE act, and ↶ names and takes back the act — not «Anwesenheit» alone. */
describe('group — one act across domains is one step', () => {
  const part = (domain: UndoDomain, label: string, log: string[]): UndoEntry => ({
    domain, label, undo: () => { log.push(`undo ${label}`) }, redo: () => { log.push(`redo ${label}`) },
  })

  it('gathers the parts under the primary part\'s label; undo runs newest first, redo in order', () => {
    const tl = createUndoTimeline()
    const log: string[] = []
    const end = tl.group('trupps')
    tl.push(part('anwesenheit', 'Anwesenheit', log)) // the Gäste, filed first
    tl.push(part('trupps', 'Trupp 2 angemeldet', log))
    tl.push(part('anwesenheit', 'Anwesenheit', log)) // the Funktion, written after
    expect(tl.canUndo()).toBe(false) // nothing recorded while the act is still running
    end()
    expect(tl.peekUndo()?.label).toBe('Trupp 2 angemeldet')
    expect(tl.undo().status).toBe('done')
    expect(log).toEqual(['undo Anwesenheit', 'undo Trupp 2 angemeldet', 'undo Anwesenheit'])
    expect(tl.canUndo()).toBe(false)
    log.length = 0
    tl.redo()
    expect(log).toEqual(['redo Anwesenheit', 'redo Trupp 2 angemeldet', 'redo Anwesenheit'])
  })

  it('one part is pushed as it is, none pushes nothing, a nested group joins the open one', () => {
    const tl = createUndoTimeline()
    const log: string[] = []
    tl.group()()
    expect(tl.canUndo()).toBe(false)
    const end = tl.group('trupps')
    const inner = tl.group('anwesenheit')
    tl.push(part('trupps', 'T', log))
    inner() // does nothing — the outer group is still open
    expect(tl.canUndo()).toBe(false)
    end()
    expect(tl.peekUndo()?.label).toBe('T')
  })

  it('a part whose target is gone makes the step «lost», and the others still act', () => {
    const tl = createUndoTimeline()
    const log: string[] = []
    const end = tl.group('trupps')
    tl.push(part('anwesenheit', 'A', log))
    tl.push({ domain: 'trupps', label: 'T', undo: () => false, redo: () => false })
    end()
    expect(tl.undo().status).toBe('lost')
    expect(log).toEqual(['undo A'])
  })

  it('dropping a part after the group closed drops the recorded step (a toast used its undo)', () => {
    const tl = createUndoTimeline()
    const end = tl.group('trupps')
    const drop = tl.push({ domain: 'trupps', label: 'T', undo: () => {}, redo: () => {} })
    tl.push({ domain: 'anwesenheit', label: 'A', undo: () => {}, redo: () => {} })
    end()
    drop()
    expect(tl.canUndo()).toBe(false)
  })

  // both halves together (merge of #222's named steps and the grouped Trupp save): a writer names
  // its step once it knows its words — inside a group, or after the group closed
  it('a grouped part can still be named: in the open group, and on the recorded step when it is the head', () => {
    const tl = createUndoTimeline()
    const end = tl.group('karte')
    const h = tl.push({ domain: 'karte', label: 'Änderung', undo: () => {}, redo: () => {} })
    const other = tl.push({ domain: 'trupps', label: 'T', undo: () => {}, redo: () => {} })
    h.rename('KP gesetzt')
    end()
    expect(tl.peekUndo()?.label).toBe('KP gesetzt')
    other.rename('nicht der Kopf') // a non-head part does not rename the step
    expect(tl.peekUndo()?.label).toBe('KP gesetzt')
    h.rename('KP verschoben')
    expect(tl.peekUndo()?.label).toBe('KP verschoben')
  })
})

/* Staging integration (round 4): #227's `group`, #222's `rename` and #234's `touches` / `step` /
   `standing` meet on the same entry — a compound step must answer all three. */
describe('group × rename × merge — the three PRs on one step', () => {
  const part = (domain: UndoDomain, label: string, extra: Partial<UndoEntry> = {}): UndoEntry => ({
    domain, label, undo: () => {}, redo: () => {}, ...extra,
  })

  it('a part named while the group is open names the step when it is the primary part', () => {
    const tl = createUndoTimeline()
    const end = tl.group('karte')
    const k = tl.push(part('karte', 'Änderung auf der Karte'))
    tl.push(part('anwesenheit', 'Anwesenheit'))
    k.rename('TLF verschoben')
    end()
    expect(tl.peekUndo()?.label).toBe('TLF verschoben')
  })

  it('once recorded, only the head part renames the compound; a part alone renames itself', () => {
    const tl = createUndoTimeline()
    const end = tl.group('trupps')
    const t = tl.push(part('trupps', 'Trupp 2 angemeldet'))
    const a = tl.push(part('anwesenheit', 'Anwesenheit'))
    end()
    a.rename('Gast erfasst') // not the head — the step keeps the Trupp's words
    expect(tl.peekUndo()?.label).toBe('Trupp 2 angemeldet')
    t.rename('Trupp 2 (Muster) angemeldet')
    expect(tl.peekUndo()?.label).toBe('Trupp 2 (Muster) angemeldet')
    const solo = tl.group('karte')
    const k = tl.push(part('karte', 'Änderung auf der Karte'))
    solo()
    k.rename('KP Front gesetzt')
    expect(tl.peekUndo()?.label).toBe('KP Front gesetzt')
  })

  it('the compound touches what any part touches, keeps every part\'s step, and drops whole', () => {
    const tl = createUndoTimeline()
    const end = tl.group('trupps')
    const t = tl.push(part('trupps', 'T', { step: 's-t', touches: () => ['trupps:t1'] }))
    tl.push(part('anwesenheit', 'A', { step: 's-a', touches: () => ['attendance:p1'] }))
    end()
    expect(tl.steps()).toEqual(new Set(['s-t', 's-a']))
    expect(t.standing()).toBe(true)
    tl.rebase(['trupps:other'])
    expect(tl.canUndo()).toBe(true)
    tl.rebase(['attendance:p1']) // another device changed the person the save filed
    expect(tl.canUndo()).toBe(false)
    expect(tl.steps()).toEqual(new Set())
    expect(t.standing()).toBe(false)
  })

  it('one part of unknown reach makes the whole step unknown', () => {
    const tl = createUndoTimeline()
    const end = tl.group('trupps')
    tl.push(part('trupps', 'T', { touches: () => ['trupps:t1'] }))
    tl.push(part('anwesenheit', 'A'))
    end()
    tl.rebase(['mittel:m1'])
    expect(tl.canUndo()).toBe(false)
  })
})
