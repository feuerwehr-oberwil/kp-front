import { describe, expect, it } from 'vitest'
import { formAnno, formDelta, newFormPage, putLine, putRow, type BoardFormData, type FormAnno } from './boardForm'
import { mergeFormData } from './boardFormMerge'
import { BUNDLED_TEMPLATES } from './boardTemplates'
import { mergeWorkspace, type RecordConflict } from './mergeWorkspace'
import { isPassengerAnno, sanitizeWorkspace } from './workspace'
import { viewsOf, type TacticalObject } from './tacticalObjects'
import type { BoardAnno } from '../types'

const FKS = BUNDLED_TEMPLATES[0]
const EF = FKS.pages[0]
const page = (): BoardFormData => newFormPage(FKS, EF, {}, '2026-10-10T09:00:00.000Z')
const sheet = (a: BoardAnno): TacticalObject => ({ id: a.id, sheet: { planId: 'tafel', anno: a } })

describe('a board object this build does not understand is a PASSENGER: kept, never dropped (review of #338)', () => {
  const unknown = { id: 'st1', kind: 'sticker', glue: { colour: 'pink' } } as unknown as BoardAnno
  // a page from a newer template: a section type this build has never seen, a column type too
  const newer = formAnno(page())
  newer.form.page = { ...newer.form.page, sections: [...newer.form.page.sections, { id: 'zeitstrahl', type: 'timeline', ticks: 12 } as never] }
  ;(newer.form.values as Record<string, unknown>).zeitstrahl = { marks: [3, 7] }
  // …and a page this build cannot draw at all (a future v2)
  const v2 = { id: 'fm2', kind: 'form', form: { v: 2, layout: 'grid' } } as unknown as BoardAnno

  it('passes the load gate exactly as it came, in the objects and in the legacy board view', () => {
    expect([unknown, v2].map(isPassengerAnno)).toEqual([true, true])
    expect(isPassengerAnno(newer)).toBe(false) // drawable: the unknown section is merely not drawn
    const blob = JSON.parse(JSON.stringify({ objects: [unknown, newer, v2].map(sheet), board: { tafel: [unknown, newer, v2] } }))
    const g = sanitizeWorkspace(blob)
    expect(g.dropped).toBe(0)
    expect(g.ws?.objects?.map((o) => o.sheet?.anno)).toEqual([unknown, newer, v2])
    expect(g.ws?.board?.tafel).toEqual([unknown, newer, v2])
    expect(viewsOf(g.ws!.objects!).board.tafel).toEqual([unknown, newer, v2])
  })

  it('survives a merge untouched, and so does the newer page’s unknown section and value', () => {
    const objects = [unknown, newer, v2].map(sheet)
    const ws = (o: TacticalObject[]) => JSON.parse(JSON.stringify({ objects: o }))
    const merged = mergeWorkspace(ws(objects), ws(objects), ws(objects)) as { objects: TacticalObject[] }
    expect(merged.objects.map((o) => o.sheet?.anno)).toEqual([unknown, newer, v2])
    // …and an edit by THIS build to the newer page keeps what it does not know
    const edited = putLine(newer.form, 'problem', 'front', 'l1', { text: 'Rauch' })
    expect((edited.values as Record<string, unknown>).zeitstrahl).toEqual({ marks: [3, 7] })
    expect(edited.page.sections[edited.page.sections.length - 1]).toEqual({ id: 'zeitstrahl', type: 'timeline', ticks: 12 })
  })
})

