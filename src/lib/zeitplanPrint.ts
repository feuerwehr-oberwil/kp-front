// Führungsformular «Zeitplan» — building the print payload and getting the sheet out.
//
// The server composes the PDF (backend/app/zeitplan_pdf.py); nothing renders here. Two ways
// out, the same pair the Einsatzrapport offers: download the file, or queue it on the station
// printer for the sheet you hang at the front.

import type { AttendanceState, Person, Shift } from '../types'
import { shiftsFor } from './shifts'
import { intervalsOf } from './attendanceIntervals'
import { editorPrintTransport, enqueuePrint } from './printRelay'

const BASE = import.meta.env.VITE_KP_RUECK_URL ?? ''

export interface ZeitplanPrintPayload {
  incidentTitle: string
  incidentAddress?: string
  startedAt?: string
  printedAt: string
  rows: {
    name: string
    rank?: string
    blocks: { from: string; to?: string; confirmed: boolean }[]
    /** recorded attendance — the thin rule under the plan on the sheet */
    actual: { from: string; to?: string }[]
  }[]
}

/**
 * The sheet's data: one row per person in the order the surface shows them, carrying BOTH halves
 * of that person's time — the plan (availability offered, and what was assigned from it) and the
 * attendance actually recorded.
 *
 * The attendance used to be left off deliberately, on the grounds that the sheet is a planning aid
 * and the record belongs in the Rapport. That was the wrong cut for the person holding it: the
 * sheet is read while deciding who to send home and who to call in, and a plan without the record
 * beside it cannot answer whether the plan held. The Rapport is still the record; this is a
 * working copy of it, and it is marked as one.
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
      blocks: shiftsFor(shifts, p.id).map((s) => ({ from: s.from, to: s.to, confirmed: !!s.confirmed })),
      // `to` omitted while somebody is still here — the sheet draws an open block up to the
      // moment it was printed, which is the only honest end for one
      actual: intervalsOf(attendance[p.id]).map((iv) => (iv.to ? { from: iv.from, to: iv.to } : { from: iv.from })),
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
