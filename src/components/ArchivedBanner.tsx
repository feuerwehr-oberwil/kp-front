import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

// Shown the whole time an ARCHIVED incident is open (the read-only view from «Alle
// Einsätze»): it names the state — the missing tools are policy, not a bug — and carries
// the two deliberate exits: «Zurück» (everyone — back to the previously active incident /
// the Alle-Einsätze list) and, for editors, Reaktivieren behind its own confirm (edits
// after reactivation are appended as Nachträge; a completed Rapport flips to «geändert
// nach Abschluss»).
export function ArchivedBanner({ onBack, onReactivate }: { onBack?: () => void; onReactivate?: () => void }) {
  const C = appConfig.copy.archived
  return (
    <div className="update-banner archived-banner" role="status">
      <Icon id="lock" />
      <div className="ub-text">
        <span className="ub-title">{C.title}</span>
        <span className="ub-hint">{C.hint}</span>
      </div>
      {onBack && <button className="ub-btn" onClick={onBack}><Icon id="undo" /> {C.back}</button>}
      {onReactivate && <button className="ub-btn ub-reload" onClick={onReactivate}>{C.reactivate}</button>}
    </div>
  )
}
