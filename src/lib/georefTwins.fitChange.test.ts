import { describe, it, expect } from 'vitest'
import { fitSimilarity, type Georef, type GeorefPair } from './georef'
import {
  fitChange, fitChangeRow, fitChangeUndoLabel, fitSignature, georefPlans, handLinkRow, movedOnSheets, referenceDelta, sheetFits,
  type SheetFit,
} from './georefTwins'
import { bakeAll, type PlanFit, type TacticalObject } from './tacticalObjects'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import type { BoardAnno, PlanDocument } from '../types'

/* ⚠️ The phantom «Referenz angepasst» rows of 23.09.2026 (docs/planning/postmortem-2026-09-23-
 * feueralarm.md · root cause C). After a remount the rail fills asynchronously — plans listed,
 * `georefKey`s resolving, bindings arriving — and one signature over the whole rail read every
 * arrival as a correction, then counted every object whose bake differed for ANY reason. These
 * pin the per-sheet reading: an arrival is a seed, only a known sheet's changed fit is a change,
 * and only that sheet's relocated objects are counted. */

const ORIGIN = { lng: 7.5525, lat: 47.5145 }
const mEast = (m: number) => ({ lng: ORIGIN.lng + m / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)), lat: ORIGIN.lat })
const mNorth = (m: number) => ({ lng: ORIGIN.lng, lat: ORIGIN.lat + m / 111320 })
/** a sheet `w` metres wide laid north-up with its top-left corner `dx` m east of ORIGIN */
const pairs = (dx: number, w = 100): GeorefPair[] => [
  { plan: { x: 0, y: 0 }, lngLat: mEast(dx) },
  { plan: { x: 1, y: 0 }, lngLat: mEast(dx + w) },
]

const C = appConfig.copy.log
const key = (id: string) => `object:a:plan:${id}`
const plan = (id: string, over: Partial<PlanDocument> = {}): PlanDocument =>
  ({ id, code: id.toUpperCase(), title: id, subtitle: '', imageUrl: `/${id}.pdf`, orientation: 'portrait', georefKey: key(id), ...over })
const anno = (id: string, over: Partial<BoardAnno> = {}): BoardAnno => ({ id, kind: 'symbol', x: 0.5, y: 0.5, ...over })
const onSheet = (id: string, planId: string, over: Partial<BoardAnno> = {}): TacticalObject =>
  ({ id, sheet: { planId, anno: anno(id, over) } })

/** The Gebäude stack: a fit of its own, OUTSIDE the reference bookkeeping (IncidentWorkspace ·
 *  fitsMap) — which is where prod's four drifted Lüfter stood. */
const STACK_ID = 'gebaeude'
const STACK: PlanFit = { fit: fitSimilarity([{ plan: { x: 0, y: 0 }, lngLat: mNorth(300) }, { plan: { x: 1, y: 0 }, lngLat: { ...mNorth(300), lng: mEast(40).lng } }], 1)!, aspect: 1 }

/**
 * The fit effect, reduced to what it decides (IncidentWorkspace · the `linkedPlans` effect):
 * the early return on an unchanged signature, the per-sheet cause, the counted re-bake with its
 * step, the row, and `referenceDelta`'s «Referenz entfernt». Everything it writes is recorded.
 */
