import { Component, type ErrorInfo, type ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { reportClientError } from '../lib/reportError'
import { isLooping, recordCrash, type CrashRecord } from '../lib/crashLoop'
import { recordTrouble } from '../lib/trouble'

// Guards the incident workspace: a render throw (malformed board anno, bad symbol SVG,
// unexpected hydrated workspace) would otherwise white-screen the kiosk mid-incident.
// We show a calm, recoverable fallback and NEVER clear localStorage — the offline cache
// (unsynced edits) stays intact for the reload.
//
// «Neu laden» alone is NOT enough to be recoverable, though: boot auto-reopens the last
// incident, so if the throw comes from that incident's data, reloading lands right back on it
// and the operator has no way out (the landing list is the other arm of App's ternary, and the
// only cache-clearing UI is behind /admin). The per-incident mount therefore also passes escape
// actions, escalating with the crash count (see lib/crashLoop):
//   1st crash  → reload, or close the incident and land on the launcher (loses nothing).
//   2nd+ crash → additionally discard this incident's local cached copy and re-pull from the
//                server. Destructive (unsynced edits go), so it stays hidden until reopening
//                has demonstrably already failed once.
interface Props {
  children: ReactNode
  /** incident id this boundary guards, for per-incident crash counting. Omit at the root. */
  scopeId?: string
  /** lossless escape: leave the incident and land on the launcher. */
  onCloseIncident?: () => void
  /** destructive escape: drop the locally cached workspace and re-pull from the server. */
  onDiscardLocal?: () => void
}
interface State {
  error: Error | null
  crash: CrashRecord | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, crash: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface for debugging; do not touch persisted state.
    console.error('ErrorBoundary caught:', error, info.componentStack)
    // Also report to the server log so a field crash isn't invisible to the deployer.
    reportClientError(error, { kind: 'render', componentStack: info.componentStack ?? undefined })
    // Count it (survives the reload) so a second crash on the same incident can escalate.
    const crash = recordCrash(this.props.scopeId ?? '')
    // Remember it for the Rückmeldung prompt too: the server log gets the stack, but only the
    // operator can say what they were doing. Asked later, on the launcher — never here.
    recordTrouble(isLooping(crash, this.props.scopeId ?? '', Date.now()) ? 'crashLoop' : 'crash')
    this.setState({ crash })
  }

  render() {
    if (!this.state.error) return this.props.children
    const eb = appConfig.copy.errorBoundary
    const { scopeId, onCloseIncident, onDiscardLocal } = this.props
    // Reopening this incident has already failed once → offer the destructive path too.
    const looping = isLooping(this.state.crash, scopeId ?? '', Date.now())
    return (
      <div className="login" role="alert">
        <div className="login-card eb-card">
          <div className="login-name" style={{ fontSize: 18 }}>{eb.title}</div>
          <p className="eb-body">{looping ? eb.bodyRepeat : eb.body}</p>
          <div className="eb-actions">
            {/* On a repeat crash, reloading is the action that demonstrably does NOT work — so
                closing the incident becomes the primary and reload steps back to secondary. */}
            <button
              type="button"
              className={`ip-btn${looping ? '' : ' primary'}`}
              onClick={() => location.reload()}
            >
              {eb.reload}
            </button>
            {onCloseIncident && (
              <button
                type="button"
                className={`ip-btn${looping ? ' primary' : ''}`}
                onClick={onCloseIncident}
              >
                {eb.closeIncident}
              </button>
            )}
            {looping && onDiscardLocal && (
              <button type="button" className="ip-btn ip-btn-danger" onClick={onDiscardLocal}>
                {eb.discardLocal}
              </button>
            )}
          </div>
          {looping && onDiscardLocal && <p className="eb-warn">{eb.discardLocalHint}</p>}
        </div>
      </div>
    )
  }
}
