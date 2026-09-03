import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiGet, apiPost, ApiError, isUnverifiable, SESSION_EXPIRED_EVENT } from './api'
import { idbGet, idbSet, idbDel } from './idb'
import { getDeploymentConfig, isDemoMode, loadDeploymentConfig } from './deploymentConfig'
import { syncMediaCacheAuth } from './authMediaCache'
import { linkPageOwnsSession } from './linkMode'

// The demo's public PIN (shown to every visitor) — used to auto-sign-in on demo instances so
// there's no login screen. Only ever sent when isDemoMode() is true; real stations never use it.
const DEMO_PIN = '000000'

// Authenticated user as returned by the backend. role === 'editor' grants
// edit rights; 'viewer' is read-only (can pan / zoom / inspect, never mutate).
export interface AuthUser {
  id: string
  username: string
  display_name: string
  role: 'editor' | 'viewer'
  color: string | null
  last_login: string | null
  /** start this login in the Einsatzleiter view (frontend default; device pref overrides) */
  el_view_default?: boolean
  /** this is an Einsatz-Link session (/l/<token>), not a login: a viewer narrowed to ONE
   *  incident, whose backend surface is an allowlist of reads (see incidentLink.ts). Surfaces
   *  gate on it to hide what would 403 — reports, printing, alarms, and every write. */
  link_scoped?: boolean
  /** the one incident that session may see — the app opens it directly instead of listing */
  link_incident_id?: string
  /** WHICH link this session came in on. `alarm` and `view` are read-only; `atemschutz` is the
   *  Atemschutz-Link (the QR a non-FU scans to run only the Überwachungstafel of this one
   *  Einsatz), and it MAY write — the trupp slice of the workspace, journal rows of kind
   *  'team', and `atemschutz.*` events. Everything else still 403s, so the app renders that
   *  session as the lite board and nothing more (IncidentWorkspace · `asLink`). */
  link_kind?: 'alarm' | 'view' | 'atemschutz'
}

// One tappable roster tile from GET /api/auth/roster (no PIN / username here —
// identity is chosen by tapping, then confirmed by the PIN pad).
export interface RosterEntry {
  id: string
  display_name: string
  role: 'editor' | 'viewer'
  color: string | null
}

interface AuthContextValue {
  user: AuthUser | null
  /** true until the initial /me probe settles, so the gate can hold a splash */
  loading: boolean
  /** the initial probe left `user` null because the server could not be ASKED (offline, timeout,
   *  restarting) — as opposed to it having said «no». The Einsatz-Link door reads this so a phone
   *  that merely lost signal is told so, instead of «Dieser Link gilt nicht mehr». */
  probeUnreachable: boolean
  /** the session died mid-use and the transparent refresh could not repair it (api ·
   *  SESSION_EXPIRED_EVENT). `user` stays set on purpose — the workspace keeps working on its
   *  local cache — so a surface has to SAY it; this is the one flag that surface reads.
   *  Cleared by a fresh login or a logout. */
  sessionExpired: boolean
  login: (userId: string, pin: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// Cache the last-known user so the PWA stays usable OFFLINE: when the /me probe fails
// because the server could not be asked (offline, timeout, restarting — not a 401), the
// httpOnly cookie is still present in the browser but unverifiable, so we optimistically
// restore the cached identity instead of bouncing to the login screen. A real 401 (online,
// session gone) clears it.
// A link session is deliberately NEVER cached (and landing on one CLEARS the cache): the
// offline restore above is a promise that the httpOnly cookie is still good — true for a
// station tablet whose 8h/7d session simply can't be verified right now, false for an
// Einsatz-Link, which stops being valid the moment the Einsatz is closed or the link expires,
// with nothing on the device able to notice. Cached, a responder's phone would keep re-opening
// a read-only Einsatz view long after that Einsatz ended, and no online probe would ever come
// to correct it. It is also not the case the cache exists for: a personal phone opening a link
// from an alert isn't the installed PWA that must survive a cellar with no signal.
const USER_CACHE = 'kp-front-user'
function readCachedUser(): Promise<AuthUser | null> {
  return idbGet<AuthUser>(USER_CACHE)
}
function writeCachedUser(u: AuthUser | null) {
  void (u && !u.link_scoped ? idbSet(USER_CACHE, u) : idbDel(USER_CACHE))
}

/** The /me bound when a cached user is waiting behind it. The default 20 s is right for a
 *  request nothing else can answer — but here the offline fallback IS the answer, and the boot
 *  Splash admits «hängt» with a «Neu starten» button at 9 s (Splash · STUCK_MS). With the full
 *  bound, obeying that button restarted the probe from zero and the cached session was only
 *  ever reached by ignoring it. Well under 9 s, so a half-open link lands on the cached user
 *  before the splash gives up; a slow-but-alive server then simply gets the designed offline
 *  boot, which the next poll corrects. */
const CACHED_PROBE_TIMEOUT_MS = 7_000
/** how long the boot probe waits for the session-bearing config re-read before mounting the app */
const SESSION_CONFIG_BUDGET_MS = 4_000

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [probeUnreachable, setProbeUnreachable] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)

