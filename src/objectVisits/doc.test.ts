import { describe, expect, it } from 'vitest'
import { answerStats, checklistItems, localIso, newVisitDoc, stripServer, switchChecklist, syncPhotoAnswers } from './doc'
import { VISIT_SCHEMA, type VisitTemplate } from './types'

const tpl: VisitTemplate = {
  id: 'schluesselhuelse', kind: 'visit', version: 1, title: 'Kontrolle Schlüsselhülse', source: 'FU',
  phases: [{ id: 'huelse', title: 'Schlüsselhülse', items: [
    { id: 'zugaenglich', text: 'Schlüsselhülse zugänglich', input: 'check' },
    { id: 'gereinigt', text: 'Grob gereinigt', input: 'yesno' },
    { id: 'anzahl', text: 'Anzahl Schlüssel', input: 'number', unit: 'Stk.' },
    { id: 'foto', text: 'Foto Schlüsselhülse', input: 'photo', required: true },
    { id: 'plain', text: 'Ohne input = check' },
  ] }],
}

describe('visit document', () => {
  it('a new draft carries the contract shape and an ov id', () => {
    const d = newVisitDoc({ object: { id: 'o', name: 'O' }, workRef: 'fu/B4', checklist: tpl, now: new Date('2026-10-03T06:14:00Z') })
    expect(d).toMatchObject({ schema: VISIT_SCHEMA, lifecycle: 'draft', workRef: 'fu/B4', answers: {}, notes: '', photos: [], proposals: [] })
    expect(d.id).toMatch(/^[a-z]{1,4}[0-9a-z-]{6,64}$/)
    expect(d.visitedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
  })
  it('«Von» starts with the people given (this device\'s last ones)', () => {
    expect(newVisitDoc({ object: { id: 'o', name: 'O' }, checklist: null, people: ['Frei Nina'] }).with).toEqual(['Frei Nina'])
    expect(newVisitDoc({ object: { id: 'o', name: 'O' }, checklist: null, people: [] })).not.toHaveProperty('with')
  })
  it('localIso keeps the wall clock and the offset', () => {
    const s = localIso(new Date(2026, 9, 3, 8, 14, 0))
    expect(s.startsWith('2026-10-03T08:14:00')).toBe(true)
  })
  it('unanswered is «nicht geprüft», photo items count once a photo links them', () => {
    let d = newVisitDoc({ object: { id: 'o', name: 'O' }, checklist: tpl })
    d = { ...d, answers: { zugaenglich: { v: 'defect', note: 'klemmt' }, gereinigt: { v: 'no' } } }
    let st = answerStats(d)
    expect(st).toMatchObject({ total: 5, answered: 2, defects: 1, open: 3 })
    expect(st.requiredOpen.map((i) => i.id)).toEqual(['foto'])
    d = syncPhotoAnswers({ ...d, photos: [{ id: 'ova1', caption: '', item: 'foto', sha256: 's', size: 1, type: 'image/jpeg' }] })
    expect(d.answers.foto).toEqual({ v: 'photo' })
    st = answerStats(d)
    expect(st.requiredOpen).toEqual([])
    expect(syncPhotoAnswers({ ...d, photos: [] }).answers.foto).toBeUndefined()
    expect(checklistItems(tpl)).toHaveLength(5)
  })
  it('stripServer removes the server fields and defaults the lists', () => {
    const d = newVisitDoc({ object: { id: 'o', name: 'O' }, checklist: null })
    const v = { ...d, revision: 3, ready: true, missing: [], url: 'x', deliveries: [], findings: 0, createdBy: { name: 'A' } }
    expect(stripServer(v)).toEqual(d)
  })
})

describe('switchChecklist — a draft moves to another checklist', () => {
  const plan: VisitTemplate = {
    id: 'einsatzplan', kind: 'visit', version: 2, title: 'Kontrolle Einsatzplan', source: 'FU',
    phases: [{ id: 'p', title: 'Plan', items: [
      { id: 'zugaenglich', text: 'Zugang wie im Plan', input: 'check' },
      { id: 'gereinigt', text: 'gleiche id, anderer Typ', input: 'check' },
      { id: 'foto', text: 'Foto Zugang', input: 'photo' },
    ] }],
  }
  const photo = (id: string, item?: string) => ({ id, caption: '', ...(item ? { item } : {}), sha256: 's', size: 1, type: 'image/jpeg' })
  const filled = () => syncPhotoAnswers({
    ...newVisitDoc({ object: { id: 'o', name: 'O' }, checklist: tpl }),
    answers: { zugaenglich: { v: 'ok' }, gereinigt: { v: 'yes' }, anzahl: { v: 3 } },
    photos: [photo('ova1', 'foto'), photo('ova2')],
  })

  it('keeps answers of the same item and type, counts the rest, keeps every photo', () => {
    const { doc, dropped } = switchChecklist(filled(), plan)
    expect(doc.checklist?.id).toBe('einsatzplan')
    expect(doc.answers).toEqual({ zugaenglich: { v: 'ok' }, foto: { v: 'photo' } })
    expect(dropped).toBe(2) // gereinigt changed type, anzahl is gone — the photo marker is not an answer
    expect(doc.photos.map((p) => [p.id, p.item ?? null])).toEqual([['ova1', 'foto'], ['ova2', null]])
  })

  it('«Ohne Checkliste» drops every answer and unlinks the photos, which stay', () => {
    const { doc, dropped } = switchChecklist(filled(), null)
    expect(doc.checklist).toBeNull()
    expect(doc.answers).toEqual({})
    expect(dropped).toBe(3)
    expect(doc.photos).toHaveLength(2)
    expect(doc.photos.every((p) => !p.item)).toBe(true)
  })

  it('takes a copy of the template, never the catalogue\'s object', () => {
    expect(switchChecklist(filled(), plan).doc.checklist).not.toBe(plan)
  })
})