function session(init: TacticalObject[], extraFits: ReadonlyMap<string, PlanFit> = new Map()) {
  let known: ReadonlyMap<string, SheetFit> | null = null
  let baked: string | null = null
  let referenced: ReadonlySet<string> | null = null
  const s = { objects: init, rows: [] as string[], steps: 0, causes: [] as string[], decideMs: 0 }
  const bake = (docs: PlanDocument[], store: Record<string, Georef>, rolledBack = false) => {
    const georefOf = (k: string) => store[k] ?? null
    const linked = georefPlans(docs, georefOf, () => 1)
    const sig = linked.map(fitSignature).join('|')
    if (sig === baked) return
    const seeding = baked === null
    const fits = new Map<string, PlanFit>([...extraFits, ...linked.map((p) => [p.id, { fit: p.fit, aspect: p.widthM / p.fit.scaleMPerU }] as const)])
    const after = bakeAll(s.objects, fits, 'taktisch')
    const t0 = performance.now()
    const change = fitChange(sheetFits(docs, linked, georefOf), seeding ? null : known, rolledBack)
    const moved = after === s.objects ? 0 : movedOnSheets(s.objects, after, change.changed)
    s.decideMs += performance.now() - t0
    baked = sig
    known = change.known
    s.causes.push(change.cause)
    if (fitChangeUndoLabel(change.cause) && moved > 0) s.steps++ // useObjectStore · rebake
    s.objects = after
    const row = fitChangeRow(change.cause, moved)
    if (row) s.rows.push(row)
    const d = referenceDelta(docs, linked.map((p) => p.id), referenced)
    referenced = d.referenced
    if (!seeding && d.dropped.size) {
      const kept = s.objects.reduce((n, o) => n + (o.sheet && d.dropped.has(o.sheet.planId) ? 1 : 0), 0)
      s.rows.push(kept ? fillTemplate(C.referenceDroppedKept, { n: kept }) : C.referenceDropped)
    }
  }
  /** …and the ACT's half (IncidentWorkspace · `handLinked`): the georef flow announces a first
   *  link with the pairs it stored, and the row is decided against what the reader knows NOW. */
  const handLink = (docs: PlanDocument[], georefKey: string, p: GeorefPair[]) => {
    const row = handLinkRow(georefKey, p, {
      plans: docs, known, aspectOf: () => 1, objects: s.objects,
      bake: (all, fits) => bakeAll(all, fits, 'taktisch'),
    })
    if (row) s.rows.push(row)
  }
  return { s, bake, handLink }
}

/** a store as it stood before the remount: every body baked by the fits of the time */
const bakedStore = (objects: TacticalObject[], fits: Map<string, PlanFit>) => bakeAll(objects, fits, 'taktisch')
const fitsOf = (docs: PlanDocument[], store: Record<string, Georef>, extra: [string, PlanFit][] = []) => new Map<string, PlanFit>([
  ...extra,
  ...georefPlans(docs, (k) => store[k] ?? null, () => 1).map((p) => [p.id, { fit: p.fit, aspect: p.widthM / p.fit.scaleMPerU }] as [string, PlanFit]),
])
/** A Lüfter whose map rotation drifted off what its anno says (postmortem · A2): its bake is no
 *  longer identical, but nothing about any fit is involved. */
const drift = (o: TacticalObject, deg = 41.49): TacticalObject => ({ ...o, entity: { ...o.entity!, rotation: (o.entity!.rotation ?? 0) + deg } })