  // Demo instances skip the login screen: on a fresh visit (no session) auto-sign-in as the
  // demo editor so a visitor lands straight in the action. Fetch the roster, pick the editor,
  // login with the public demo PIN. Failure falls through to the normal login screen.
  const tryDemoAutoLogin = async (): Promise<AuthUser | null> => {
    if (!isDemoMode()) return null
    // ⚠️ Never on a link page. A `/l/<token>` page speaks only for its own link session (lib/
    // linkMode), so signing an account in there would hand it a login every request then refuses
    // to use — a demo visitor whose link had lapsed would sit inside a fully broken app instead
    // of the honest «Link abgelaufen» card, whose reload re-exchanges the token in the address.
    if (linkPageOwnsSession()) return null
    try {
      const roster = await apiGet<RosterEntry[]>('/api/auth/roster')
      const editor = roster.find((r) => r.role === 'editor') ?? roster[0]
      if (!editor) return null
      const demoUser = await apiPost<AuthUser>('/api/auth/login', { user_id: editor.id, pin: DEMO_PIN })
      // Boot fetched the anonymous config before this session existed. That response deliberately
      // withholds browser capabilities such as the CARTO key; mount the map only after the
      // authenticated refresh or a first-time visitor sees watermarked tiles until reloading.
      try { await loadDeploymentConfig() } catch { /* keep the booted config */ }
      return demoUser
    } catch { return null }
  }

  // On mount, ask the backend who we are. A 401 just means "not logged in" (normal
  // cold-start) — on the demo we then auto-sign-in. A server that could not be asked (offline,
  // timeout, restarting — api · isUnverifiable) falls back to the cached user so an installed
  // PWA opens straight into the app with no signal.
  //
  // This probe used to answer a 403 by POSTing `/api/auth/logout` and asking once more: a dead
  // Einsatz-Link cookie made every credential-gated route refuse, and the kiosk login was
  // unreachable behind it for up to 12 h. That trap is gone at the root (02.09.) — the ordinary
  // app tells the server it is not a link page, so a link cookie is not read here at all
  // (lib/linkMode · backend auth/incident_link · LINK_MODE_HEADER) — and the repair itself was
  // the coupling the maintainer named: one 403 for any reason at all signed the device out.
  useEffect(() => {
    let alive = true
    void (async () => {
      const cached = await readCachedUser()
      const probe = () => apiGet<AuthUser>('/api/auth/me', cached ? { timeoutMs: CACHED_PROBE_TIMEOUT_MS } : undefined)
      try {
        const u: AuthUser = await probe()
        // The boot config was fetched BEFORE this probe, and `/api/config` is public: with the
        // access cookie expired and only the refresh cookie alive it answered as an ANONYMOUS
        // caller — no 401, so no refresh — and silently withheld the CARTO key and the Rapport
        // links (backend api/config · get_config). The probe above is what refreshed the session,
        // so re-read now, before the app mounts and the map builds its tile URLs; the basemap
        // used to print «API key required» for the whole session (field report 02.09.). Only
        // when the booted config shows the withholding, and bounded: a slow link must not hold
        // the splash twice — a late answer still lands in the singleton and the offline cache.
        if (!getDeploymentConfig().integrations?.cartoBasemapKey) {
          await Promise.race([loadDeploymentConfig().catch(() => {}), new Promise((r) => setTimeout(r, SESSION_CONFIG_BUDGET_MS))])
        }
        if (alive) { setUser(u); writeCachedUser(u) }
      } catch (e) {
        if (!alive) return
        if (isUnverifiable(e)) {
          if (cached) setUser(cached) // unverifiable, not refused — keep the session usable
          else setProbeUnreachable(true)
        } else if (e instanceof ApiError && e.status === 401) {
          writeCachedUser(null) // genuinely logged out
          const demoUser = await tryDemoAutoLogin() // demo → straight in; real stations → login screen
          if (alive && demoUser) { setUser(demoUser); writeCachedUser(demoUser) }
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  // The one listener for a session that died mid-use; the flag is what a banner consumes.
  useEffect(() => {
    const onExpired = () => setSessionExpired(true)
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
  }, [])

  // Protected media is cached only for a known real-user client. Do not signal during the
  // initial probe: `user === null` still means "unknown" then, not "logged out". Once the
  // probe settles, logout/session expiry clears media, a user change changes cache ownership,
  // and an Einsatz-Link becomes network-only without consuming the station cache.
  useEffect(() => {
    if (!loading) syncMediaCacheAuth(user)
  }, [loading, user])

  // Throws ApiError on a bad PIN (401) or cooldown (429) so LoginScreen can show
  // the backend's German `detail` (and disable the pad on a Retry-After).
  const login = async (userId: string, pin: string) => {
    const u = await apiPost<AuthUser>('/api/auth/login', { user_id: userId, pin })
    setUser(u)
    setSessionExpired(false)
    writeCachedUser(u)
    // ⚠️ Re-read the deployment config now that there IS a session. Parts of it are withheld
    // from anonymous callers (`report.links` — the station's own Formulare, whose URLs are
    // capabilities; see backend api/config · get_config), and the boot fetch necessarily ran
    // before this login. A later boot re-reads too when its config shows the withholding — the
    // boot fetch is anonymous whenever the access cookie has expired (probe effect above).
    // Best-effort: a station that cannot re-read still has the config it booted with, and
    // failing the login over a config refresh would be the worse trade at 3am.
    try { await loadDeploymentConfig() } catch { /* keep the booted config */ }
  }

  const logout = async () => {
    try { await apiPost('/api/auth/logout') } catch { /* best-effort — clear locally regardless */ }
    setUser(null)
    setSessionExpired(false)
    writeCachedUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, probeUnreachable, sessionExpired, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
