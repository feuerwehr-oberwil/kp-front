// Führungsformular «Zeitplan» — building the print payload and getting the sheet out.
//
// The server composes the PDF (backend/app/zeitplan_pdf.py); nothing renders here. Two ways
// out, the same pair the Einsatzrapport offers: download the file, or queue it on the station
// printer for the sheet you hang at the front.

import type { AttendanceState, Person, Shift } from '../types'
import { intervalsOf } from './attendanceIntervals'
import { shiftsFor } from './shifts'
import { editorPrintTransport, enqueuePrint } from './printRelay'

const BASE = import.meta.env.VITE_KP_RUECK_URL ?? ''

export interface ZeitplanPrintPayload {
  incidentTitle: string
  incidentAddress?: string
  startedAt?: string
  printedAt: string
  rows: { name: string; rank?: string; blocks: { from: string; to?: string; planned: boolean }[] }[]
}

/**
 * The sheet's data: one row per person in the order the surface shows them, carrying both the
 * planned blocks and the presence actually recorded — printed hollow and filled respectively,
 * so the paper says the same thing the screen does.
 *
 * Everyone gets a row, planned or not: a Führungsformular is written on, and an empty lane is
 * where the pen goes.
 */
export function buildZeitplanPayload(
  people: Person[],
  attendance: AttendanceState,
  shifts: Shift[],
  incident: { title: string; address?: string | null; startedAt?: string | null },
  nowIso: string,
): ZeitplanPrintPayload {
  return {
    incidentTitle: incident.title,
    ...(incident.address ? { incidentAddress: incident.address } : {}),
    ...(incident.startedAt ? { startedAt: incident.startedAt } : {}),
    printedAt: nowIso,
    rows: people.map((p) => ({
      name: p.displayName,
      ...(p.rank ? { rank: p.rank } : {}),
      blocks: [
        ...shiftsFor(shifts, p.id).map((s) => ({ from: s.from, to: s.to, planned: true })),
        ...intervalsOf(attendance[p.id]).map((iv) => ({ from: iv.from, to: iv.to, planned: false })),
      ],
    })),
  }
}

/** Download the sheet as a PDF. Resolves once the browser has the blob. */
export async function downloadZeitplanPdf(incidentId: string, payload: ZeitplanPrintPayload): Promise<void> {
  const form = new FormData()
  form.append('payload', JSON.stringify(payload))
  const res = await fetch(`${BASE}/api/incidents/${encodeURIComponent(incidentId)}/zeitplan/pdf`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'Zeitplan.pdf'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // let the download start before the object URL goes away
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Queue the sheet on the station printer; resolves to the job id (for the live toast). */
export function printZeitplan(incidentId: string, payload: ZeitplanPrintPayload): Promise<string> {
  const t = editorPrintTransport(BASE)
  return enqueuePrint(
    { ...t, enqueueUrl: (id) => `${BASE}/api/incidents/${encodeURIComponent(id)}/zeitplan/print` },
    incidentId,
    payload,
  )
}