describe('fitChange — a reference arriving is not a reference changing', () => {
  const five = ['modul1', 'modul2', 'modul3', 'modul4', 'modul5']
  const refs = (over: Record<string, GeorefPair[]> = {}) =>
    Object.fromEntries(five.map((id, i) => [key(id), { pairs: over[id] ?? pairs(i * 200) }])) as Record<string, Georef>

  it('mount with no plans, then the plans in three async batches: no correction, no row, no step', () => {
    const docs = five.map((id) => plan(id))
    const objects = five.flatMap((id) => [onSheet(`${id}-a`, id, { x: 0.2 }), onSheet(`${id}-b`, id, { x: 0.8 })])
    const { s, bake } = session(objects)
    bake([], {}) // the remount: nothing listed yet
    bake(docs.slice(0, 1), refs()) // batch 1
    bake(docs.slice(0, 3), refs()) // batch 2
    bake(docs, refs()) // batch 3
    expect(s.causes).not.toContain('reference')
    expect(s.causes).not.toContain('measurement')
    expect(s.rows).toEqual([])
    expect(s.steps).toBe(0)
    // …and the bodies ARE there: a seed still bakes
    expect(s.objects.every((o) => o.entity)).toBe(true)
  })

  it('a key that RESOLVES later (station key → the binding\'s) is a seed too', () => {
    const station = [plan('modul2')]
    const bound = [plan('modul2', { georefKey: 'incident:i1:binding:b1' })]
    const { s, bake } = session([onSheet('x', 'modul2')])
    bake(station, { [key('modul2')]: { pairs: pairs(0) } })
    bake(bound, { [key('modul2')]: { pairs: pairs(0) }, 'incident:i1:binding:b1': { pairs: pairs(5) } })
    expect(s.causes).toEqual(['seed', 'seed'])
    expect(s.rows).toEqual([])
  })

  it('a real fit change on ONE sheet among five: one row, n = the objects on that sheet that moved', () => {
    const docs = five.map((id) => plan(id))
    const before = refs()
    const objects = bakedStore([
      ...five.flatMap((id) => [onSheet(`${id}-a`, id, { x: 0.2 }), onSheet(`${id}-b`, id, { x: 0.8 }), onSheet(`${id}-c`, id, { x: 0.5, y: 0.3 })]),
      // standing on the one point the correction keeps fixed (the first cross) — it does not move
      onSheet('modul3-pinned', 'modul3', { x: 0, y: 0 }),
    ], fitsOf(docs, before))
    // …and every other sheet's objects carry a drifted rotation, so their bakes differ too
    const drifting = (list: TacticalObject[]) => list.map((o) => (o.sheet!.planId !== 'modul3' || o.id === 'modul3-pinned' ? drift(o) : o))
    const { s, bake } = session(drifting(objects))
    bake(docs, before)
    s.objects = drifting(s.objects) // the drift is ongoing (postmortem · A2): the seed healed it, it is back
    // the operator moves modul3's second cross: the sheet is now 150 m wide on the ground
    bake(docs, refs({ modul3: pairs(400, 150) }))
    expect(s.causes).toEqual(['seed', 'reference'])
    expect(s.rows).toEqual([fillTemplate(C.referenceRebaked, { n: 3 })])
    expect(s.steps).toBe(1)
  })

  it('the same pairs re-solved in a truer shape are the app\'s measurement, not a hand', () => {
    const docs = [plan('modul2')]
    const store = { [key('modul2')]: { pairs: pairs(0) } }
    const now = (aspect: number) => {
      const linked = georefPlans(docs, (k) => store[k] ?? null, () => aspect)
      return sheetFits(docs, linked, (k) => store[k] ?? null)
    }
    const first = fitChange(now(1), null)
    const second = fitChange(now(0.7), first.known)
    expect(second.cause).toBe('measurement')
    expect([...second.changed]).toEqual(['modul2'])
  })

  it('a sheet removal is still «Referenz entfernt», counting what stays', () => {
    const docs = [plan('modul2'), plan('modul3')]
    const store = { [key('modul2')]: { pairs: pairs(0) }, [key('modul3')]: { pairs: pairs(200) } }
    const { s, bake } = session(bakedStore([onSheet('a', 'modul2'), onSheet('b', 'modul2'), onSheet('c', 'modul3')], fitsOf(docs, store)))
    bake(docs, store)
    bake(docs, { [key('modul3')]: store[key('modul3')] })
    expect(s.rows).toEqual([fillTemplate(C.referenceDroppedKept, { n: 2 })])
    expect(s.steps).toBe(0)
  })

  it('…and re-linking it later is a change against the fit its objects were left on', () => {
    const docs = [plan('modul2')]
    const store = { [key('modul2')]: { pairs: pairs(0) } }
    const { s, bake } = session(bakedStore([onSheet('a', 'modul2'), onSheet('b', 'modul2', { x: 0.9 })], fitsOf(docs, store)))
    bake(docs, store)
    bake(docs, {}) // Referenz zurücksetzen
    bake(docs, { [key('modul2')]: { pairs: pairs(30) } }) // linked again, 30 m further east
    expect(s.rows).toEqual([fillTemplate(C.referenceDroppedKept, { n: 2 }), fillTemplate(C.referenceRebaked, { n: 2 })])
    expect(s.steps).toBe(1)
  })

  it('a sheet that leaves the rail and comes back unchanged is nothing at all', () => {
    const docs = [plan('modul2'), plan('modul3')]
    const store = { [key('modul2')]: { pairs: pairs(0) }, [key('modul3')]: { pairs: pairs(200) } }
    const { s, bake } = session([onSheet('a', 'modul2')])
    bake(docs, store)
    bake([docs[1]], store) // a refetch, an object switch
    bake(docs, store)
    expect(s.causes).toEqual(['seed', 'seed', 'seed'])
    expect(s.rows).toEqual([])
  })

  it('an object\'s own prop difference (a turn) on an unchanged fit is no row', () => {
    const docs = [plan('modul2'), plan('modul3')]
    const store = { [key('modul2')]: { pairs: pairs(0) } }
    const objects = bakedStore([onSheet('l1', 'modul2', { rotation: 177 }), onSheet('l2', 'modul2', { rotation: 240 })], fitsOf(docs, store)).map((o) => drift(o))
    const { s, bake } = session(objects)
    bake(docs, store)
    s.objects = s.objects.map((o) => drift(o))
    // another sheet gains its reference; modul2's fit is untouched, its Lüfter still bake differently
    bake(docs, { ...store, [key('modul3')]: { pairs: pairs(200) } })
    expect(s.rows).toEqual([])
    expect(s.steps).toBe(0)
    expect(movedOnSheets(objects, bakeAll(objects, fitsOf(docs, store), 'taktisch'), new Set(['modul2']))).toBe(0)
  })

  it('a rolled-back write still reports the refusal, and takes no step', () => {
    const docs = [plan('modul2')]
    const store = { [key('modul2')]: { pairs: pairs(0) } }
    const { s, bake } = session(bakedStore([onSheet('a', 'modul2')], fitsOf(docs, store)))
    bake(docs, store)
    bake(docs, { [key('modul2')]: { pairs: pairs(10) } })
    bake(docs, store, true)
    expect(s.causes).toEqual(['seed', 'reference', 'rollback'])
    expect(s.rows).toEqual([fillTemplate(C.referenceRebaked, { n: 1 }), C.referenceRolledBack])
    expect(s.steps).toBe(1)
  })
})

