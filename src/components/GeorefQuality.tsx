/** «Passung» — the read-out that makes a georeference CHECKABLE.
 *
 *  A georeferenced plan quietly moves every symbol on it somewhere else. Without a way to ask
 *  «how well does this actually sit», the link is a claim; with one it is a measurement.
 *
 *  ⚠️ ONE line about the quality, and the panel never rounds a doubt away: two pairs solve
 *  exactly and therefore report NO residual at all (georef · residualClaim), which is the one
 *  number this surface refuses to invent.
 *
 *  ⚠️ …and one line is ALL of it. This panel used to also print the sheet width against the
 *  printed Massstab, the rotation to two decimals, and a per-point list of residuals with how
 *  each point came to be («1 gesetzt 1.0 m»). Every one of those was computable, none of them
 *  was read: mid-Einsatz the only questions are «how many pairs» and «how far off», and the
 *  answer to «which point is the bad one» is to look at the crosses on the sheet, not at a
 *  table. What survives is what somebody acts on — plus the warnings, which say what to DO.
 */
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { confirmDialog } from '../lib/ui'
import { georefWarnings, type GeorefWarning } from '../lib/georefMode'
import { residualClaim, type GeorefFit } from '../lib/georef'
import s from './GeorefMode.module.css'

/** Metres, at the precision the number deserves: under 10 m one decimal, above it none. */
const m = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)))

function warningText(w: GeorefWarning, fit: GeorefFit): string {
  const C = appConfig.copy.whiteboard.georef
  if (w === 'twoPoints') return C.warnTwoPoints
  if (w === 'collinear') return C.warnCollinear
  return fillTemplate(C.warnBaseline, { m: m(fit.baselineM) })
}

/**
 * The popover body. The chip owns the trigger; this owns nothing but the reading and the two
 * actions that follow from it — set another point, or throw the reference away.
 */
export function GeorefQuality({ fit, onClose, onAddPoint, onCheck, onTransfer, onReset }: {
  fit: GeorefFit
  /** «Dritten Punkt setzen» / «Punkte hinzufügen» — re-arms the pairing mode */
  onAddPoint: () => void
  /** «Deckung prüfen» — the sheet's outline on the map, side by side (lib/georefMode · check) */
  onCheck: () => void
  /** Copies this fit to one of the object's other Modul sheets. Hidden when none exist. */
  onTransfer?: () => void
  /** «Referenz zurücksetzen», already confirmed */
  onReset: () => void
  /** the dock's own ✕ — this panel is not dismissed by pressing outside it (that press belongs
   *  to the board underneath), so it needs a visible way out */
  onClose: () => void
}) {
  const C = appConfig.copy.whiteboard.georef
  // the claimable residual, or null at two pairs — where the honest reading is «aus 2 Punkten»
  const claim = residualClaim(fit)
  // ⚠️ ONE warning, never a stack of them. Two amber boxes under a two-line panel is a wall,
  // and the operator acts on one thing at a time. Order by what can actually be DONE about it:
  // a bad spread or a short baseline is fixed by where the next point goes, while «two pairs
  // solve exactly» is already stated by the line above — so it only speaks when alone.
  const raised = georefWarnings(fit)
  const warning = (['collinear', 'baseline', 'twoPoints'] as const).find((w) => raised.includes(w))

  const reset = async () => {
    const ok = await confirmDialog({
      title: C.resetTitle,
      message: C.resetBody,
      confirmLabel: C.reset,
      cancelLabel: C.cancel,
      danger: true,
    })
    if (ok) onReset()
  }

  return (
    <div className={s.quality}>
      <div className={s.qHead}>
        <span>{C.qualityTitle}</span>
        <button className={s.qX} onClick={onClose} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>
      <div className={s.qSummary}>
        <span><b>{fit.n}</b> {C.pairs}</span>
        <strong>{claim == null ? C.chipTwoPoints : fillTemplate(C.qualityDeviation, { m: m(claim) })}</strong>
      </div>
      {warning && <div className={s.qWarn}><Icon id="warn" />{warningText(warning, fit)}</div>}
      <div className={`${s.qActions} ${onTransfer ? s.qActionsFour : ''}`}>
        {/* ⚠️ This action always ADDS a point; it does not pick up the pair with the largest
            residual. Calling it «Punkt 2 korrigieren» made the result depend on a calculation the
            operator could neither see nor choose. A plus icon and an adding verb say what happens. */}
        <button className="btn primary" onClick={onAddPoint}>
          <Icon id="plus" />
          {fit.n < 3 ? C.addThird : C.addMore}
        </button>
        {/* the eye is the last arbiter: a residual of half a metre still says nothing about
            whether THIS corner sits on THAT corner. Opens the split with the sheet's outline
            drawn on the map (lib/georefMode · check). */}
        <button className="btn" onClick={onCheck}><Icon id="eye" />{C.checkFit}</button>
        {onTransfer && <button className={`btn ${s.transferAction}`} onClick={onTransfer}><Icon id="copy" />{C.transfer}</button>}
        <button className="btn warn" onClick={() => void reset()}><Icon id="trash" />{C.reset}</button>
      </div>
    </div>
  )
}
