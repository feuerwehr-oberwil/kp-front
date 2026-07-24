import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from './deploymentConfig'
import { fillTemplate } from './format'
import { toast } from './ui'
import { currentLineFor, currentMengeFor, materialForSymbol } from './mittel'
import type { MittelDraft } from '../components/MittelView'
import type { MittelEntry, TimelineEvent } from '../types'

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
    if ((cur?.menge ?? 0) === menge) return // unchanged → no-op
    // (Retablierung status retired 2026-07-14 — old entries keep their stored status,
    // new events simply don't carry one; cleanup/defects live outside the system.)
    const at = new Date().toISOString()
    setMittel((c) => [...c, { id: `m${Date.now()}-${c.length}`, ...probe, menge, at, by: authorName || undefined }])
    const where = sourceLabel ? ` · ${sourceLabel}` : ''
    if (menge === 0) log('box', fillTemplate(M.logRemoved, { label }) + where, 'team')
    else log('box', fillTemplate(M.logSet, { label, menge, unit }) + where, 'team')
  }
  // Symbol→Mittel capture: placing a matching tactical symbol (Lage or Plan) offers logging the
  // material with one tap — never automatic, and deleting a symbol never decrements (symbols are
  // freely redrawn; the log stays the operator's record).
  const offerMittelCapture = (symbolName: string) => {
    const cfgM = getDeploymentConfig().mittel
    const item = materialForSymbol(cfgM?.catalogue ?? appConfig.mittel.catalogue, symbolName)
    if (!item) return
    const unit = item.unit || 'Stk'
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
