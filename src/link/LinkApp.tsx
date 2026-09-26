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
import { LINK_CLOSED_FOLLOW_MS, exchangeLinkToken, openIncidentLink, type LinkFailure } from '../lib/incidentLink'
import { fillTemplate, hhmm } from '../lib/format'
import { TERMINAL_PATH, linkKindFromToken, linkTokenFromPath } from '../lib/linkMode'
import StandingApp from './StandingApp'

type State =
  | { phase: 'opening' }
  /** the incident isn't in kp-front yet — the exchange is retrying behind this screen */
  | { phase: 'pending' }
  | { phase: 'ok' }
  | { phase: 'failed'; reason: LinkFailure; closedAt?: string | null }

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
    closed: { title: C.closedTitle, hint: C.closedHint, canRetry: false }, // rendered by ClosedCard
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

/** The Einsatz this link belongs to is CLOSED (staging r6, F2). Not a failure to act on — a state
 *  to wait out: the page asks again once a minute and whenever the phone comes back to it
 *  (LinkBoot), so «Wieder öffnen» brings the board back without anyone tapping anything. Until
 *  then it says when it was closed, and nothing here invites a retry. */
function ClosedCard({ closedAt }: { closedAt?: string | null }) {
  const C = appConfig.copy.incidentLink
  const at = closedAt ? new Date(closedAt) : null
  return (
    <div className="cv-shell">
      <IconSprite />
      <div className="cv-card cv-center" role="status" data-link-closed>
        <Icon id="lock" />
        <p>{C.closedTitle}</p>
        {at && Number.isFinite(at.getTime()) && <p className="cv-hint">{fillTemplate(C.closedAt, { time: hhmm(at) })}</p>}
        <p className="cv-hint">{C.closedHint}</p>
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
      .then((r) => { if (alive) setState(r.ok ? { phase: 'ok' } : { phase: 'failed', reason: r.reason, closedAt: r.closedAt }) })
    return () => { alive = false }
  }, [token, attempt])

  const retry = () => { setState({ phase: 'opening' }); setAttempt((n) => n + 1) }

  // ⚠️ A CLOSED Einsatz is FOLLOWED, not given up on (staging r6, F2). The Atemschutz page
  // reloaded after the close used to land on «eben erst eingetroffen» → «nicht abrufbar» and
  // stay there after «Wieder öffnen» until somebody tapped «Erneut versuchen». Once a minute —
  // and at once when the phone is looked at again — the exchange is asked quietly; a reopen
  // opens the board, anything else (no signal, still closed) keeps the card as it is.
  const following = state.phase === 'failed' && state.reason === 'closed'
  useEffect(() => {
    if (!following) return
    let alive = true
    const ask = () => {
      void exchangeLinkToken(token).then((r) => {
        if (!alive) return
        if (r.ok) setState({ phase: 'ok' })
        else if (r.reason === 'closed') setState({ phase: 'failed', reason: 'closed', closedAt: r.closedAt })
      })
    }
    const timer = window.setInterval(ask, LINK_CLOSED_FOLLOW_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') ask() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', ask)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', ask)
    }
  }, [following, token])

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

  if (state.reason === 'closed') return <ClosedCard closedAt={state.closedAt} />
  return <LinkMessage reason={state.reason} onRetry={retry} />
}

export default function LinkApp() {
  // The enrolled Stations-Terminal has no token in its address — its credential is the
  // device cookie the enrollment left behind (link/StandingApp).
  if (window.location.pathname === TERMINAL_PATH) return <StandingApp token={null} />
  // A path that isn't a link URL at all is answerable without state or a round trip.
  const token = linkTokenFromPath(window.location.pathname)
  if (!token) return <LinkMessage reason="invalid" onRetry={() => window.location.reload()} />
  // The standing kinds (terminal enrollment, fixe Atemschutz-URL) resolve «whichever Einsatz
  // is open» and own their whole lifecycle — idle screen, chooser, poll — in StandingApp.
  const kind = linkKindFromToken(token)
  if (kind === 'terminal' || kind === 'atemschutz-standing') return <StandingApp token={token} />
  return <LinkBoot token={token} />
}
