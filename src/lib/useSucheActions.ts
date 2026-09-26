import { useLayoutEffect, useRef } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { newId } from './ids'
import { serverNowIso } from './serverClock'
import {
  addBereich, addFoundPerson, addPerson, applySuchePatch, diffSuche, markFund, patchEmpty, patchRows,
  personEntwarnt, personGefunden, personIrrtuemlich, personKorrigiert, personUebergeben, renameBereich, rowOwner,
  setBereichStatus, setPlacePoint, toggleAbgesucht,
  type GefundenInput, type SucheCx, type SuchePatch, type SucheWhy, type VermisstInput,
} from './suche'
import type { SucheBereichStatus, SucheDoc, SuchePoint, SucheRow, TimelineEvent } from '../types'

/** The Verlauf writer as the Suche needs it: the row carries its own sentence, a `suche` link to
 *  the record it is about, and — for a forward write — the SucheRow's own id, so the Verlauf row
 *  and the record's row are one fact under one name. */
export type SucheLog = (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string,
  opts?: { rowId?: string; subjectId?: string; suche?: TimelineEvent['suche'] }) => void

interface Deps {
  suche: SucheDoc
  /** the plain write — every change goes through it; history is kept HERE, as patches */
  setRaw: (next: SucheDoc) => void
  /** put one step on the Einsatz's undo timeline (IncidentWorkspace · undoHist). Hands back the
   *  entry's dropper, which a confirm-with-undo toast needs (AGENTS.md · an act is never undoable
   *  twice) — absent where there is no timeline (a test, a hosted flow). */
  remember?: (label: string, undo: () => boolean, redo: () => boolean) => (() => void) | void
  canEdit: boolean
  log: SucheLog
  emit: (op: string, payload?: Record<string, unknown>) => void
  /** how a step-1 record's storey is named (lib/suche · SucheCx) */
  floorName: (floor: number) => string
}

/** Options every write takes: `silent` writes the record without its own Verlauf row, because
 *  the row that carries the words is being written by somebody else (the composer's own entry —
 *  Tür 2 — IS the Verlauf row, and a second «Gefunden: …» under it would say it twice). */
export interface SucheWriteOpts { silent?: boolean }

/** What an act that a toast offers to take back hands the caller: its words, and the one tap that
 *  takes it back — the patch's inverse AND the timeline entry, so ↶ cannot do it a second time. */
export interface SucheTakeBack { label: string; takeBack: () => void }

/**
 * The Suche's write half (lib/suche is the pure half). Every act goes through ONE path: fold the
 * change with the pure helpers, write it, and lay down ONE undo step that holds exactly what the
 * act added (`diffSuche`) — so ↶ takes back that act and nothing else, not a row the machine or
 * another device wrote in between (a whole-slice snapshot did). Each row's sentence goes into the
 * Verlauf, and ONE audit event carries the patch, which is what replay folds forward
 * (lib/replay · `suche.step` / `suche.undo`).
 *
 * Returns what the act created where a caller needs it (the new person's id, the place a typed
 * Ziel created) so a flow can go on from there.
 */
export function useSucheActions({ suche, setRaw, remember, canEdit, log, emit, floorName }: Deps) {
  // ⚠️ The LATEST doc, not the render's: a flow can take two acts in one handler (a Ziel's place
  // created and then set «in Arbeit»), and the second has to build on the first rather than on
  // the render both started from.
  const ref = useRef(suche)
  useLayoutEffect(() => { ref.current = suche })
  const cx = (): SucheCx => ({ at: serverNowIso(), newId, floorName })

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
  const step = (patch: SuchePatch, label: string): (() => void) | void =>
    remember?.(label, () => revert(patch, 'undo'), () => revert(patch, 'redo'))
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
  /** Write one act: the doc, its Verlauf rows, ONE step. Hands back how a toast takes it back —
   *  null when nothing was written (a second tap on the same status, a read-only device). */
  const commit = (next: SucheDoc, rows: SucheRow[], opts?: SucheWriteOpts): SucheTakeBack | null => {
    if (!canEdit) return null
    const patch = write(next)
    if (!patch) return null
    if (!opts?.silent) say(rows, next)
    const label = rows[0]?.text ?? appConfig.copy.undoDomains.suche
    const drop = step(patch, label)
    return { label, takeBack: () => { revert(patch, 'undo'); drop?.() } }
  }

  return {
    /** «＋ Vermisst» — the person, and the place when it is new: ONE step (lib/suche · addPerson). */
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
    entwarnen(personId: string, why?: SucheWhy) {
      const r = personEntwarnt(ref.current, personId, cx(), why)
      return commit(r.doc, r.rows)
    },
    korrigieren(personId: string, next: { name?: string; count?: number; wo?: string; foundWo?: string }) {
      const r = personKorrigiert(ref.current, personId, next, cx())
      return commit(r.doc, r.rows)
    },
    irrtuemlich(personId: string, why?: SucheWhy) {
      const r = personIrrtuemlich(ref.current, personId, cx(), why)
      return commit(r.doc, r.rows)
    },
    setStatus(bereichId: string, status: SucheBereichStatus, trupp?: { label?: string; id?: string }, note?: string) {
      const r = setBereichStatus(ref.current, bereichId, status, trupp, cx(), note)
      return commit(r.doc, r.rows)
    },
    /** the tick circle: abgesucht, or back to offen */
    toggleAbgesucht(bereichId: string) {
      const r = toggleAbgesucht(ref.current, bereichId, cx())
      return commit(r.doc, r.rows)
    },
    fund(bereichId: string) {
      const r = markFund(ref.current, bereichId, cx())
      return commit(r.doc, r.rows)
    },
    rename(bereichId: string, name: string) {
      const r = renameBereich(ref.current, bereichId, name, cx())
      return commit(r.doc, r.rows)
    },
    /** «＋ Bereich (Name)» and, optionally, who searches it: finds the place by name, else creates
     *  it. Returns its id — `null` only for an empty name. */
    addBereich(input: { name: string; trupp?: { label: string; id?: string }; point?: SuchePoint }): string | null {
      const r = addBereich(ref.current, input, cx())
      if (r.doc !== ref.current) commit(r.doc, r.rows)
      return r.id
    },
    /** put a place or a person on the Karte / a plan, move it, or take it off (null) */
    setPoint(kind: 'bereiche' | 'personen', id: string, point: SuchePoint | null) {
      const r = setPlacePoint(ref.current, kind, id, point, cx())
      return commit(r.doc, r.rows)
    },
    /**
     * What every device OBSERVES about a Trupp (its Ziel under «Absuchen»), written under DERIVED
     * ids (AGENTS.md · «recorded under a derived id, once»): the part a typed name creates and the
     * «in Arbeit · Trupp 4» row get ids every device computes identically from `key`, so two
     * editors reacting to the same Trupp save converge on one record and one Verlauf row. Not a
     * step on the undo timeline — the Trupp's own save is the act. `fn` is handed the writer's
     * LATEST doc (the place the same save just created included).
     */
    observe(key: string, fn: (doc: SucheDoc, cx: SucheCx) => { doc: SucheDoc; rows: SucheRow[] }) {
      if (!canEdit) return
      const derived: SucheCx = { at: serverNowIso(), newId: (p) => `${p}-${key}`, floorName }
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
