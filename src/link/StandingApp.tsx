// Standing-link surfaces (2026-09-09): the Stations-Terminal (/terminal, enrolled via
// /l/t<secret>) and the fixe Atemschutz-URL (/l/s<secret>, the laminated QR).
//
// One state machine for both, because they share the whole lifecycle: exchange → «ok» mounts
// the normal app on the resolved Einsatz, «idle» is the calm kein-Einsatz screen, «choose»
// lists the open Einsätze when more than one runs. The SAME exchange runs on a timer for as
// long as the page lives — it is the boot, the poll and the recovery in one: the idle screen
// wakes up on an alarm, a closed Einsatz falls back to idle, a fresh session cookie rides
// every answer. That is what makes the terminal an unattended appliance: nobody at the PC
// ever has to tap anything (except the chooser, which only exists while >1 Einsatz runs).
//
// The terminal's enrollment is the one asymmetry: /l/t<secret> exchanges the secret ONCE (the
// backend leaves the long-lived device cookie behind), then rewrites the address to /terminal
// and lives on the cookie — the secret leaves the address bar, the bookmark, the history.

import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { deploymentName } from '../lib/deploymentConfig'
import { formatTime } from '../lib/format'
import { Icon, IconSprite } from '../lib/icons'
import { Splash } from '../components/Splash'
import { AuthProvider, useAuth } from '../lib/auth'
import App from '../App'
import { TERMINAL_PATH } from '../lib/linkMode'
import {
  STANDING_POLL_MS,
  exchangeStandingToken,
  exchangeTerminalSession,
  type StandingCandidate,
  type StandingExchange,
  type StandingFailure,
} from '../lib/standingLink'

type State =
  | { phase: 'opening' }
  | { phase: 'ok'; incidentId: string }
  | { phase: 'idle' }
  | { phase: 'choose'; candidates: StandingCandidate[] }
  | { phase: 'failed'; reason: StandingFailure }

/** Session established: the normal app, which the backend has narrowed to the resolved
 *  Einsatz. A vanished session is NOT an error state here — the poll outside owns liveness
 *  and will re-exchange or fall back to idle on its next tick — so this only ever waits. */
function StandingSession() {
  const { user, loading } = useAuth()
  if (loading || !user) return <Splash />
  return <App />
}

function Shell({ children, role = 'status' }: { children: React.ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div className="cv-shell">
      <IconSprite />
      <div className="cv-card cv-center" role={role}>{children}</div>
    </div>
  )
}

/* ══ THE WAITING SCREEN ═══════════════════════════════════════════════════════════════════════
 * «Bereitschaft» (Entwurf B, maintainer pick 09.09.). Both standing surfaces spend most of
 * their life in this state — a depot screen that is on all night, a laminated card that hangs
 * on the Überwachungstafel between Einsätze — so it is the state the design has to be good in,
 * not a placeholder between the interesting ones.
 *
 * Wortarm und bildhaft: one huge hairline glyph at ~5% opacity behind everything (the app's
 * OWN `station` / `gauge` symbols, not new artwork), and in front of it exactly one statement.
 * The resting state differs per surface, because the two devices are asked different things:
 *   · the TERMINAL is the Stationsuhr while it waits. A depot screen showing nothing all night
 *     is a screen wasted, and a clock is the one readout that is useful from across the room
 *     and needs no server.
 *   · the ATEMSCHUTZ card breathes — a slow 6s ring, never a blink. It is read from arm's
 *     length by somebody who has just scanned, and the one question they have is «lebt das?».
 * Both close with «Zuletzt geprüft HH:MM:SS», which is the honest answer to that question: the
 * timestamp of the last standing poll (STANDING_POLL_MS), handed down from the loop below.
 *
 * ⚠️ The clock ticks only on the terminal, and only to the next MINUTE — a station clock that
 * lags a whole 10s poll at the minute change is wrong in the one way a clock must not be, and
 * a second-by-second re-render on an appliance that runs for weeks buys nothing to show for it.
 */