describe('two devices on one page: merged cell by cell (review of #338)', () => {
  const base = page()
  it('different cells: both survive', () => {
    const mine = putRow(base, 'massnahmen', 'm1', { cells: { was: 'Riegel Seite C', wer: 'TLF' } }, 1000)
    const theirs = putRow(putLine(base, 'problem', 'front', 'l1', { text: 'Rauch' }, 1100), 'verbindungen', 'v1', { cells: { funktion: 'EL', kanal: 'K1' } }, 1200)
    const m = mergeFormData(base, mine, theirs)
    expect(m.values.massnahmen.rows?.[0].cells).toEqual({ was: 'Riegel Seite C', wer: 'TLF' })
    expect(m.values.verbindungen.rows?.[0].cells).toEqual({ funktion: 'EL', kanal: 'K1' })
    expect(m.values.problem.lines?.front?.map((l) => l.text)).toEqual(['Rauch'])
  })
  it('the same cell changed on both: the later edit stands, and the divergence is reported', () => {
    const shared = putRow(base, 'massnahmen', 'm1', { cells: { was: 'Riegel', wer: 'TLF' } }, 500)
    const mine = putRow(shared, 'massnahmen', 'm1', { cells: { wer: 'ADL' } }, 2000)
    const theirs = putRow(shared, 'massnahmen', 'm1', { cells: { wer: 'MTF', was: 'Riegel Seite B' } }, 1500)
    const seen: string[] = []
    const m = mergeFormData(shared, mine, theirs, (c) => seen.push(`${c.where}: ${c.kept} > ${c.lost}`))
    // «wer» both changed → the later (mine, 2000) wins; «was» only theirs changed → theirs
    expect(m.values.massnahmen.rows?.[0].cells).toEqual({ was: 'Riegel Seite B', wer: 'ADL' })
    expect(seen).toEqual(['Massnahmen · Wer: ADL > MTF'])
    // …and the other way round the earlier edit loses even though it is «mine»
    const late = putRow(shared, 'massnahmen', 'm1', { cells: { wer: 'MTF' } }, 3000)
    expect(mergeFormData(shared, mine, late).values.massnahmen.rows?.[0].cells.wer).toBe('MTF')
  })
  it('a row cleared on one side and edited on the other: the later edit decides, nothing vanishes silently', () => {
    const shared = putRow(base, 'massnahmen', 'm1', { cells: { was: 'Riegel' } }, 500)
    const cleared = putRow(shared, 'massnahmen', 'm1', { cells: { was: '' } }, 900)
    const edited = putRow(shared, 'massnahmen', 'm1', { cells: { was: 'Riegel Seite C' } }, 1200)
    const seen: string[] = []
    expect(mergeFormData(shared, cleared, edited, (c) => seen.push(c.lost)).values.massnahmen.rows?.[0].cells.was).toBe('Riegel Seite C')
    expect(seen).toEqual([''])
  })
  it('rides mergeWorkspace: a both-changed page goes field-level, and the conflict reaches the caller', () => {
    const anno = formAnno(putRow(base, 'massnahmen', 'm1', { cells: { was: 'Riegel' } }, 500)) as FormAnno
    const at = (f: BoardFormData) => ({ objects: [sheet({ ...anno, form: f })] })
    const mine = putRow(anno.form, 'massnahmen', 'm1', { cells: { was: 'Riegel Seite C' } }, 2000)
    const theirs = putRow(putLine(anno.form, 'problem', 'front', 'l1', { text: 'Rauch' }, 1800), 'massnahmen', 'm1', { cells: { was: 'Riegel Seite B' } }, 1900)
    const conflicts: RecordConflict[] = []
    const out = mergeWorkspace(at(anno.form), at(mine), at(theirs), undefined, undefined, { onFormConflict: (c) => conflicts.push(c) }) as { objects: TacticalObject[] }
    const form = out.objects[0].sheet!.anno.form!
    expect(form.values.massnahmen.rows?.[0].cells.was).toBe('Riegel Seite C')
    expect(form.values.problem.lines?.front?.map((l) => l.text)).toEqual(['Rauch'])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].key).toBe(`${anno.id}|r|massnahmen|m1|was`)
  })
})

describe('the audit hears a cell, not the page', () => {
  it('formDelta names the atoms that changed', () => {
    const a = page()
    const b = putRow(a, 'massnahmen', 'm1', { cells: { was: 'Riegel', wer: 'TLF' } })
    expect(formDelta(a, b)).toEqual([{ k: 'r|massnahmen|m1|was', new: 'Riegel' }, { k: 'r|massnahmen|m1|wer', new: 'TLF' }])
    expect(JSON.stringify(formDelta(a, b)).length).toBeLessThan(200)
  })
})
