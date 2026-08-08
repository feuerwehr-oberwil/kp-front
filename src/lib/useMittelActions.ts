import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from './deploymentConfig'
import { fillTemplate } from './format'
import { toast } from './ui'
import { currentLineFor, currentMengeFor, materialForSymbol, mittelKey } from './mittel'
import type { MittelDraft } from '../components/MittelView'
import type { MittelEntry, TimelineEvent } from '../types'

/** How long a Mittel count has to sit still before it earns its Verlauf line. One ±burst is
 *  one act of recording, not one act per tap. */
const COUNT_SETTLE_MS = 3000

interface MittelActionsDeps {
  mittel: MittelEntry[]
  setMittel: Dispatch<SetStateAction<MittelEntry[]>>
  /** author snapshot stamped on a saved line (user?.display_name). */
  authorName: string | undefined
  log: (icon: string, text: string, kind?: TimelineEvent['kind']) => void
}

/**
 * Mittel (material-use) domain actions, lifted out of the IncidentWorkspace god-component. The
 * log is append-only: every change is a NEW event carrying the running total; the current
 * picture is derived (lib/mittel). Owns its own `mittelRef` mirror so the symbol-capture toast
 * action (which outlives its render) always reads the fresh log.
 */
export function useMittelActions({ mittel, setMittel, authorName, log }: MittelActionsDeps) {
  const M = appConfig.copy.mittel // read per-render so the boot-resolved locale applies
  const mittelRef = useRef(mittel)
  useEffect(() => { mittelRef.current = mittel }, [mittel])

  // Save a Mittel (material-use) total. Append-only: every change is a NEW event carrying the
  // running total for its material+unit+source key; the current picture is derived (lib/mittel).
  // Re-saving the same value is a no-op (no event, no Verlauf row). Setting menge to 0 keeps the
  // history but hides the line. Mirrors the Anwesenheit log pattern. Draft `status` semantics:
  // value sets, null clears, omitted keeps the current one.
  const saveMittel = (d: MittelDraft) => {
    const label = d.label.trim()
    const unit = d.unit.trim()
    if (!label || !unit) return
    const sourceLabel = d.sourceLabel?.trim() || undefined
    const menge = Math.max(0, Math.round(d.menge))
    const probe = { materialId: d.materialId, label, unit, sourceId: d.sourceId, sourceLabel }
    const cur = currentLineFor(mittelRef.current, probe)
    // the remark follows `status`'s old semantics: a value sets, null clears, omitted keeps —
    // so editing a quantity never wipes a remark, and a remark can be written without touching
    // the quantity (which is the common case: the material was logged, the note comes later)
    const note = d.note === undefined ? cur?.note : (d.note?.trim() || undefined)
    // `stock` follows the same value/null/omitted contract as `note`: a hand-added line can be
    // given a Bestand later without touching its count, and a count change never drops it.
    const stock = d.stock === undefined ? cur?.stock : (d.stock === null ? undefined : Math.max(0, Math.round(d.stock)))
    const deleted = d.deleted || undefined
    const unchanged = (cur?.menge ?? 0) === menge && note === cur?.note && stock === cur?.stock && !deleted
    if (unchanged) return // → no event, no Verlauf row
    // (Retablierung status retired 2026-07-14 — old entries keep their stored status,
    // new events simply don't carry one; cleanup/defects live outside the system.)
    const at = new Date().toISOString()
    setMittel((c) => [...c, { id: `m${Date.now()}-${c.length}`, ...probe, menge, note, stock, deleted, at, by: authorName || undefined }])
    const where = sourceLabel ? ` · ${sourceLabel}` : ''
    // An explicit removal is its own sentence — «auf 0 gesetzt» and «gelöscht» stopped being the
    // same act the moment a zeroed line started surviving on the sheet. It is also the one case
    // that must NOT wait: a deletion is a decision, not a count being dialled in.
    if (deleted) { flushLogFor(mittelKey(probe)); log('box', fillTemplate(M.logDeleted, { label }) + where, 'team'); return }
    if ((cur?.menge ?? 0) === menge && note !== cur?.note) { log('box', fillTemplate(M.logNote, { label, note: note ?? '–' }) + where, 'team'); return }
    if ((cur?.menge ?? 0) === menge) { log('box', fillTemplate(M.logStock, { label, stock: stock ?? '–' }) + where, 'team'); return }
    // A COUNT settles before it is logged. «Ölbinder: 3 Sack» typed with the ±stepper is five
    // taps, and it used to be five Verlauf rows — the material is already listed with its total
    // in the Mittel section, so the log's job is to say when it was recorded, once.
    scheduleCountLog(probe, `${where}`, unit)
  }

  /** Pending «this count is still being dialled in» writers, one per material line. Each entry
   *  keeps its timer AND the closure that writes the row, so the row can be forced out early. */
  const countLogs = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; write: () => void }>())
  /** Write a pending count row NOW — a deletion supersedes it, and so does leaving the incident. */
  const flushLogFor = (key: string) => {
    const p = countLogs.current.get(key)
    if (!p) return
    clearTimeout(p.timer)
    countLogs.current.delete(key)
    p.write()
  }
  const scheduleCountLog = (probe: Parameters<typeof currentLineFor>[1], where: string, unit: string) => {
    const key = mittelKey(probe)
    const pending = countLogs.current.get(key)
    if (pending) clearTimeout(pending.timer)
    const write = () => {
      // read the FINAL value off the live log, not the one captured when the burst started
      const menge = currentLineFor(mittelRef.current, probe)?.menge ?? 0
      const label = probe.label
      log('box', menge === 0
        ? fillTemplate(M.logRemoved, { label }) + where
        : fillTemplate(M.logSet, { label, menge, unit }) + where, 'team')
    }
    const timer = setTimeout(() => { countLogs.current.delete(key); write() }, COUNT_SETTLE_MS)
    countLogs.current.set(key, { timer, write })
  }
  // Leaving the incident FORCES the pending rows out rather than dropping them — a Verlauf that
  // silently loses the last thing recorded is worse than one written a moment early.
  useEffect(() => {
    const pending = countLogs.current
    return () => {
      for (const [, p] of pending) { clearTimeout(p.timer); p.write() }
      pending.clear()
    }
  }, [])

  // Symbol→Mittel capture: placing a matching tactical symbol (Lage or Plan) offers logging the
  // material with one tap — never automatic, and deleting a symbol never decrements (symbols are
  // freely redrawn; the log stays the operator's record).
  const offerMittelCapture = (symbolName: string) => {
    const cfgM = getDeploymentConfig().mittel
    const item = materialForSymbol(cfgM?.catalogue ?? appConfig.mittel.catalogue, symbolName)
    if (!item) return
    const unit = item.unit || appConfig.mittel.defaultUnit
    toast(fillTemplate(M.captureOffer, { label: item.label }), {
      icon: 'box',
      action: {
        label: M.captureAction,
        onClick: () => {
          const menge = currentMengeFor(mittelRef.current, { materialId: item.id, label: item.label, unit }) + 1
          saveMittel({ materialId: item.id, label: item.label, unit, menge })
          toast(fillTemplate(M.captured, { label: item.label, menge, unit }), { icon: 'check', tone: 'success' })
        },
      },
    })
  }
  return { saveMittel, offerMittelCapture }
}