function IdleScreen({ terminal, checkedAt }: { terminal: boolean; checkedAt: number | null }) {
  const C = appConfig.copy.standingLink
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!terminal) return
    // re-armed off `now`, so it lands ON the minute rather than drifting by the render's cost
    const id = window.setTimeout(() => setNow(Date.now()), 60_000 - (now % 60_000))
    return () => clearTimeout(id)
  }, [terminal, now])

  const clock = new Date(now)
  return (
    <div className={`sl-idle${terminal ? ' sl-terminal' : ' sl-as'}`} role="status">
      <IconSprite />
      {/* the quiet sign. `aria-hidden`: it is the same thing the kicker beside it already says
          in words, and a screen reader announcing a decorative watermark says it twice. */}
      <span className="sl-glyph" aria-hidden="true"><Icon id={terminal ? 'station' : 'gauge'} /></span>

      <span className="sl-kicker">
        <Icon id={terminal ? 'station' : 'gauge'} />
        {terminal ? `${deploymentName()} · ${C.terminalKicker}` : appConfig.copy.atemschutz.title}
      </span>

      <div className="sl-middle">
        {terminal ? (
          <>
            <div className="sl-clock">{formatTime(clock)}</div>
            <div className="sl-date">{clock.toLocaleDateString(appConfig.locale, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          </>
        ) : (
          /* three rings on one 6s cycle, 2s apart — a breath, not a pulse. The glyph in the
             middle is the same `gauge` standing behind the screen, at readable size. */
          <span className="sl-ring" aria-hidden="true">
            <i /><i /><i />
            <Icon id="gauge" />
          </span>
        )}
        <h2 className="sl-state">
          {C.idleTitle}
          <small>{terminal ? C.idleHintTerminal : C.idleHintAs}</small>
        </h2>
      </div>

      {/* the proof that a calm screen is not a frozen one */}
      {checkedAt != null && (
        <span className="sl-checked">
          <span className="sl-blip" />
          {C.checkedLabel} <b>{formatTime(new Date(checkedAt), true)}</b>
        </span>
      )}
    </div>
  )
}

function Chooser({ candidates, onPick }: { candidates: StandingCandidate[]; onPick: (id: string) => void }) {
  const C = appConfig.copy.standingLink
  const time = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : ''
  return (
    <Shell>
      <p>{C.chooseTitle}</p>
      <p className="cv-hint">{C.chooseHint}</p>
      {candidates.map((c) => (
        <button key={c.id} type="button" className="cv-btn" onClick={() => onPick(c.id)}>
          {c.title}
          {c.is_exercise ? ` (${C.exerciseTag})` : ''}
          {c.address ? ` – ${c.address}` : ''}
          {c.started_at ? ` – ${time(c.started_at)}` : ''}
        </button>
      ))}
    </Shell>
  )
}

/** One card, one instruction. `invalid` reads differently per surface: the terminal needs
 *  re-enrolling from the Verwaltung, the laminated QR needs re-printing — same lever
 *  (rotation), different piece of paper. Neither fixes itself, so no retry is offered;
 *  offline/error DO keep the poll running behind the card and add a manual retry. */
function FailedCard({ reason, terminal, onRetry }: { reason: StandingFailure; terminal: boolean; onRetry: () => void }) {
  const C = appConfig.copy.standingLink
  const CL = appConfig.copy.incidentLink
  const said: Record<StandingFailure, { title: string; hint: string; canRetry: boolean }> = {
    invalid: terminal
      ? { title: C.notEnrolledTitle, hint: C.notEnrolledHint, canRetry: false }
      : { title: C.asInvalidTitle, hint: C.asInvalidHint, canRetry: false },
    disabled: { title: C.disabledTitle, hint: C.disabledHint, canRetry: false },
    offline: { title: CL.offlineTitle, hint: CL.offlineHint, canRetry: true },
    error: { title: CL.errorTitle, hint: CL.errorHint, canRetry: true },
  }
  const { title, hint, canRetry } = said[reason]
  return (
    <Shell role="alert">
      <Icon id="warn" />
      <p>{title}</p>
      <p className="cv-hint">{hint}</p>
      {canRetry && <button type="button" className="cv-btn" onClick={onRetry}>{CL.retry}</button>}
    </Shell>
  )
}

export default function StandingApp({ token }: { token: string | null }) {
  // `token === null` is the enrolled terminal (/terminal, device cookie). A `t…` token is the
  // terminal's ENROLLMENT visit; an `s…` token is the standing Atemschutz page, whose token
  // stays in the address bar for its whole life (the laminated QR IS the address).
  const terminal = token === null || token.startsWith('t')
  const [tok, setTok] = useState(token)
  const [state, setState] = useState<State>({ phase: 'opening' })
  // The Einsatz this page is bound to (or the chooser pick in flight) — a ref, because the
  // poll loop reads it between renders and a stale closure would un-make a made choice.
  const boundRef = useRef<string | null>(null)
  const [tick, setTick] = useState(0) // manual retry / chooser pick → poll now
  /* When the poll last got an answer — the «Zuletzt geprüft» the idle screen closes with.
   * ⚠️ Stamped in the IDLE branch only, deliberately. Every other phase either has a screen of
   * its own to say it or, in the `ok` case, is a mounted app: the branch above goes to lengths
   * to hand `setState` the SAME object so a poll never re-renders it, and a timestamp ticking
   * in this component every 10s would re-render the whole board right past that care. */
  const [checkedAt, setCheckedAt] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    let timer: number | undefined

    const apply = (r: StandingExchange) => {
      if (r.ok) {
        const res = r.resolution
        if (res.status === 'ok') {
          boundRef.current = res.incidentId
          // Same Einsatz → same state object, so the mounted app never re-mounts on a poll.
          setState((prev) => (prev.phase === 'ok' && prev.incidentId === res.incidentId ? prev : { phase: 'ok', incidentId: res.incidentId }))
        } else if (res.status === 'idle') {
          boundRef.current = null
          setCheckedAt(Date.now())
          setState((prev) => (prev.phase === 'idle' ? prev : { phase: 'idle' }))
        } else {
          setState({ phase: 'choose', candidates: res.candidates })
        }
        return
      }
      // A transient failure must not tear down a running board — the next tick decides.
      if ((r.reason === 'offline' || r.reason === 'error')) {
        setState((prev) => (prev.phase === 'ok' ? prev : { phase: 'failed', reason: r.reason }))
        return
      }
      setState({ phase: 'failed', reason: r.reason })
    }

    const run = async () => {
      const r = tok ? await exchangeStandingToken(tok, boundRef.current) : await exchangeTerminalSession(boundRef.current)
      if (!alive) return
      apply(r)
      // The terminal's enrollment succeeded → the device cookie is set: drop the secret from
      // the address bar for good and live on the cookie from the next tick on.
      if (tok && terminal && r.ok) {
        window.history.replaceState({}, '', TERMINAL_PATH)
        setTok(null) // re-runs this effect; the fresh loop replaces this one
        return
      }
      // A dead credential does not fix itself by asking again — stop until a human acts.
      if (!r.ok && (r.reason === 'invalid' || r.reason === 'disabled')) return
      timer = window.setTimeout(() => void run(), STANDING_POLL_MS)
    }

    void run()
    return () => { alive = false; if (timer !== undefined) clearTimeout(timer) }
  }, [tok, terminal, tick])

  if (state.phase === 'ok') {
    // Keyed by the Einsatz: a new resolution is a new session cookie, and the AuthProvider
    // probes /me once on mount — remounting is what makes it probe again.
    return <AuthProvider key={state.incidentId}><StandingSession /></AuthProvider>
  }
  if (state.phase === 'opening') return <Splash />
  if (state.phase === 'idle') return <IdleScreen terminal={terminal} checkedAt={checkedAt} />
  if (state.phase === 'choose') {
    return <Chooser candidates={state.candidates} onPick={(id) => { boundRef.current = id; setTick((n) => n + 1) }} />
  }
  return <FailedCard reason={state.reason} terminal={terminal} onRetry={() => { setState({ phase: 'opening' }); setTick((n) => n + 1) }} />
}
