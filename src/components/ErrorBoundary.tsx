import { Component, type ErrorInfo, type ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { reportClientError } from '../lib/reportError'

// Guards the incident workspace: a render throw (malformed board anno, bad symbol SVG,
// unexpected hydrated workspace) would otherwise white-screen the kiosk mid-incident.
// We show a calm, recoverable fallback and NEVER clear localStorage — the offline cache
// (unsynced edits) stays intact for the reload.
interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface for debugging; do not touch persisted state.
    console.error('ErrorBoundary caught:', error, info.componentStack)
    // Also report to the server log so a field crash isn't invisible to the deployer.
    reportClientError(error, { kind: 'render', componentStack: info.componentStack ?? undefined })
  }

  render() {
    if (!this.state.error) return this.props.children
    const eb = appConfig.copy.errorBoundary
    return (
      <div className="login" role="alert">
        <div className="login-card" style={{ textAlign: 'center', gap: 16 }}>
          <div className="login-name" style={{ fontSize: 18 }}>{eb.title}</div>
          <p style={{ margin: 0, color: 'var(--ink-dim)', fontSize: 14, lineHeight: 1.45 }}>
            {eb.body}
          </p>
          <button
            type="button"
            className="ip-btn primary"
            style={{ alignSelf: 'center' }}
            onClick={() => location.reload()}
          >
            {eb.reload}
          </button>
        </div>
      </div>
    )
  }
}
