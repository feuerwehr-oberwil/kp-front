// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the HTTP layer but keep the REAL ApiError so AuthProvider's `e instanceof ApiError` holds.
const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }))
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, apiGet, apiPost }
})
vi.mock('./idb', () => ({ idbGet: vi.fn().mockResolvedValue(null), idbSet: vi.fn(), idbDel: vi.fn() }))

import { ApiError } from './api'
import * as deploymentConfig from './deploymentConfig'
import { AuthProvider, useAuth } from './auth'

const EDITOR = { id: 'ed-1', display_name: 'FU', role: 'editor', color: null }
const VIEWER = { id: 'vw-1', display_name: 'Betrachter', role: 'viewer', color: null }
const EDITOR_USER = { id: 'ed-1', username: 'fu', display_name: 'FU', role: 'editor', color: null, last_login: null }

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>

beforeEach(() => { apiGet.mockReset(); apiPost.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe('AuthProvider — demo auto-login', () => {
  it('signs in as the demo editor when there is no session (demo instance → no login screen)', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(true)
    apiGet.mockImplementation((path: string) =>
      path === '/api/auth/roster' ? Promise.resolve([VIEWER, EDITOR]) : Promise.reject(new ApiError(401, 'unauth')))
    apiPost.mockResolvedValue(EDITOR_USER)

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.user).toEqual(EDITOR_USER))
    // picked the editor (not the viewer) and used the public demo PIN
    expect(apiPost).toHaveBeenCalledWith('/api/auth/login', { user_id: 'ed-1', pin: '000000' })
  })

  it('does NOT auto-login on a real (non-demo) station', async () => {
    vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(false)
    apiGet.mockRejectedValue(new ApiError(401, 'unauth'))

    const { result } = renderHook(() => useAuth(), { wrapper })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.user).toBeNull()
    expect(apiPost).not.toHaveBeenCalled()
  })
})
