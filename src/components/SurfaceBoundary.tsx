import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { CRASH_WINDOW_MS } from '../lib/crashLoop'
import { reportClientError } from '../lib/reportError'
import { recordTrouble } from '../lib/trouble'

// One view's own fault line. Until 02.09. the incident had ONE boundary (ErrorBoundary, mounted
// per Einsatz in App), so a throw anywhere — a Mittel row without a label, a Verlauf text, a
// building without floors when the Kroki opened — took Karte, Kroki, Verlauf AND the Atemschutz
// alarm host down together. That last one is the reason this exists: the tone that says a Trupp
// is out of contact must not depend on the Mittel panel rendering.
//
// So every surface gets a boundary of its own, the card renders INSIDE the view (the rail, the
// top bar and the Meldeleiste stay live around it), and `AtemschutzAlarmHost` sits outside all of
// them. No crash-loop escalation here — the per-incident boundary remains the last line, and it
// still counts across reloads. What this boundary remembers is only whether THIS view has
// crashed twice within the window: then «Ansicht neu aufbauen» is demonstrably not the fix and
// steps back to secondary, and the hint points at the Rückmeldung.

/** per-surface crash timestamps, in memory only — a reload wipes them on purpose */
const crashes = new Map<string, number[]>()

/** Note a crash of `surface` and say whether it is a repeat inside the crash window. */
export function noteSurfaceCrash(surface: string, now: number = Date.now()): boolean {
  const recent = (crashes.get(surface) ?? []).filter((t) => now - t <= CRASH_WINDOW_MS)
  recent.push(now)
  crashes.set(surface, recent)
  return recent.length >= 2
}

/** Test-only: forget every surface's streak. */
export function __resetSurfaceCrashesForTests(): void {
  crashes.clear()
}

interface Props {
  /** which view this guards — keys the repeat counter (`map`, `board`, `journal`, `mittel`, …) */
  surface: string
  /** switch to the Karte. Omit when the crashed surface IS the map — the button would lead nowhere. */
  onToMap?: () => void
  children: ReactNode
}
interface State {
  error: Error | null
  /** this surface has crashed twice within the window */
  repeat: boolean
  /** bumped by «Ansicht neu aufbauen» — a new key remounts ONLY this subtree, never the page */
  generation: number
}

export class SurfaceBoundary extends Component<Props, State> {
  state: State = { error: null, repeat: false, generation: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`SurfaceBoundary(${this.props.surface}) caught:`, error, info.componentStack)
    // the same two reports the incident boundary files: the server log gets the stack, the
    // Rückmeldung prompt on the launcher gets the fact that something crashed
    reportClientError(error, { kind: 'render', componentStack: info.componentStack ?? undefined })
    recordTrouble('crash')
    this.setState({ repeat: noteSurfaceCrash(this.props.surface) })
  }

  retry = () => {
    this.setState((s) => ({ error: null, generation: s.generation + 1 }))
  }

  render() {
    const { generation, error, repeat } = this.state
    // a keyed fragment: bumping the key throws the whole subtree away and mounts it fresh
    if (!error) return <Fragment key={generation}>{this.props.children}</Fragment>
    const c = appConfig.copy.surfaceError
    return (
      <div className="sb-wrap" role="alert">
        <div className="login-card eb-card">
          <div className="login-name" style={{ fontSize: 18 }}>{c.title}</div>
          <p className="eb-body">{c.body}</p>
          <div className="eb-actions">
            {/* a repeat crash has shown that rebuilding does not help — it stays offered (the
                view may have crashed on data that has since synced away) but no longer leads */}
            <button type="button" className={`ip-btn${repeat ? '' : ' primary'}`} onClick={this.retry}>
              <Icon id="rotate" />{c.retry}
            </button>
            {this.props.onToMap && (
              <button type="button" className="ip-btn" onClick={this.props.onToMap}>
                <Icon id="map" />{c.toMap}
              </button>
            )}
          </div>
          {repeat && <p className="eb-warn">{c.repeatHint}</p>}
        </div>
      </div>
    )
  }
}
