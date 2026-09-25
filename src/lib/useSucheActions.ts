import { useLayoutEffect, useRef } from 'react'
import { newId } from './ids'
import { serverNowIso } from './serverClock'
import {
  addBereich, addPerson, ensureStoreyBereiche, markFund, personEntwarnt, personGefunden, personUebergeben, renameBereich,
  rowOwner, setBereichStatus, setOhneRest, splitStorey, type GefundenInput, type SucheCx, type VermisstInput,
} from './suche'
import type { SucheBereichStatus, SucheDoc, SucheRow, TimelineEvent } from '../types'

/** The Verlauf writer as the Suche needs it: the row carries its own sentence, a `suche` link to
 *  the record it is about, and — for a forward write — the SucheRow's own id, so the Verlauf row
 *  and the record's row are one fact under one name. */
export type SucheLog = (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string,
  opts?: { rowId?: string; subjectId?: string; suche?: TimelineEvent['suche'] }) => void

interface Deps {
  suche: SucheDoc
  /** the undoable write — one call is one step on the Einsatz's timeline (IncidentWorkspace) */
  set: (next: SucheDoc) => void
  /** the plain write for the machine's own seeding, which is no step (see `seed`) */
  setRaw: (next: SucheDoc) => void
  canEdit: boolean
  log: SucheLog
  emit: (op: string, payload?: Record<string, unknown>) => void
  floorName: (floor: number) => string
}

/** Options every write takes: `silent` writes the record without its own Verlauf row, because
 *  the row that carries the words is being written by somebody else (the composer's own entry —
 *  Tür 2 — IS the Verlauf row, and a second «Gefunden: …» under it would say it twice). */
export interface SucheWriteOpts { silent?: boolean }

/**
 * The Suche's write half (lib/suche is the pure half). Every act goes through ONE path: fold the
 * change with the pure helpers, lay it down as ONE undoable step, then write each row's sentence
 * into the Verlauf and an audit op beside it. A write that changes nothing writes nothing.
 *
 * Returns what the act created where a caller needs it (the new person's id, the part a typed
 * Ziel created) so a flow can go on from there.
 */
export function useSucheActions({ suche, set, setRaw, canEdit, log, emit, floorName }: Deps) {
  // ⚠️ The LATEST doc, not the render's: a flow can take two acts in one handler (a find and its
  // handover, a part created by name and then set «in Arbeit»), and the second has to build on
  // the first rather than on the render both started from.
  const ref = useRef(suche)
  useLayoutEffect(() => { ref.current = suche })
  const cx = (): SucheCx => ({ at: serverNowIso(), newId, floorName })

  const commit = (next: SucheDoc, rows: SucheRow[], opts?: SucheWriteOpts): boolean => {
    if (!canEdit || next === ref.current) return false
    ref.current = next
    set(next)
    for (const r of rows) {
      const owner = rowOwner(next, r.id)
      if (!opts?.silent) log('search', r.text, undefined, undefined, undefined, { rowId: r.id, suche: owner })
      emit(`suche.${r.op}`, { row: r.id, ...owner })
    }
    return true
  }

  return {
    /** Every storey of the stack becomes one «ganzes Geschoss» — when the Suche is first opened,
     *  or the first Trupp is sent to «Absuchen». A machine write: idempotent (the same doc comes
     *  back when nothing is missing) and NOT a step, so opening the Suche can never be «undone». */
    seed(floors: readonly number[]) {
      if (!canEdit || !floors.length) return
      const next = ensureStoreyBereiche(ref.current, floors, serverNowIso())
      if (next === ref.current) return
      ref.current = next
      setRaw(next)
    },
    addPerson(input: VermisstInput, opts?: SucheWriteOpts): string | null {
      const r = addPerson(ref.current, input, cx())
      return commit(r.doc, [r.row], opts) ? r.person.id : null
    },
    /** «+ Gefunden»: somebody found who was never reported missing — the record and its find
     *  in ONE step, so one ↶ takes back what was one act. */
    addFound(input: VermisstInput, found: GefundenInput): string | null {
      const c = cx()
      const a = addPerson(ref.current, input, c)
      const g = personGefunden(a.doc, a.person.id, found, c)
      return commit(g.doc, [a.row, ...g.rows]) ? a.person.id : null
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
    setStatus(bereichId: string, status: SucheBereichStatus, trupp?: { label?: string; id?: string }, note?: string) {
      const r = setBereichStatus(ref.current, bereichId, status, trupp, cx(), note)
      return commit(r.doc, r.rows)
    },
    /**
     * What every device OBSERVES about a Trupp (its Ziel under «Absuchen»), written under DERIVED
     * ids (AGENTS.md · «recorded under a derived id, once»): the part a typed name creates and the
     * «in Arbeit · Trupp 4» row get ids every device computes identically from `key`, so two
     * editors reacting to the same Trupp save converge on one record and one Verlauf row. Not a
     * step on the undo timeline — the Trupp's own save is the act.
     */
    observe(key: string, fn: (doc: SucheDoc, cx: SucheCx) => { doc: SucheDoc; rows: SucheRow[] }) {
      if (!canEdit) return
      const derived: SucheCx = { at: serverNowIso(), newId: (p) => `${p}-${key}`, floorName }
      const r = fn(ref.current, derived)
      if (r.doc === ref.current) return
      // the same observation twice (a Ziel set back to one it had): its derived ids are taken,
      // and the record already says it — write nothing rather than a second row under one id
      const taken = new Set([...ref.current.personen, ...ref.current.bereiche].flatMap((x) => [x.id, ...x.log.map((row) => row.id)]))
      if (r.rows.some((row) => taken.has(row.id))) return
      ref.current = r.doc
      setRaw(r.doc)
      for (const row of r.rows) log('search', row.text, undefined, undefined, undefined, { rowId: row.id, suche: rowOwner(r.doc, row.id) })
    },
    fund(bereichId: string, personId?: string) {
      const r = markFund(ref.current, bereichId, personId, cx())
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
    /** «+ Bereich (Name)», or a typed Ziel: finds the area by name, else creates it. Returns its
     *  id — `null` only for an empty name. */
    addBereich(input: { name: string; floor?: number }): string | null {
      const r = addBereich(ref.current, input, cx())
      if (r.doc !== ref.current) commit(r.doc, r.rows)
      return r.id
    },
  }
}

export type SucheActions = ReturnType<typeof useSucheActions>
