import type { SyncStatus } from './api/workspaceSync'

/** Saving is complete only when every operational outbox is safe and acknowledged. */
export function combinedSyncStatus(...statuses: SyncStatus[]): SyncStatus {
  for (const status of ['storage', 'error', 'offline', 'pending'] as const) {
    if (statuses.includes(status)) return status
  }
  return 'synced'
}
