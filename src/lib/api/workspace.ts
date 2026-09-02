// Per-incident workspace blob: get/put + the live-follow poll. The blob is opaque here — the
// App owns its `Saved` structure; we only move it to/from the server. Offline caching + the
// debounced merge-on-save engine live alongside in ./workspaceSync.
import { ApiError, apiBeacon, apiGet, apiGetRaw, apiPut, LONG_POLL_TIMEOUT_MS } from '../api'
import type { Trupp } from '../../types'

export type Workspace = Record<string, unknown>

export const getWorkspace = (id: string) =>
  apiGet<{ workspace: Workspace | null; workspace_rev: number }>(`/api/incidents/${id}/workspace`)
export const putWorkspace = (id: string, workspace: Workspace, base_rev: number) =>
  apiPut<{ workspace: Workspace | null; workspace_rev: number }>(`/api/incidents/${id}/workspace`, {
    workspace,
    base_rev,
  })
/** Fire-and-forget workspace PUT for page teardown — survives the document unloading. */
export const putWorkspaceBeacon = (id: string, workspace: Workspace, base_rev: number) =>
  apiBeacon(`/api/incidents/${id}/workspace`, { workspace, base_rev }, 'PUT')

// --- the trupp slice on its own ------------------------------------------------------------
// An Atemschutz-Link session (auth · AuthUser.link_kind) may write the Überwachungstafel and
// nothing else, so the full workspace PUT 403s for it. Same route shape, same request/response
// contract (`base_rev` in, `{workspace, workspace_rev}` out, 409 on a race) — the server folds
// the trupps into the current blob and merges the rest itself. WorkspaceSync's `slice: 'trupps'`
// option routes its push and its teardown beacon here; everything else about the engine is
// unchanged.
export const putWorkspaceTrupps = (id: string, trupps: readonly Trupp[], base_rev: number) =>
  apiPut<{ workspace: Workspace | null; workspace_rev: number }>(`/api/incidents/${id}/workspace/trupps`, {
    trupps,
    base_rev,
  })
/** Teardown twin of putWorkspaceTrupps — see putWorkspaceBeacon. */
export const putWorkspaceTruppsBeacon = (id: string, trupps: readonly Trupp[], base_rev: number) =>
  apiBeacon(`/api/incidents/${id}/workspace/trupps`, { trupps, base_rev }, 'PUT')

// clock-skew watch (mirrors captureClient · onServerTime): workspace responses carry
// X-Server-Time (backend · api_server_time middleware), and the live-follow poll is the one
// request every device — editor and viewer alike — repeats for the whole session, so it is the
// sampling point. Header absent (older backend) → silent. useIncidentSync registers, computes
// the skew and surfaces it; only one listener is ever needed (one workspace per app).
let serverTimeListener: ((iso: string) => void) | null = null
export function onWorkspaceServerTime(fn: ((iso: string) => void) | null): void { serverTimeListener = fn }

/**
 * Live-follow poll: 304 → null (unchanged); 200 → the current workspace + rev.
 *
 * `wait` turns it into a LONG POLL: the server holds the request open (~20 s) until another
 * device's save bumps the revision, so a cross-device edit arrives in the time the write takes
 * to commit instead of on the next beat. The answer is the same 304/200 either way — a caller
 * that can't hold a connection open (backgrounded tab) simply passes `wait: false`.
 *
 * `signal` aborts a held request. Mandatory in practice for the waiting form: without it a
 * torn-down loop would stay pinned to a request for up to 20 s.
 */
export async function pollWorkspaceSince(
  id: string,
  sinceRev: number,
  opts?: { wait?: boolean; signal?: AbortSignal },
): Promise<{ workspace: Workspace | null; workspace_rev: number } | null> {
  const wait = opts?.wait ?? false
  const res = await apiGetRaw(`/api/incidents/${id}/workspace?since=${sinceRev}${wait ? '&wait=1' : ''}`, {
    signal: opts?.signal,
    timeoutMs: wait ? LONG_POLL_TIMEOUT_MS : undefined,
  })
  // before the status branches: the 304 "nothing new" answer carries the clock too, and on a
  // quiet incident it is the ONLY answer — the skew watch must not depend on edits happening
  const serverTime = res.headers.get('X-Server-Time')
  if (serverTime) serverTimeListener?.(serverTime)
  if (res.status === 304) return null
  if (!res.ok) throw new ApiError(res.status, 'Workspace-Poll fehlgeschlagen')
  return res.json()
}
