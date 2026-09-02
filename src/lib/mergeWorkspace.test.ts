import { describe, expect, it } from 'vitest'
import { mergeById, mergeRecord, mergeWorkspace } from './mergeWorkspace'

const o = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra })

describe('mergeById — three-way object merge', () => {
  it('keeps independent additions from both sides, server order then mine', () => {
    const base = [o('a')]
    const theirs = [o('a'), o('b')] // they added b
    const mine = [o('a'), o('c')] // I added c
    expect(mergeById(base, mine, theirs).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('same object edited on both sides → last writer (mine) wins', () => {
    const base = [o('a', { x: 0 })]
    const theirs = [o('a', { x: 1 })]
    const mine = [o('a', { x: 2 })]
    expect(mergeById(base, mine, theirs)).toEqual([o('a', { x: 2 })])
  })

  it('delete beats a concurrent edit (theirs edits, I delete → stays gone)', () => {
    const base = [o('a', { x: 0 })]
    const theirs = [o('a', { x: 9 })] // they moved it
    const mine: ReturnType<typeof o>[] = [] // I deleted it
    expect(mergeById(base, mine, theirs)).toEqual([])
  })

  it('delete beats a concurrent edit (I edit, they delete → stays gone)', () => {
    const base = [o('a', { x: 0 })]
    const theirs: ReturnType<typeof o>[] = [] // they deleted it
    const mine = [o('a', { x: 5 })] // I moved it
    expect(mergeById(base, mine, theirs)).toEqual([])
  })

  it('my new add is never mistaken for a delete (absent in base AND theirs)', () => {
    expect(mergeById([], [o('new')], [])).toEqual([o('new')])
  })

  it('an untouched object survives even if absent on my side but present in base+theirs only when I deleted it', () => {
    // present in base+theirs, absent in mine, theirs unchanged → I deleted it → drop
    expect(mergeById([o('a')], [], [o('a')])).toEqual([])
  })

  it('is idempotent: merging an already-merged superset against itself is stable', () => {
    const base = [o('a')]
    const merged = mergeById(base, [o('a'), o('c')], [o('a'), o('b')])
    // re-merge the result against itself (both sides equal, base = previous server)
    expect(mergeById(base, merged, merged)).toEqual(merged)
  })
})

describe('mergeRecord — three-way key/value merge', () => {
  it('unions new keys and LWW-mine on shared keys both changed', () => {
    expect(mergeRecord({ a: 1 }, { a: 2, c: 3 }, { a: 9, b: 8 })).toEqual({ a: 2, b: 8, c: 3 })
  })
  it('honors a removed shared key (delete wins)', () => {
    // key a in base+theirs, removed in mine → dropped
    expect(mergeRecord({ a: 1 }, {}, { a: 1 })).toEqual({})
  })
  it('takes THEIRS for a key the resolver left at the ancestor (no cross-domain clobber)', () => {
    // base a=1; mine untouched (a=1); theirs changed a=2 → take theirs, not mine's stale 1
    expect(mergeRecord({ a: 1 }, { a: 1 }, { a: 2 })).toEqual({ a: 2 })
  })
  it('keeps MINE for a key only the resolver changed', () => {
    expect(mergeRecord({ a: 1 }, { a: 5 }, { a: 1 })).toEqual({ a: 5 })
  })
})

describe('mergeWorkspace — whole blob', () => {
  it('merges collections by id and keeps the local view/config (activePlanId)', () => {
    const base = { entities: [o('e1')], drawings: [], activePlanId: 'p1' }
    const theirs = { entities: [o('e1'), o('e2')], drawings: [o('d1')], activePlanId: 'p1' } // they added e2 + a drawing
    const mine = { entities: [o('e1')], drawings: [o('d2')], activePlanId: 'p2' } // I added a drawing, switched plan
    const merged = mergeWorkspace(base, mine, theirs)
    expect((merged.entities as { id: string }[]).map((x) => x.id)).toEqual(['e1', 'e2'])
    expect((merged.drawings as { id: string }[]).map((x) => x.id)).toEqual(['d1', 'd2'])
    expect(merged.activePlanId).toBe('p2') // my active plan is not yanked by the merge
  })

  it('merges per-plan board annotations independently', () => {
    const base = { board: { p1: [o('a1')] } }
    const theirs = { board: { p1: [o('a1'), o('a2')] } }
    const mine = { board: { p1: [o('a1')], p2: [o('b1')] } }
    const merged = mergeWorkspace(base, mine, theirs) as { board: Record<string, { id: string }[]> }
    expect(merged.board.p1.map((x) => x.id)).toEqual(['a1', 'a2'])
    expect(merged.board.p2.map((x) => x.id)).toEqual(['b1'])
  })

  it('clear-board (delete-all) wins over an untouched plan on the other side', () => {
    const base = { board: { p1: [o('a1'), o('a2')] } }
    const theirs = { board: { p1: [o('a1'), o('a2')] } } // unchanged
    const mine = { board: { p1: [] } } // I cleared the board
    const merged = mergeWorkspace(base, mine, theirs) as { board: Record<string, { id: string }[]> }
    expect(merged.board.p1).toEqual([])
  })
})

describe('mergeWorkspace — task-scoped cross-domain merges (no clobbering)', () => {
  // The headline guarantee: two operators on the SAME incident working DIFFERENT domains both keep
  // their work. The resolver ("mine") is the device flushing; "theirs" is the server holding the
  // other operator's concurrent edit. Each case = one operator edited domain X while the resolver
  // touched only domain Y and left X at the ancestor.

  it('Atemschutz (trupps) on one device + Anwesenheit (attendance) on another — both survive', () => {
    const base = { trupps: [o('t1')], attendance: {} }
    const theirs = { trupps: [o('t1')], attendance: { p1: { present: true } } } // they marked p1 present
    const mine = { trupps: [o('t1'), o('t2')], attendance: {} }                  // I added a Trupp
    const merged = mergeWorkspace(base, mine, theirs) as { trupps: { id: string }[]; attendance: Record<string, unknown> }
    expect(merged.trupps.map((x) => x.id)).toEqual(['t1', 't2']) // my Trupp add
    expect(merged.attendance).toEqual({ p1: { present: true } }) // their attendance NOT clobbered
  })

  it('one device plans the Zeitplan while another ticks Anwesenheit — both survive', () => {
    // the exact split the Schichtenplanung invites: the Einsatzleiter plans the night on one
    // tablet while the AdFU ticks arrivals on another
    const base = { shifts: [o('sh1')], attendance: {} }
    const theirs = { shifts: [o('sh1')], attendance: { p1: { status: 'present' } } }
    const mine = { shifts: [o('sh1'), o('sh2')], attendance: {} }
    const merged = mergeWorkspace(base, mine, theirs) as { shifts: { id: string }[]; attendance: Record<string, unknown> }
    expect(merged.shifts.map((x) => x.id)).toEqual(['sh1', 'sh2'])
    expect(merged.attendance).toEqual({ p1: { status: 'present' } })
  })

  it('a deleted shift stays deleted against a concurrent edit of it', () => {
    const base = { shifts: [o('sh1'), o('sh2')] }
    const theirs = { shifts: [{ id: 'sh1' }, { id: 'sh2', to: '2026-07-27T02:00:00Z' }] } // they moved sh2
    const mine = { shifts: [o('sh1')] } // I deleted sh2
    const merged = mergeWorkspace(base, mine, theirs) as { shifts: { id: string }[] }
    expect(merged.shifts.map((x) => x.id)).toEqual(['sh1'])
  })

  it('a settings change on one device is not reverted by an unrelated map edit on another', () => {
    const base = { entities: [o('e1')], settings: { contactIntervalMin: 10 } }
    const theirs = { entities: [o('e1')], settings: { contactIntervalMin: 20 } } // they changed doctrine
    const mine = { entities: [o('e1'), o('e2')], settings: { contactIntervalMin: 10 } } // I only drew on the map
    const merged = mergeWorkspace(base, mine, theirs) as { entities: { id: string }[]; settings: { contactIntervalMin: number } }
    expect(merged.entities.map((x) => x.id)).toEqual(['e1', 'e2'])
    expect(merged.settings.contactIntervalMin).toBe(20) // their settings change survives
  })

  it('toggling an existing person\'s presence survives a concurrent edit elsewhere', () => {
    const base = { attendance: { p1: { present: true } }, drawings: [] }
    const theirs = { attendance: { p1: { present: false } }, drawings: [] } // they signed p1 out
    const mine = { attendance: { p1: { present: true } }, drawings: [o('d1')] } // I drew a line
    const merged = mergeWorkspace(base, mine, theirs) as { attendance: Record<string, { present: boolean }> }
    expect(merged.attendance.p1.present).toBe(false) // their toggle isn't reverted by my stale copy
  })

  it('independent plan calibrations on two devices both survive', () => {
    const base = { planScale: {} }
    const theirs = { planScale: { modul1: 1.5 } } // they calibrated modul1
    const mine = { planScale: { modul2: 2.0 } }   // I calibrated modul2
    const merged = mergeWorkspace(base, mine, theirs) as { planScale: Record<string, number> }
    expect(merged.planScale).toEqual({ modul1: 1.5, modul2: 2.0 })
  })

  it('a building edit on one device survives a map edit on another (whole-doc three-way)', () => {
    const base = { building: { floors: [{ id: 'f0' }] }, entities: [] }
    const theirs = { building: { floors: [{ id: 'f0' }, { id: 'f1' }] }, entities: [] } // they added a floor
    const mine = { building: { floors: [{ id: 'f0' }] }, entities: [o('e1')] }           // I drew on the map
    const merged = mergeWorkspace(base, mine, theirs) as { building: { floors: { id: string }[] } }
    expect(merged.building.floors.map((f) => f.id)).toEqual(['f0', 'f1']) // their building edit survives
  })

  it('merges target movement concurrently with attachment/style editing on a different line object', () => {
    const attachment = { target: { kind: 'object', id: 'pump' }, routing: 'direct' }
    const base = { entities: [o('pump', { coord: [7, 47] })], drawings: [o('hose', { coords: [[7, 47], [7.1, 47.1]], color: 'blue', startAttachment: attachment })] }
    const theirs = { ...base, entities: [o('pump', { coord: [7.01, 47.01] })] }
    const mine = { ...base, drawings: [o('hose', { coords: [[7, 47], [7.1, 47.1]], color: 'red', startAttachment: attachment })] }
    const merged = mergeWorkspace(base, mine, theirs) as { entities: { coord: number[] }[]; drawings: { color: string; startAttachment: unknown }[] }
    expect(merged.entities[0].coord).toEqual([7.01, 47.01])
    expect(merged.drawings[0]).toMatchObject({ color: 'red', startAttachment: attachment })
  })

  it('the shared picked Einsatzobjekt propagates when the resolver did not change it', () => {
    const base = { pickedObjectId: undefined }
    const theirs = { pickedObjectId: 'obj-7' } // they picked an object
    const mine = { pickedObjectId: undefined, entities: [o('e1')] } // I only drew
    expect(mergeWorkspace(base, mine, theirs).pickedObjectId).toBe('obj-7')
  })

  // ⚠️ The device that is still SHOWING the review banner saves without the stamp — if this fell
  // through to «mine» it would unset what the tablet at the desk just confirmed, and the banner
  // would come back on every device.
  it('the «Einsatzdaten geprüft» stamp survives a save from a device that has not reviewed', () => {
    const base = {}
    const theirs = { intakeReviewedAt: '2026-08-25T20:10:00Z' } // they tapped «Passt»
    const mine = { entities: [o('e1')] } // I only drew
    expect(mergeWorkspace(base, mine, theirs).intakeReviewedAt).toBe('2026-08-25T20:10:00Z')
  })

  it('same singleton edited on both sides stays last-writer-wins (mine)', () => {
    const base = { settings: { contactIntervalMin: 10 } }
    const theirs = { settings: { contactIntervalMin: 20 } }
    const mine = { settings: { contactIntervalMin: 30 } }
    const merged = mergeWorkspace(base, mine, theirs) as { settings: { contactIntervalMin: number } }
    expect(merged.settings.contactIntervalMin).toBe(30)
  })

  // Schichtbänder: the columns of the Schichten grid. They ride the blob as a plain id-keyed
  // collection, which is the entire reason creating one must write no shifts — see below.
  it('two devices each defining a shift band keep both', () => {
    const base = { bands: [] as { id: string }[] }
    const theirs = { bands: [o('bd1', { label: 'Früh', from: '2026-07-28T05:00:00Z', to: '2026-07-28T10:00:00Z' })] }
    const mine = { bands: [o('bd2', { label: 'Spät', from: '2026-07-28T10:00:00Z', to: '2026-07-28T15:00:00Z' })] }
    const merged = mergeWorkspace(base, mine, theirs) as { bands: { id: string; label: string }[] }
    expect(merged.bands.map((b) => b.label)).toEqual(['Früh', 'Spät'])
  })

  it('deleting a band beats a concurrent rename, and its shifts are untouched by the merge', () => {
    // «Band löschen lässt seine Schichten stehen» is enforced by useBandActions (it strips
    // bandId); the merge only has to not resurrect the band and not lose the shifts.
    const sh = o('sh1', { personId: 'p1', from: 'a', to: 'b' })
    const base = { bands: [o('bd1', { label: 'Früh' })], shifts: [o('sh1', { personId: 'p1', from: 'a', to: 'b', bandId: 'bd1' })] }
    const theirs = { bands: [o('bd1', { label: 'Frühschicht' })], shifts: base.shifts }
    const mine = { bands: [] as { id: string }[], shifts: [sh] } // I deleted the band; the shift stayed, freihändig
    const merged = mergeWorkspace(base, mine, theirs) as { bands: unknown[]; shifts: Record<string, unknown>[] }
    expect(merged.bands).toEqual([])
    expect(merged.shifts).toEqual([sh])
    expect(merged.shifts[0].bandId).toBeUndefined()
  })

  it('still keeps local view state (activePlanId) on the resolver side', () => {
    const merged = mergeWorkspace({ activePlanId: 'p1' }, { activePlanId: 'p2' }, { activePlanId: 'p3' })
    expect(merged.activePlanId).toBe('p2') // my view is never yanked by a merge
  })
})

describe('mergeById — documented LWW data-loss (whole-object replacement, non-Trupp collections)', () => {
  // For every collection EXCEPT trupps the merge is per-OBJECT last-writer-wins with
  // WHOLE-OBJECT replacement — it does NOT merge field-by-field within a single object. So when
  // two devices concurrently edit DIFFERENT fields of the SAME object, the later writer
  // ("mine") replaces the object wholesale and the other device's field change is silently
  // lost. These lock that documented limitation in (see memory: KP Front sync limitations /
  // per-object LWW). Trupps are the deliberate exception — see the field-level suite below.
  it('loses one side when two devices edit different fields of the same object', () => {
    const base = [o('a', { label: 'Tank', floor: 0 })]
    const theirs = [o('a', { label: 'Tank', floor: 3 })] // they only changed floor
    const mine = [o('a', { label: 'TLF', floor: 0 })]    // I only changed the label
    const [merged] = mergeById(base, mine, theirs)
    // mine wins wholesale: my label survives but THEIR floor edit is gone (not 3).
    // The whole object is replaced, so floor is my 0, NOT their concurrent 3.
    expect(merged).toEqual(o('a', { label: 'TLF', floor: 0 }))
  })

  it('whole-blob: a concurrent field edit on the same entity is dropped at the workspace level too', () => {
    const base = { entities: [o('e1', { label: 'A', rotation: 0 })] }
    const theirs = { entities: [o('e1', { label: 'A', rotation: 90 })] } // they rotated it
    const mine = { entities: [o('e1', { label: 'B', rotation: 0 })] }    // I renamed it
    const merged = mergeWorkspace(base, mine, theirs) as { entities: { label: string; rotation: number }[] }
    expect(merged.entities).toHaveLength(1)
    expect(merged.entities[0].label).toBe('B')      // my rename survives
    expect(merged.entities[0].rotation).toBe(0)     // their concurrent rotation is lost (not 90)
  })
})

// Trupps are SCBA crew monitoring — losing a pressure reading from the board to a concurrent
// radio contact is safety-relevant, so they are the one collection merged FIELD-level
// (mergeTrupp) instead of whole-object LWW. The everyday case under test: the Truppüberwacher
// books a Druckmeldung on the tablet while the EL's phone books the Funkkontakt.
describe('mergeWorkspace — trupps: field-level three-way merge', () => {
  const E = '2026-09-01T20:00:00.000Z'  // entry
  const T2 = '2026-09-01T20:10:00.000Z' // my Druckmeldung
  const T3 = '2026-09-01T20:12:00.000Z' // their (later) Funkkontakt
  const baseTrupp = {
    id: 't1', name: 'Meier', status: 'aktiv', entryPressureBar: 300, entryTime: E,
    lastContactTime: E, lowestBar: 300,
    readings: [{ t: E, bar: 300, kind: 'entry' }],
  }
  const ws = (trupp: Record<string, unknown>) => ({ trupps: [trupp] })
  const mergedTrupp = (mine: Record<string, unknown>, theirs: Record<string, unknown>) =>
    (mergeWorkspace(ws(baseTrupp), ws(mine), ws(theirs)) as { trupps: Record<string, unknown>[] }).trupps[0]
  // …and with an explicit ancestor, for the cases whose base is not the shared fixture
  const mergedTrupp2 = (base: Record<string, unknown>, mine: Record<string, unknown>, theirs: Record<string, unknown>) =>
    (mergeWorkspace(ws(base), ws(mine), ws(theirs)) as { trupps: Record<string, unknown>[] }).trupps[0]

  it('a Druckmeldung and a Funkkontakt from two devices both survive, readings union intact', () => {
    const mine = { ...baseTrupp, lastPressureBar: 150, lastPressureTime: T2, lastContactTime: T2, lowestBar: 150,
      readings: [...baseTrupp.readings, { t: T2, bar: 150, kind: 'pressure' }] }
    const theirs = { ...baseTrupp, lastContactTime: T3,
      readings: [...baseTrupp.readings, { t: T3, bar: 300, kind: 'contact' }] }
    const t = mergedTrupp(mine, theirs)
    expect(t.lastPressureBar).toBe(150)  // my pressure reading survives …
    expect(t.lastPressureTime).toBe(T2)
    expect(t.lowestBar).toBe(150)
    expect(t.lastContactTime).toBe(T3)   // … and so does their (later) radio contact
    // readings union, chronological: entry, my pressure, their contact — nothing dropped
    expect((t.readings as { t: string; kind: string }[]).map((r) => r.kind)).toEqual(['entry', 'pressure', 'contact'])
  })

  it('dedupes a reading row present on both sides (it appears once)', () => {
    const shared = { t: T2, bar: 150, kind: 'pressure' } // reached both devices via an earlier sync
    const mine = { ...baseTrupp, readings: [...baseTrupp.readings, shared] }
    const theirs = { ...baseTrupp, lastContactTime: T3,
      readings: [...baseTrupp.readings, shared, { t: T3, bar: 150, kind: 'contact' }] }
    const t = mergedTrupp(mine, theirs)
    expect((t.readings as { kind: string }[]).map((r) => r.kind)).toEqual(['entry', 'pressure', 'contact'])
  })

  it('the contact clock never moves backwards: the later lastContactTime wins in both directions', () => {
    const at = (iso: string) => ({ ...baseTrupp, lastContactTime: iso,
      readings: [...baseTrupp.readings, { t: iso, bar: 300, kind: 'contact' }] })
    expect(mergedTrupp(at(T2), at(T3)).lastContactTime).toBe(T3) // theirs is later
    expect(mergedTrupp(at(T3), at(T2)).lastContactTime).toBe(T3) // mine is later — not "mine wins"
  })

  it('a one-sided field edit passes through while the other device edits a different field', () => {
    const mine = { ...baseTrupp, ziel: '2. OG links' }
    const theirs = { ...baseTrupp, funkkanal: 12 }
    const t = mergedTrupp(mine, theirs)
    expect(t.ziel).toBe('2. OG links')
    expect(t.funkkanal).toBe(12)
  })

  it('reports the concurrent Trupp edit via onTruppConflict — and only a genuine one', () => {
    const conflicts: { key: string }[] = []
    const mine = { ...baseTrupp, ziel: '2. OG links' }
    const theirs = { ...baseTrupp, funkkanal: 12 }
    mergeWorkspace(ws(baseTrupp), ws(mine), ws(theirs), undefined, (c) => conflicts.push(c))
    expect(conflicts.map((c) => c.key)).toEqual(['t1'])
    // one side untouched → no report (and no false alarm on every ordinary sync)
    conflicts.length = 0
    mergeWorkspace(ws(baseTrupp), ws(baseTrupp), ws(theirs), undefined, (c) => conflicts.push(c))
    expect(conflicts).toEqual([])
  })

  // The state machine merges as ONE unit when both sides moved the status (review 02.09.):
  // a per-field resolution paired «aktiv» with the other device's exitTime — and any exitTime
  // reads as raus (deriveTruppLive), so the contact clock went silent on a crew inside.
  it('«Eingerückt» racing «Draussen» stays in the field — never aktiv-with-exitTime', () => {
    const E2 = '2026-09-01T20:15:00.000Z'
    const X = '2026-09-01T20:14:00.000Z'
    const paused = { ...baseTrupp, status: 'pause' }
    const mine = { ...paused, status: 'aktiv', entryTime: E2, lastContactTime: E2 }
    const theirs = { ...paused, status: 'raus', exitTime: X }
    const t = mergedTrupp2(paused, mine, theirs)
    expect(t.status).toBe('aktiv')
    expect(t.entryTime).toBe(E2)
    expect(t.exitTime).toBeUndefined() // the chimera this test exists for
    // …and in the other direction the in-field side still wins (not "mine wins")
    const t2 = mergedTrupp2(paused, theirs, mine)
    expect(t2.status).toBe('aktiv')
    expect(t2.exitTime).toBeUndefined()
  })

  it('a status conflict between two out-of-field states keeps LWW-mine, stamps included', () => {
    const X = '2026-09-01T20:14:00.000Z'
    const mine = { ...baseTrupp, status: 'raus', exitTime: X }
    const theirs = { ...baseTrupp, status: 'angemeldet' }
    const t = mergedTrupp2(baseTrupp, mine, theirs)
    expect(t.status).toBe('raus')
    expect(t.exitTime).toBe(X)
  })
})

// Rapport-Beilagen merge like every other id-keyed collection. Worth its own case because the
// Rapport is typically assembled on ONE device while the Lage is still being worked on another:
// the two saves must not eat each other's photos.
describe('mergeWorkspace — Rapport-Beilagen', () => {
  it('keeps a Beilage each device added independently', () => {
    const base = { attachments: [] }
    const mine = { attachments: [{ id: 'a1', url: '/api/media/1' }] }
    const theirs = { attachments: [{ id: 'a2', url: '/api/media/2' }] }
    const out = mergeWorkspace(base, mine, theirs) as { attachments: { id: string }[] }
    expect(out.attachments.map((a) => a.id).sort()).toEqual(['a1', 'a2'])
  })

  it('lets a delete beat a concurrent caption edit', () => {
    const base = { attachments: [{ id: 'a1', url: '/api/media/1' }] }
    const mine = { attachments: [] } // I removed it
    const theirs = { attachments: [{ id: 'a1', url: '/api/media/1', caption: 'Ausweis' }] }
    const out = mergeWorkspace(base, mine, theirs) as { attachments: unknown[] }
    expect(out.attachments).toEqual([])
  })
})

// The Alarmierungs-/Ausrückzeiten grid has a writer the app does not control: the alarm
// pipeline pushes per-vehicle milestones straight into the SERVER's blob. Before 31.08. the
// two arrays were merged flat — one typed time on the tablet took the whole array with it and
// the webhook's rows vanished, while the Verlauf still carried the «PIO vor Ort» row the
// webhook writes only when it actually stores the value.
describe('mergeWorkspace — reportMeta Zeiten grid', () => {
  it('keeps a webhook-written vehicle row when the operator types a time for another one', () => {
    const base = { reportMeta: { fahrzeuge: [] } }
    const theirs = { reportMeta: { fahrzeuge: [{ id: 'pio', vorOrt: '2026-08-31T20:14:00Z' }] } }
    const mine = { reportMeta: { fahrzeuge: [{ id: 'tlf', ausgerueckt: '2026-08-31T20:05:00Z', manual: true }] } }
    const out = mergeWorkspace(base, mine, theirs) as { reportMeta: { fahrzeuge: { id: string }[] } }
    expect(out.reportMeta.fahrzeuge.map((f) => f.id).sort()).toEqual(['pio', 'tlf'])
  })

  it('lets the operator’s hand-typed time win on the SAME vehicle', () => {
    const base = { reportMeta: { fahrzeuge: [{ id: 'pio' }] } }
    const theirs = { reportMeta: { fahrzeuge: [{ id: 'pio', vorOrt: '2026-08-31T20:14:00Z' }] } }
    const mine = { reportMeta: { fahrzeuge: [{ id: 'pio', vorOrt: '2026-08-31T20:11:00Z', manual: true }] } }
    const out = mergeWorkspace(base, mine, theirs) as { reportMeta: { fahrzeuge: { vorOrt: string }[] } }
    expect(out.reportMeta.fahrzeuge[0].vorOrt).toBe('2026-08-31T20:11:00Z')
  })

  it('merges the Gruppen rows the same way', () => {
    const base = { reportMeta: { gruppen: [] } }
    const theirs = { reportMeta: { gruppen: [{ id: 'g1', alarmedAt: '2026-08-31T20:01:00Z' }] } }
    const mine = { reportMeta: { gruppen: [{ id: 'g2', alarmedAt: '2026-08-31T20:03:00Z', manual: true }] } }
    const out = mergeWorkspace(base, mine, theirs) as { reportMeta: { gruppen: { id: string }[] } }
    expect(out.reportMeta.gruppen.map((g) => g.id).sort()).toEqual(['g1', 'g2'])
  })

  it('clearing the last field of a row still removes it', () => {
    const base = { reportMeta: { fahrzeuge: [{ id: 'pio', vorOrt: '2026-08-31T20:14:00Z' }] } }
    const mine = { reportMeta: { fahrzeuge: [] } } // operator cleared the field
    const theirs = base
    const out = mergeWorkspace(base, mine, theirs) as { reportMeta: { fahrzeuge?: unknown[] } }
    expect(out.reportMeta.fahrzeuge ?? []).toEqual([])
  })
})
