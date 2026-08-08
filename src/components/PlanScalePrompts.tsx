import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { toast } from '../lib/ui'
import { saveStationDefault, saveStationPlanOverride } from '../lib/stationPlanScale'
import type { PlanScale } from '../lib/planScale'

/**
 * The two surfaces of the Plan-Maßstab flow, split out of Whiteboard so the state (usePlanMeasure)
 * and its UI sit next to each other rather than 1'800 lines apart. Both are rendered by the board
 * in the same slots as before — the order matters, they are stacked overlays.
 */

/** Metre entry after the two reference endpoints have been tapped. */
export function PlanScalePrompt({ refMInput, setRefMInput, onCommit, onClose }: {
  refMInput: string
  setRefMInput: (v: string) => void
  onCommit: (refM: number) => void
  onClose: () => void
}) {
  const step = appConfig.drawing.planScaleStepM
  const val = parseFloat(refMInput) || 0
  const bump = (d: number) => setRefMInput(String(Math.max(0, Math.round((val + d) * 100) / 100)))
  return (
    <div className="wb-trupp-scrim" onPointerDown={onClose}>
      <div className="wb-cal-pop" onPointerDown={(e) => e.stopPropagation()}>
        <div className="wb-cal-title">{appConfig.copy.whiteboard.scale.promptTitle}</div>
        <div className="wb-cal-body">{appConfig.copy.whiteboard.scale.promptBody}</div>
        <div className="wb-cal-chips">
          {appConfig.drawing.planScaleDefaultsM.map((m) => (
            <button key={m} className={`wb-cal-chip ${val === m ? 'on' : ''}`} onClick={() => setRefMInput(String(m))}>{m} m</button>
          ))}
        </div>
        <div className="wb-cal-stepper">
          <button className="wb-cal-step" aria-label="−" disabled={val <= 0} onClick={() => bump(-step)}>−</button>
          <div className="wb-cal-num">
            <input className="wb-cal-input" type="number" inputMode="decimal" min={0} step="any" autoFocus value={refMInput}
              onChange={(e) => setRefMInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onCommit(val) }} />
            <span className="wb-cal-unit">{appConfig.copy.whiteboard.scale.unit}</span>
          </div>
          <button className="wb-cal-step" aria-label="+" onClick={() => bump(step)}>+</button>
        </div>
        <div className="wb-cal-actions">
          <button className="ip-btn ghost" onClick={onClose}>{appConfig.copy.whiteboard.scale.cancel}</button>
          <button className="btn primary" disabled={!(val > 0)} onClick={() => onCommit(val)}>{appConfig.copy.whiteboard.scale.confirm}</button>
        </div>
      </div>
    </div>
  )
}

/** #3: persist a fresh calibration station-wide so plans measure out of the box next time. */
export function PlanScalePersist({ scale, activeId, onDone }: {
  scale: PlanScale
  activeId: string
  onDone: () => void
}) {
  return (
    <div className="wb-scale-persist" role="group" aria-label={appConfig.copy.whiteboard.scale.persistTitle}>
      <span className="wb-scale-persist-t">{appConfig.copy.whiteboard.scale.persistTitle}</span>
      <button className="btn" onClick={() => { void saveStationDefault(scale); toast(appConfig.copy.whiteboard.scale.savedAll); onDone() }}>
        {appConfig.copy.whiteboard.scale.saveAll}
      </button>
      <button className="btn" onClick={() => { void saveStationPlanOverride(activeId, scale); toast(appConfig.copy.whiteboard.scale.savedThis); onDone() }}>
        {appConfig.copy.whiteboard.scale.saveThis}
      </button>
      <button className="wb-scale-persist-x" aria-label={appConfig.copy.closeDialog} onClick={onDone}><Icon id="close" /></button>
    </div>
  )
}
