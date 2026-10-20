import { useRef } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { Button, IconButton } from './Button'
import { Chip } from './Chip'
import { Stepper } from './Stepper'
import { Overlay } from '../lib/overlays'
import { toast } from '../lib/ui'
import { saveStationDefault, saveStationPlanOverride } from '../lib/stationPlanScale'
import type { PlanScale } from '../lib/planScale'

/**
 * The two surfaces of the Plan-Maßstab flow, split out of Whiteboard so the state (usePlanMeasure)
 * and its UI sit next to each other rather than 1'800 lines apart. Both are rendered by the board
 * in the same slots as before — the order matters, they are stacked overlays.
 */

/** the longest reference the Stepper offers – a plan's scale bar, not a road atlas */
const REF_M_MAX = 10_000

/** Metre entry after the two reference endpoints have been tapped: the common scale-bar lengths as
 *  chips, and the shared `Stepper` for any other (20.10.2026, UX sweep M3 – it was a native
 *  number field between two hand-made ± buttons). Tap the value to type it; it keeps one decimal,
 *  because a reference read off a drawing is often «12.5 m». */
export function PlanScalePrompt({ refMInput, setRefMInput, onCommit, onClose }: {
  refMInput: string
  setRefMInput: (v: string) => void
  onCommit: (refM: number) => void
  onClose: () => void
}) {
  const C = appConfig.copy.whiteboard.scale
  const val = parseFloat(refMInput) || 0
  // the length is prefilled (the last reference), so the answer is usually one press: focus
  // lands on «Übernehmen», not on the first quick-pick chip (Base UI's first-focusable default)
  const confirmRef = useRef<HTMLButtonElement>(null)
  return (
    // ⚠️ Modal, so it goes through lib/overlays like every other modal surface — focus trap +
    // restore, scroll-lock, Esc and backdrop dismissal live there. The old hand-rolled
    // scrim + card had none of them, and the board's own Escape handler fired UNDERNEATH it,
    // clearing the selection behind a dialog that stayed open. (The AGENTS.md carve-out for
    // hand-rolled overlays covers the NON-modal tool docks, not this.)
    <Overlay open onClose={onClose} className="wb-cal-pop ui-dialog" ariaLabel={C.promptTitle} initialFocus={confirmRef}>
      <div className="wb-cal-title">{C.promptTitle}</div>
      <div className="wb-cal-body">{C.promptBody}</div>
      <div className="wb-cal-chips">
        {appConfig.drawing.planScaleDefaultsM.map((m) => (
          <Chip key={m} className="wb-cal-chip" selected={val === m} onClick={() => setRefMInput(String(m))}>{m} m</Chip>
        ))}
      </div>
      <div className="wb-cal-stepper">
        <Stepper value={val > 0 ? val : null} min={0} max={REF_M_MAX} step={appConfig.drawing.planScaleStepM} snap decimals={1}
          seed={appConfig.drawing.planScaleDefaultM}
          format={(m) => `${m} ${C.unit}`} ariaLabel={C.promptTitle}
          onChange={(m) => setRefMInput(String(m))} />
      </div>
      <div className="wb-cal-actions">
        <Button onClick={onClose}>{C.cancel}</Button>
        <Button ref={confirmRef} variant="primary" disabled={!(val > 0)} onClick={() => onCommit(val)}>{C.confirm}</Button>
      </div>
    </Overlay>
  )
}

/**
 * #3: persist a fresh calibration station-wide so plans measure out of the box next time.
 *
 * ⚠️ This writes the STATION document, not the incident — over the network, to an endpoint that
 * refuses a stale write (backend app/api/plan_scales.py). Both buttons used to announce success
 * synchronously and drop the rejection on the floor: the operator was told «Als Standard-Massstab
 * gespeichert» while nothing of the sort had happened, and offline the claim was simply false. So
 * the save is awaited and its outcome reported, exactly as the Georeferenz's own writer does
 * (Whiteboard · setGeorefSaveErrorHandler). The prompt still closes at once — the operator has
 * answered its question, and a dialog that waits for the network is a dialog in the way.
 */
function persisting(save: Promise<void>, ok: string, onDone: () => void): void {
  const C = appConfig.copy.whiteboard.scale
  void save.then(() => toast(ok)).catch(() => toast(C.saveFailed, { icon: 'warn', tone: 'warn' }))
  onDone()
}

export function PlanScalePersist({ scale, activeId, onDone }: {
  scale: PlanScale
  activeId: string
  onDone: () => void
}) {
  return (
    <div className="wb-scale-persist" role="group" aria-label={appConfig.copy.whiteboard.scale.persistTitle}>
      <span className="wb-scale-persist-t">{appConfig.copy.whiteboard.scale.persistTitle}</span>
      <button className="btn" onClick={() => persisting(saveStationDefault(scale), appConfig.copy.whiteboard.scale.savedAll, onDone)}>
        {appConfig.copy.whiteboard.scale.saveAll}
      </button>
      <button className="btn" onClick={() => persisting(saveStationPlanOverride(activeId, scale), appConfig.copy.whiteboard.scale.savedThis, onDone)}>
        {appConfig.copy.whiteboard.scale.saveThis}
      </button>
      <IconButton className="wb-scale-persist-x" label={appConfig.copy.closeDialog} onClick={onDone}><Icon id="close" /></IconButton>
    </div>
  )
}