/* A HAND linking a sheet that had no fit (24.09.2026). The reader stays silent — to it that is a
 * key arriving, exactly like a plan finishing loading — and the act writes the one row. */
describe('handLinkRow — a first link by hand is one row, from the act', () => {
  const linked = (plan: string, n?: number) => n
    ? fillTemplate(C.referenceLinkedPlaced, { plan, n })
    : fillTemplate(C.referenceLinked, { plan })

  it('a first hand link writes exactly one row, counting the objects that gained a place', () => {
    const docs = [plan('modul2'), plan('modul3')]
    const store: Record<string, Georef> = { [key('modul3')]: { pairs: pairs(200) } }
    const { s, bake, handLink } = session([onSheet('a', 'modul2'), onSheet('b', 'modul2', { x: 0.9 }), onSheet('c', 'modul3')])
    bake(docs, store) // the session's seed: modul3 is linked, modul2 is not
    // the operator places the second pair on modul2: the act first, then the re-bake it causes
    handLink(docs, key('modul2'), pairs(0))
    bake(docs, { ...store, [key('modul2')]: { pairs: pairs(0) } })
    expect(s.rows).toEqual([linked('MODUL2', 2)])
    expect(s.causes).toEqual(['seed', 'seed']) // the reader stayed silent: it is a seed to it
    expect(s.steps).toBe(0)
    expect(s.objects.filter((o) => o.sheet?.planId === 'modul2').every((o) => o.entity)).toBe(true)
  })

  it('…before the session\'s very first bake too', () => {
    const docs = [plan('modul2')]
    const { s, bake, handLink } = session([onSheet('a', 'modul2')])
    handLink(docs, key('modul2'), pairs(0))
    bake(docs, { [key('modul2')]: { pairs: pairs(0) } })
    expect(s.rows).toEqual([linked('MODUL2', 1)])
  })

  it('a plan that merely finishes loading writes no row at all', () => {
    const docs = [plan('modul2'), plan('modul3')]
    const store = { [key('modul2')]: { pairs: pairs(0) }, [key('modul3')]: { pairs: pairs(200) } }
    const { s, bake } = session([onSheet('a', 'modul2'), onSheet('b', 'modul3')])
    bake([], {})
    bake(docs.slice(0, 1), store) // listed late — no act, so nothing announces it
    bake(docs, store)
    expect(s.rows).toEqual([])
  })

  it('a correction writes only «Referenz angepasst» — the act owes nothing for a known sheet', () => {
    const docs = [plan('modul2')]
    const store = { [key('modul2')]: { pairs: pairs(0) } }
    const { s, bake, handLink } = session(bakedStore([onSheet('a', 'modul2')], fitsOf(docs, store)))
    bake(docs, store)
    // the georef flow never announces a sheet that had a fit — and even if it did, the reader knows it
    handLink(docs, key('modul2'), pairs(20))
    bake(docs, { [key('modul2')]: { pairs: pairs(20) } })
    expect(s.rows).toEqual([fillTemplate(C.referenceRebaked, { n: 1 })])
  })

  it('re-linked after «Referenz entfernt» in the same session: the re-bake\'s row, not a second one', () => {
    const docs = [plan('modul2')]
    const store = { [key('modul2')]: { pairs: pairs(0) } }
    const { s, bake, handLink } = session(bakedStore([onSheet('a', 'modul2')], fitsOf(docs, store)))
    bake(docs, store)
    bake(docs, {}) // Referenz zurücksetzen
    handLink(docs, key('modul2'), pairs(30)) // the hand links it again: the sheet has no fit
    bake(docs, { [key('modul2')]: { pairs: pairs(30) } })
    expect(s.rows).toEqual([fillTemplate(C.referenceDroppedKept, { n: 1 }), fillTemplate(C.referenceRebaked, { n: 1 })])
  })

  it('an accepted proposal and a transfer are each one row (the same act, two doors)', () => {
    const docs = [plan('modul2'), plan('modul3')]
    const { s, bake, handLink } = session([onSheet('a', 'modul3')])
    bake(docs, {})
    const auto = pairs(0).map((p) => ({ ...p, kind: 'auto' as const }))
    handLink(docs, key('modul2'), auto) // «Übernehmen»
    bake(docs, { [key('modul2')]: { pairs: auto } })
    handLink(docs, key('modul3'), auto) // «Passung übertragen» onto modul3
    bake(docs, { [key('modul2')]: { pairs: auto }, [key('modul3')]: { pairs: auto } })
    expect(s.rows).toEqual([linked('MODUL2'), linked('MODUL3', 1)])
  })

  it('the row without a count: no objects, or a fit that cannot be solved here', () => {
    const docs = [plan('modul2')]
    const objects = [onSheet('a', 'modul2')]
    const ctx = { plans: docs, known: null, objects, bake: (all: TacticalObject[], fits: ReadonlyMap<string, PlanFit>) => bakeAll(all, fits, 'taktisch') }
    expect(handLinkRow(key('modul2'), pairs(0), { ...ctx, objects: [], aspectOf: () => 1 })).toBe('Plan mit Karte verknüpft – MODUL2')
    // no usable aspect ⇒ the count is omitted, never guessed
    expect(handLinkRow(key('modul2'), pairs(0), { ...ctx, aspectOf: () => 0 })).toBe('Plan mit Karte verknüpft – MODUL2')
    expect(handLinkRow(key('modul2'), pairs(0), { ...ctx, aspectOf: () => 1 })).toBe('Plan mit Karte verknüpft – MODUL2 – 1 Objekte verortet')
    // a key no sheet on the rail answers to is nobody's row here
    expect(handLinkRow('object:b:plan:modul2', pairs(0), { ...ctx, aspectOf: () => 1 })).toBeNull()
  })

  it('counts a body GAINED and a body MOVED, not an object that stands still or sits elsewhere', () => {
    const docs = [plan('modul2'), plan('modul3')]
    const old = { [key('modul2')]: { pairs: pairs(50) } }
    // one object still carries the ground body an earlier session's fit gave it, one never had one
    const [kept] = bakedStore([onSheet('kept', 'modul2')], fitsOf(docs, old))
    const objects = [kept, onSheet('fresh', 'modul2', { x: 0.1 }), onSheet('other', 'modul3'), { id: 'map-only', entity: { id: 'map-only', kind: 'symbol', layer: 'taktisch', coord: [7.5, 47.5] } } as TacticalObject]
    const row = handLinkRow(key('modul2'), pairs(0), { plans: docs, known: null, aspectOf: () => 1, objects, bake: (all, fits) => bakeAll(all, fits, 'taktisch') })
    expect(row).toBe(linked('MODUL2', 2))
  })
})

