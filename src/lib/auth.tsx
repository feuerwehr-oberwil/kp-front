import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiGet, apiPost, ApiError } from './api'
import { idbGet, idbSet, idbDel } from './idb'

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
  login: (userId: string, pin: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// Cache the last-known user so the PWA stays usable OFFLINE: when the /me probe fails
// with a network error (not a 401), the httpOnly cookie is still present in the browser
// but unverifiable, so we optimistically restore the cached identity instead of bouncing
// to the login screen. A real 401 (online, session gone) clears it.
const USER_CACHE = 'kp-front-user'
function readCachedUser(): Promise<AuthUser | null> {
  return idbGet<AuthUser>(USER_CACHE)
}
function writeCachedUser(u: AuthUser | null) {
  void (u ? idbSet(USER_CACHE, u) : idbDel(USER_CACHE))
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  // On mount, ask the backend who we are. A 401 just means "not logged in" (normal
  // cold-start). A network error (status 0 = offline) falls back to the cached user so
  // an installed PWA opens straight into the app at the scene with no signal.
  useEffect(() => {
    let alive = true
    apiGet<AuthUser>('/api/auth/me')
      .then((u) => { if (alive) { setUser(u); writeCachedUser(u) } })
      .catch(async (e) => {
        if (!alive) return
        if (e instanceof ApiError && e.status === 0) {
          const cached = await readCachedUser()
          if (alive && cached) setUser(cached) // offline — keep the session usable
        } else if (e instanceof ApiError && e.status === 401) {
          writeCachedUser(null) // genuinely logged out
        }
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  // Throws ApiError on a bad PIN (401) or cooldown (429) so LoginScreen can show
  // the backend's German `detail` (and disable the pad on a Retry-After).
  const login = async (userId: string, pin: string) => {
    const u = await apiPost<AuthUser>('/api/auth/login', { user_id: userId, pin })
    setUser(u)
    writeCachedUser(u)
  }

  const logout = async () => {
    try { await apiPost('/api/auth/logout') } catch { /* best-effort — clear locally regardless */ }
    setUser(null)
    writeCachedUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
