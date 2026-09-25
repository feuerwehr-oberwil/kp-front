import { useLayoutEffect, useRef } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { newId } from './ids'
import { serverNowIso } from './serverClock'
import {
  addBereich, addFoundPerson, addPerson, applySuchePatch, diffSuche, ensureStoreyBereiche, markFund, patchEmpty, patchRows,
  personEntwarnt, personGefunden, personIrrtuemlich, personKorrigiert, personUebergeben, renameBereich, rowOwner,
  setBereichStatus, setOhneRest, splitStorey,
  type GefundenInput, type SucheCx, type SuchePatch, type VermisstInput,
} from './suche'
import type { SucheBereichStatus, SucheDoc, SucheRow, TimelineEvent } from '../types'

/** The Verlauf writer as the Suche needs it: the row carries its own sentence, a `suche` link to
 *  the record it is about, and — for a forward write — the SucheRow's own id, so the Verlauf row
 *  and the record's row are one fact under one name. */
export type SucheLog = (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string,
  opts?: { rowId?: string; subjectId?: string; suche?: TimelineEvent['suche'] }) => void

interface Deps {
  suche: SucheDoc
  /** the plain write — every change goes through it; history is kept HERE, as patches */
  setRaw: (next: SucheDoc) => void
  /** put one step on the Einsatz's undo timeline (IncidentWorkspace · undoHist) */
  remember?: (label: string, undo: () => boolean, redo: () => boolean) => void
  canEdit: boolean
  log: SucheLog
  emit: (op: string, payload?: Record<string, unknown>) => void
  floorName: (floor: number) => string
  /** which Gebäude the storeys belong to (lib/suche · stackKeyOf) */
  stack: string
}

/** Options every write takes: `silent` writes the record without its own Verlauf row, because
 *  the row that carries the words is being written by somebody else (the composer's own entry —
 *  Tür 2 — IS the Verlauf row, and a second «Gefunden: …» under it would say it twice). */
export interface SucheWriteOpts { silent?: boolean }

/**
 * The Suche's write half (lib/suche is the pure half). Every act goes through ONE path: fold the
 * change with the pure helpers, write it, and lay down ONE undo step that holds exactly what the
 * act added (`diffSuche`) — so ↶ takes back that act and nothing else, not a row the machine or
 * another device wrote in between (a whole-slice snapshot did). Each row's sentence goes into the
 * Verlauf, and ONE audit event carries the patch, which is what replay folds forward
 * (lib/replay · `suche.step` / `suche.undo`).
 *
 * Returns what the act created where a caller needs it (the new person's id, the part a typed
 * Ziel created) so a flow can go on from there.
 */
