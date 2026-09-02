// Einsatz-Link view (/l/<token>) — what a responder opens from the alert on a personal phone:
// no login, ONE incident, read-only. Unlike the capture poster (/e/), this is not a separate
// surface: after the token exchange it mounts the normal field app, which the backend has
// already narrowed to that one incident (backend/app/auth/incident_link.py) and whose own
// affordances hide anything a link session may not do (App / IncidentWorkspace · linkScoped).
//
// So this file is only the door, and the door has to be legible at 3am: one branded splash
// while the exchange runs, a named "noch nicht verfügbar" state for the one failure that may
// resolve itself, and otherwise a single calm card that says what to do next. Which state we
// are in is decided in lib/incidentLink.ts — this renders it.

import { useEffect, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon, IconSprite } from '../lib/icons'
import { Splash } from '../components/Splash'
import { AuthProvider, useAuth } from '../lib/auth'
import App from '../App'
import { linkTokenFromPath, openIncidentLink, type LinkFailure } from '../lib/incidentLink'

type State =
  | { phase: 'opening' }
  /** the incident isn't in kp-front yet — the exchange is retrying behind this screen */
  | { phase: 'pending' }
  | { phase: 'ok' }
  | { phase: 'failed'; reason: LinkFailure }

/** One card, one instruction. Retry is offered only where waiting or tapping can change the
 *  answer — an expired link and a station that never enabled the feature will not fix
 *  themselves, and a button that keeps failing is worse than no button. */
function LinkMessage({ reason, onRetry }: { reason: LinkFailure; onRetry: () => void }) {
  const C = appConfig.copy.incidentLink // read here, not at module level (locale is set at boot)
  const said: Record<LinkFailure, { title: string; hint: string; canRetry: boolean }> = {
    notReady: { title: C.notReadyTitle, hint: C.notReadyHint, canRetry: true },
    invalid: { title: C.invalidTitle, hint: C.invalidHint, canRetry: false },
    disabled: { title: C.disabledTitle, hint: C.disabledHint, canRetry: false },
    offline: { title: C.offlineTitle, hint: C.offlineHint, canRetry: true },
    error: { title: C.errorTitle, hint: C.errorHint, canRetry: true },
  }
  const { title, hint, canRetry } = said[reason]
  return (
    <div className="cv-shell">
      <IconSprite />
      <div className="cv-card cv-center" role="alert">
        <Icon id="warn" />
        <p>{title}</p>
        <p className="cv-hint">{hint}</p>
        {canRetry && <button type="button" className="cv-btn" onClick={onRetry}>{C.retry}</button>}
      </div>
    </div>
  )
}

/** Session established: the normal app, gated on the /me probe that now returns the
 *  link-scoped viewer. A vanished session between exchange and probe reads as an expired
 *  link — the only honest thing left to say, and a reload is the way back. A probe that
 *  could not REACH the server is not that: link users are never cached (auth · USER_CACHE),
 *  so the phone that merely lost signal between the two requests lands here too, and it is
 *  told «Kein Empfang» — the same reload re-exchanges once it has signal again. */
function LinkSession() {
  const { user, loading, probeUnreachable } = useAuth()
  if (loading) return <Splash />
  if (!user) return <LinkMessage reason={probeUnreachable ? 'offline' : 'invalid'} onRetry={() => window.location.reload()} />
  return <App />
}

function LinkBoot({ token }: { token: string }) {
  const [state, setState] = useState<State>({ phase: 'opening' })
  const [attempt, setAttempt] = useState(0) // «Nochmals versuchen» re-runs the exchange

  useEffect(() => {
    let alive = true
    void openIncidentLink(token, { onPending: () => { if (alive) setState({ phase: 'pending' }) } })
      .then((r) => { if (alive) setState(r.ok ? { phase: 'ok' } : { phase: 'failed', reason: r.reason }) })
    return () => { alive = false }
  }, [token, attempt])

  const retry = () => { setState({ phase: 'opening' }); setAttempt((n) => n + 1) }

  // The AuthProvider mounts only AFTER the exchange: it probes /me once on mount, so mounting
  // it earlier would have it settle on "logged out" before the session cookie exists.
  if (state.phase === 'ok') return <AuthProvider><LinkSession /></AuthProvider>

  // Same branded splash as every other boot path, so tap → chunk → session reads as one launch.
  if (state.phase === 'opening') return <Splash />

  if (state.phase === 'pending') {
    const C = appConfig.copy.incidentLink
    return (
      <div className="cv-shell">
        <IconSprite />
        <div className="cv-card cv-center" role="status">
          <Icon id="rotate" className="spin" />
          <p>{C.pendingTitle}</p>
          <p className="cv-hint">{C.pendingHint}</p>
        </div>
      </div>
    )
  }

  return <LinkMessage reason={state.reason} onRetry={retry} />
}

export default function LinkApp() {
  // A path that isn't a link URL at all is answerable without state or a round trip.
  const token = linkTokenFromPath(window.location.pathname)
  return token
    ? <LinkBoot token={token} />
    : <LinkMessage reason="invalid" onRetry={() => window.location.reload()} />
}
