// Client side of the server-composed Einsatzrapport PDF (see backend app/report_pdf.py).
//
// The payload is pure DATA — form fields, the Kroki scene, plan references + annotations.
// The server renders the map (raster tiles + the
// shared symbol pack), the plan pages (pdfium) and loads journal photos from its own media
// store; nothing is captured or uploaded from the browser anymore.

// Mirror api.ts's base so a cross-origin deployment still resolves (Vite proxies /api in dev).
const BASE = import.meta.env.VITE_KP_RUECK_URL ?? ''

/** POST the payload to the composer, then download the returned PDF. Throws on a non-2xx
 *  response so the caller can surface an error toast. */
export interface ReportTransport {
  /** override endpoint (e.g. the capture view's poster-token route) */
  url: string
  headers?: Record<string, string>
}

export async function downloadReportPdf(
  incidentId: string,
  payload: unknown,
  filenameHint: string,
  transport?: ReportTransport,
): Promise<void> {
  const form = new FormData()
  form.append('payload', JSON.stringify(payload))

  const res = await fetch(transport?.url ?? `${BASE}/api/incidents/${encodeURIComponent(incidentId)}/report/pdf`, {
    method: 'POST',
    credentials: 'include',
    headers: transport?.headers,
    body: form,
  })
  if (!res.ok) throw new Error(`Rapport-PDF fehlgeschlagen (${res.status})`)

  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `Einsatzrapport_${filenameHint || 'Einsatz'}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** Sanitise an incident title into a safe filename fragment (mirrors the server side). */
export function reportFilenameHint(title: string): string {
  return Array.from(title).filter((c) => /[\p{L}\p{N} \-_]/u.test(c)).join('').trim().replace(/\s+/g, '_').slice(0, 60)
}
