import { describe, expect, it } from 'vitest'
import { autoChoice, decideNewVisit } from './newVisit'
import type { LocalVisit } from './store'
import type { VisitTemplate } from './types'

const base = {
  localsLoaded: true, localsOk: true, catalogueLoaded: true, hasCatalogue: true,
  object: { id: 'u1', name: 'O', lastVisit: { id: 'ov9', visitedAt: 'x', lifecycle: 'completed' as const } },
  draft: null, canCapture: true, choice: { t: null },
}

describe('decideNewVisit', () => {
  it('waits until the device list and the catalogue are in', () => {
    expect(decideNewVisit({ ...base, localsLoaded: false }).kind).toBe('wait')
    expect(decideNewVisit({ ...base, catalogueLoaded: false }).kind).toBe('wait')
  })
  it('resumes this person\'s draft before anything else', () => {
    const draft = { doc: { id: 'ov1' } } as LocalVisit
    expect(decideNewVisit({ ...base, draft })).toEqual({ kind: 'resume', id: 'ov1' })
  })
  it('a device list that could not be read never mints a second draft', () => {
    expect(decideNewVisit({ ...base, localsOk: false }).kind).toBe('storage')
  })
  it('then: not prepared, unknown object, a reader\'s way, the checklist question, create', () => {
    expect(decideNewVisit({ ...base, hasCatalogue: false }).kind).toBe('notPrepared')
    expect(decideNewVisit({ ...base, object: null }).kind).toBe('unknown')
    expect(decideNewVisit({ ...base, canCapture: false })).toEqual({ kind: 'openLast', id: 'ov9' })
    expect(decideNewVisit({ ...base, canCapture: false, object: { id: 'u1', name: 'O' } }).kind).toBe('readOnly')
    expect(decideNewVisit({ ...base, choice: null }).kind).toBe('choose')
    expect(decideNewVisit(base)).toEqual({ kind: 'create', template: null })
  })
})

describe('autoChoice', () => {
  const fm = { id: 'fehlermeldung' } as VisitTemplate
  const sh = { id: 'fu-schluesselhuelse' } as VisitTemplate
  const none = new Set<string | null>()
  it('takes the checklist asked for when the station has it', () => {
    expect(autoChoice({ asked: 'fehlermeldung', templates: [sh, fm], doneHere: none })).toEqual({ t: fm })
  })
  it('asks when the station lacks it — never starts its one other checklist instead', () => {
    expect(autoChoice({ asked: 'fehlermeldung', templates: [sh], doneHere: none })).toBeNull()
  })
  it('without an ask: one checklist is taken, several ask, a completed one asks again', () => {
    expect(autoChoice({ asked: null, templates: [sh], doneHere: none })).toEqual({ t: sh })
    expect(autoChoice({ asked: null, templates: [sh, fm], doneHere: none })).toBeNull()
    expect(autoChoice({ asked: null, templates: [sh], doneHere: new Set(['fu-schluesselhuelse']) })).toBeNull()
    expect(autoChoice({ asked: null, templates: [], doneHere: none })).toEqual({ t: null })
  })
})
