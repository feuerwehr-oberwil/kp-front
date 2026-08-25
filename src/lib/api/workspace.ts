// Per-incident workspace blob: get/put + the live-follow poll. The blob is opaque here — the
// App owns its `Saved` structure; we only move it to/from the server. Offline caching + the
// debounced merge-on-save engine live alongside in ./workspaceSync.
import { ApiError, apiBeacon, apiGet, apiGetRaw, apiPut, LONG_POLL_TIMEOUT_MS } from '../api'

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
  if (res.status === 304) return null
  if (!res.ok) throw new ApiError(res.status, 'Workspace-Poll fehlgeschlagen')
  return res.json()
}
