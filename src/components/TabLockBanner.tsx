import { appConfig } from '../config/appConfig'
import { useMeldung } from '../lib/useMeldung'

// Published when ANOTHER tab of this browser is editing this incident: this tab is read-only so
// the two can't race the shared sync cache (cross-device editing is unaffected — that's what the
// server merge is for). One tap moves editing here and drops the other tab to read-only — the
// row answers "why can't I draw?" where the operator is looking, recognition over recall.
export function TabLockBanner({ onTakeOver }: { onTakeOver: () => void }) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.tabLock
  useMeldung({
    id: 'tabLock',
    kind: 'tabLock',
    tone: 'info',
    icon: 'info',
    title: C.title,
    sub: C.hint,
    actions: [{ label: C.takeOver, primary: true, onClick: onTakeOver }],
  })
  return null
}
