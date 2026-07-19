// Station print relay client — «An Stationsdrucker».
//
// The backend composes the same Einsatzrapport-PDF as the download endpoints and queues it
// for the on-site print agent; nothing renders here. Fail-closed: `fetchPrintStatus`
// reports `available: false` (or null on error) → the button never renders. `online`
// reflects the agent heartbeat so the button can be honest about the relay's state.

import { appConfig } from '../config/appConfig'

// Mirror api.ts's base so a cross-origin deployment still resolves (Vite proxies /api in dev).
const BASE = import.meta.env.VITE_KP_RUECK_URL ?? ''

export interface PrintRelayStatus {
  available: boolean
  online: boolean
}

/** Endpoint set + auth of one surface (editor kiosk cookie vs. capture poster token). */
export interface PrintTransport {
  statusUrl: string
  enqueueUrl: (incidentId: string) => string
  cancelUrl: (jobId: string) => string
  headers?: Record<string, string>
}

export function editorPrintTransport(base: string = BASE): PrintTransport {
  return {
    statusUrl: `${base}/api/print/status`,
    enqueueUrl: (incidentId) => `${base}/api/incidents/${encodeURIComponent(incidentId)}/report/print`,
    cancelUrl: (jobId) => `${base}/api/print-jobs/${encodeURIComponent(jobId)}`,
  }
}

export function capturePrintTransport(token: string): PrintTransport {
  return {
    statusUrl: '/api/capture/print/status',
    enqueueUrl: (incidentId) => `/api/capture/incidents/${encodeURIComponent(incidentId)}/report/print`,
    cancelUrl: (jobId) => `/api/capture/print-jobs/${encodeURIComponent(jobId)}`,
    headers: { 'X-Capture-Token': token },
  }
}

/** null = unknown (offline / error) — treat like unavailable and hide the button. */
export async function fetchPrintStatus(t: PrintTransport): Promise<PrintRelayStatus | null> {
  try {
    const res = await fetch(t.statusUrl, { credentials: 'include', headers: t.headers })
    if (!res.ok) return null
    const body = await res.json()
    return { available: !!body.available, online: !!body.online }
  } catch {
    return null
  }
}

/** Queue the rapport on the station printer; resolves to the job id (for Rückgängig). */
export async function enqueuePrint(t: PrintTransport, incidentId: string, payload: unknown): Promise<string> {
  const form = new FormData()
  form.append('payload', JSON.stringify(payload))
  const res = await fetch(t.enqueueUrl(incidentId), {
    method: 'POST',
    credentials: 'include',
    headers: t.headers,
    body: form,
  })
  // localized message (read at call time, not module load) — callers surface it in a toast
  if (!res.ok) throw new Error(`${appConfig.copy.printRelay.failed} (${res.status})`)
  const body = await res.json()
  if (!body.job_id) throw new Error(appConfig.copy.printRelay.failed)
  return body.job_id as string
}

/** Cancel while still queued (the undo toast). False = too late, the agent claimed it. */
export async function cancelPrint(t: PrintTransport, jobId: string): Promise<boolean> {
  const res = await fetch(t.cancelUrl(jobId), {
    method: 'DELETE',
    credentials: 'include',
    headers: t.headers,
  })
  return res.ok
}