/* The field sequence, as the data shows it: the workspace remounts (loop A tore it down), the
 * first bake runs with the rail half-filled, the Einsatzobjekt's plans and its binding land
 * afterwards, and four Lüfter on the Gebäude stack carry a rotation that no longer matches their
 * anno. Prod wrote «Referenz angepasst – 4 Objekte neu verortet» here; nobody touched a reference. */
describe('regression — 23.09.2026 18:43:23 / 20:31:07', () => {
  it('remount + late plans + non-identical bakes write no row', () => {
    const full = [plan('osm'), plan('modul1'), plan('modul2'), plan('modul3')]
    const store: Record<string, Georef> = {
      [key('modul1')]: { pairs: pairs(0) },
      [key('modul2')]: { pairs: pairs(200) },
      'incident:i1:binding:m3': { pairs: pairs(400) },
    }
    const bound = full.map((p) => (p.id === 'modul3' ? { ...p, georefKey: 'incident:i1:binding:m3' } : p))
    const lufter = [177, 240, 267, 133].map((r, i) => onSheet(`s${i}`, STACK_ID, { x: 0.2 * (i + 1), y: 0.5, rotation: r, floor: 0 }))
    const sheetObjects = [onSheet('h1', 'modul1'), onSheet('h2', 'modul2', { x: 0.3 }), onSheet('t3', 'modul3')]
    const stack = new Map([[STACK_ID, { ...STACK, stack: { floors: [0, 1] } }]])
    // loop A kept re-drifting them between any two bakes — and so does this
    const drifting = (list: TacticalObject[]) => list.map((o) => (o.sheet!.planId === STACK_ID ? drift(o) : o))
    const { s, bake } = session(drifting(bakedStore([...lufter, ...sheetObjects], fitsOf(bound, store, [...stack]))), stack)
    for (const docs of [
      full.slice(0, 1), // mount: only the Karte's own tile
      full.slice(0, 3), // the object's plans arrive
      full, // …the rest, still on the station key
      bound, // the binding resolves modul3's key
    ]) { bake(docs, store); s.objects = drifting(s.objects) }
    expect(s.causes.every((c) => c === 'seed')).toBe(true)
    expect(s.rows).toEqual([])
    expect(s.steps).toBe(0)
  })
})