export function useSucheActions({ suche, setRaw, remember, canEdit, log, emit, floorName, stack }: Deps) {
  // ⚠️ The LATEST doc, not the render's: a flow can take two acts in one handler (a seed and the
  // Ziel that lands on it, a part created and then set «in Arbeit»), and the second has to build
  // on the first rather than on the render both started from.
  const ref = useRef(suche)
  useLayoutEffect(() => { ref.current = suche })
  const cx = (): SucheCx => ({ at: serverNowIso(), newId, floorName, stack })

  const write = (next: SucheDoc): SuchePatch | null => {
    const patch = diffSuche(ref.current, next)
    if (patchEmpty(patch)) return null
    ref.current = next
    setRaw(next)
    emit('suche.step', { patch })
    return patch
  }
  const say = (rows: SucheRow[], doc: SucheDoc, words: (r: SucheRow) => string = (r) => r.text, icon = 'search', kind?: TimelineEvent['kind'], sameId = true) => {
    for (const r of rows) log(icon, words(r), kind, undefined, undefined, { ...(sameId ? { rowId: r.id } : {}), suche: rowOwner(doc, r.id) })
  }
  /** one step: forward now, and the pair that takes it back / puts it back */
  const step = (patch: SuchePatch, label: string) => {
    remember?.(label, () => revert(patch, 'undo'), () => revert(patch, 'redo'))
  }
  const revert = (patch: SuchePatch, dir: 'undo' | 'redo'): boolean => {
    if (!canEdit) return false
    const before = ref.current
    const next = applySuchePatch(before, patch, dir)
    const moved = diffSuche(dir === 'undo' ? next : before, dir === 'undo' ? before : next)
    if (patchEmpty(moved)) return false
    ref.current = next
    setRaw(next)
    emit(dir === 'undo' ? 'suche.undo' : 'suche.step', { patch })
    const rows = patchRows(moved)
    if (dir === 'undo') say(rows, before, (r) => fillTemplate(appConfig.copy.suche.rowUndone, { text: r.text }), 'undo', 'history', false)
    else say(rows, next, undefined, 'search', undefined, false)
    return true
  }
  const commit = (next: SucheDoc, rows: SucheRow[], opts?: SucheWriteOpts): boolean => {
    if (!canEdit) return false
    const patch = write(next)
    if (!patch) return false
    if (!opts?.silent) say(rows, next)
    step(patch, rows[0]?.text ?? appConfig.copy.undoDomains.suche)
    return true
  }

  return {
    /** Every storey of the stack becomes one «ganzes Geschoss» — when the Suche is first opened,
     *  or the first Trupp is sent to «Absuchen». A machine write: idempotent (the same doc comes
     *  back when nothing is missing) and NOT a step, so opening the Suche can never be «undone». */
    seed(floors: readonly number[]) {
      if (!canEdit || !floors.length) return
      write(ensureStoreyBereiche(ref.current, floors, serverNowIso(), stack))
    },
    addPerson(input: VermisstInput, opts?: SucheWriteOpts): string | null {
      const r = addPerson(ref.current, input, cx())
      return commit(r.doc, [r.row], opts) ? r.person.id : null
    },
    /** «+ Gefunden»: somebody found who was never reported missing — ONE «Gefunden» row. */
    addFound(input: VermisstInput, found: GefundenInput): string | null {
      const r = addFoundPerson(ref.current, input, found, cx())
      return commit(r.doc, [r.row]) ? r.person.id : null
    },
    gefunden(personId: string, input: GefundenInput, opts?: SucheWriteOpts) {
      const r = personGefunden(ref.current, personId, input, cx())
      return commit(r.doc, r.rows, opts)
    },
    uebergeben(personId: string, an: string, n?: number) {
      const r = personUebergeben(ref.current, personId, { an, n }, cx())
      return commit(r.doc, r.rows)
    },
    entwarnen(personId: string) {
      const r = personEntwarnt(ref.current, personId, cx())
      return commit(r.doc, r.rows)
    },
    korrigieren(personId: string, next: { name?: string; count?: number; floor?: number; wo?: string }) {
      const r = personKorrigiert(ref.current, personId, next, cx())
      return commit(r.doc, r.rows)
    },
    irrtuemlich(personId: string) {
      const r = personIrrtuemlich(ref.current, personId, cx())
      return commit(r.doc, r.rows)
    },
    setStatus(bereichId: string, status: SucheBereichStatus, trupp?: { label?: string; id?: string }, note?: string) {
      const r = setBereichStatus(ref.current, bereichId, status, trupp, cx(), note)
      return commit(r.doc, r.rows)
    },
    fund(bereichId: string) {
      const r = markFund(ref.current, bereichId, cx())
      return commit(r.doc, r.rows)
    },
    split(floor: number, names: string[], keepRest: boolean) {
      const r = splitStorey(ref.current, floor, names, keepRest, cx())
      return commit(r.doc, r.rows)
    },
    setOhneRest(floor: number, ohneRest: boolean) {
      const r = setOhneRest(ref.current, floor, ohneRest, cx())
      return commit(r.doc, r.rows)
    },
    rename(bereichId: string, name: string) {
      const r = renameBereich(ref.current, bereichId, name, cx())
      return commit(r.doc, r.rows)
    },
    /** «+ Bereich (Name)»: finds the area by name, else creates it. Returns its id — `null` only
     *  for an empty name. */
    addBereich(input: { name: string; floor?: number }): string | null {
      const r = addBereich(ref.current, input, cx())
      if (r.doc !== ref.current) commit(r.doc, r.rows)
      return r.id
    },
    /**
     * What every device OBSERVES about a Trupp (its Ziel under «Absuchen»), written under DERIVED
     * ids (AGENTS.md · «recorded under a derived id, once»): the part a typed name creates and the
     * «in Arbeit · Trupp 4» row get ids every device computes identically from `key`, so two
     * editors reacting to the same Trupp save converge on one record and one Verlauf row. Not a
     * step on the undo timeline — the Trupp's own save is the act. `fn` is handed the writer's
     * LATEST doc (the storeys the same save just seeded included).
     */
    observe(key: string, fn: (doc: SucheDoc, cx: SucheCx) => { doc: SucheDoc; rows: SucheRow[] }) {
      if (!canEdit) return
      const derived: SucheCx = { at: serverNowIso(), newId: (p) => `${p}-${key}`, floorName, stack }
      const r = fn(ref.current, derived)
      if (r.doc === ref.current) return
      // the same observation twice (a second device, a re-render): its derived ids are taken, and
      // the record already says it — write nothing rather than a second row under one id
      const taken = new Set([...ref.current.personen, ...ref.current.bereiche].flatMap((x) => [x.id, ...x.log.map((row) => row.id)]))
      if (r.rows.some((row) => taken.has(row.id))) return
      if (!write(r.doc)) return
      say(r.rows, r.doc)
    },
    /** the latest doc — for a caller deciding what to observe */
    latest: () => ref.current,
  }
}

export type SucheActions = ReturnType<typeof useSucheActions>
