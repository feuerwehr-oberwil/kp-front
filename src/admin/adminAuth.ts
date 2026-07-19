// Deployment-admin auth — unlocks the /admin surface with the shared station ADMIN_SECRET,
// separate from the incident editor PIN (see backend app/api/admin.py). The admin session is
// an httpOnly cookie; this client only ever sees the {configured, authenticated} state.
import { apiGet, apiPost } from '../lib/api'

export interface AdminSessionState {
  /** Whether ADMIN_SECRET is configured on this deployment at all (false → admin disabled). */
  configured: boolean
  /** Whether THIS browser already holds a valid admin session. */
  authenticated: boolean
}

export const getAdminSession = () => apiGet<AdminSessionState>('/api/admin/session')

export const adminLogin = (secret: string) =>
  apiPost<{ ok: boolean }>('/api/admin/login', { secret })

export const adminLogout = () => apiPost<{ ok: boolean }>('/api/admin/logout')