/* LOAD: a big object's rail filling one plan at a time, in whatever order the network answers. */
describe('load — 30 plans arriving one by one over 3 000 objects', () => {
  // mulberry32 — a seeded order, so a failure reproduces
  const rand = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  it('writes no row and decides fast', () => {
    const r = rand(20260923)
    const ids = Array.from({ length: 30 }, (_, i) => `modul${i + 1}`)
    const docs = ids.map((id) => plan(id))
    const store = Object.fromEntries(ids.map((id, i) => [key(id), { pairs: pairs(i * 150, 80 + i) }])) as Record<string, Georef>
    const objects = Array.from({ length: 3000 }, (_, i) => onSheet(`o${i}`, ids[i % 30], { x: r(), y: r(), rotation: Math.round(r() * 360) }))
    // a store baked long ago, with every third body drifted — the bakes differ everywhere
    const init = bakedStore(objects, fitsOf(docs, store)).map((o, i) => (i % 3 ? o : drift(o)))
    const order = [...docs].sort(() => r() - 0.5)
    const { s, bake } = session(init)
    bake([], store)
    for (let i = 1; i <= order.length; i++) {
      bake(order.slice(0, i), store)
      s.objects = s.objects.map((o, j) => (j % 3 ? o : drift(o))) // …and they keep drifting
    }
    expect(s.causes).toHaveLength(31)
    expect(s.causes.every((c) => c === 'seed')).toBe(true)
    expect(s.rows).toEqual([])
    expect(s.steps).toBe(0)
    // 31 decisions over 3 000 objects each — milliseconds in practice; the ceiling is generous
    expect(s.decideMs).toBeLessThan(500)
  })
})
