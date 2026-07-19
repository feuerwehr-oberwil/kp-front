import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

// Shown when ANOTHER tab of this browser is editing this incident: this tab is read-only so
// the two can't race the shared sync cache (cross-device editing is unaffected — that's what
// the server merge is for). One tap moves editing here and drops the other tab to read-only —
// the banner answers "why can't I draw?" in place, recognition over recall.
export function TabLockBanner({ onTakeOver }: { onTakeOver: () => void }) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.tabLock
  return (
    <div className="update-banner" role="status">
      <Icon id="info" />
      <div className="ub-text">
        <span className="ub-title">{C.title}</span>
        <span className="ub-hint">{C.hint}</span>
      </div>
      <button className="ub-btn ub-reload" onClick={onTakeOver}>{C.takeOver}</button>
    </div>
  )
}
