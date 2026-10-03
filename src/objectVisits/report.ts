// Getting a visit OFF the device: the server's report PDF, and «Als Datei sichern» — the visit as
// a file the member keeps when the device could not store it (or the server cannot be reached).

import { downloadBlob } from '../lib/download'
import { attachmentUrl, fetchBlob, OV_ROUTES } from './api'
import { checklistItems, fileSafe } from './doc'
import { readAttachment, type LocalVisit } from './store'
import type { VisitDoc } from './types'
import { buildZip, type ZipEntry } from './zip'

const datePart = (iso: string) => (iso || '').slice(0, 10)

/** «Objektbesuch 2026-10-03 Gemeindeverwaltung» — the stem every file of one visit shares. */
export function visitFileStem(doc: VisitDoc): string {
  return fileSafe(`Objektbesuch ${datePart(doc.visitedAt)} ${doc.object?.name ?? ''}`.trim(), 80)
}

/** Fetch the report of a revision (latest by default) and save it. Throws on failure. */
export async function downloadReport(doc: VisitDoc, revision?: number | null): Promise<void> {
  const blob = await fetchBlob(OV_ROUTES.report(doc.id, revision))
  downloadBlob(blob, `${visitFileStem(doc)}${revision != null ? ` r${revision}` : ''}.pdf`)
}

/** The photo's name inside the export: «01 Deckel klemmt (1a2b).jpg» (the delivery's own shape). */
export function photoFileName(index: number, caption: string, attId: string, type: string): string {
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'
  const cap = fileSafe(caption || '', 50)
  return `${String(index + 1).padStart(2, '0')}${cap ? ` ${cap}` : ''} (${attId.slice(-4)}).${ext}`
}

/** A plain-text reading of the visit, for a person opening the export without any tool. */
export function visitText(doc: VisitDoc, words: { check: Record<string, string>; open: string; notes: string; proposals: string }): string {
  const lines: string[] = [`${doc.object?.name ?? ''}${doc.object?.address ? ` · ${doc.object.address}` : ''}`, doc.visitedAt, '']
  for (const it of checklistItems(doc.checklist)) {
    const a = doc.answers[it.id]
    const v = a == null ? words.open : typeof a.v === 'string' && words.check[a.v] ? words.check[a.v] : String(a.v)
    lines.push(`- ${it.text}: ${v}${a?.note ? ` (${a.note})` : ''}`)
  }
  if (doc.notes.trim()) lines.push('', `${words.notes}:`, doc.notes.trim())
  if (doc.proposals.length) {
    lines.push('', `${words.proposals}:`)
    for (const p of doc.proposals) lines.push(`- ${p.label}: ${p.current ? `${p.current} → ` : ''}${p.proposed}${p.reason ? ` (${p.reason})` : ''}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Everything this device holds of one visit, as one ZIP: `besuch.json` (the device record — the
 * document plus what the server last said), `besuch.txt`, and every photo whose bytes are here
 * (memory holdings included — that is the point when storage refused them) or can still be
 * fetched. Returns how many photos could not be included.
 */
export async function exportVisitFile(rec: LocalVisit, text: string): Promise<{ missingPhotos: number }> {
  const doc = rec.doc
  const entries: ZipEntry[] = [
    { name: 'besuch.json', data: JSON.stringify({ exportedAt: new Date().toISOString(), record: rec }, null, 2) },
    { name: 'besuch.txt', data: text },
  ]
  let missingPhotos = 0
  for (const [i, p] of doc.photos.entries()) {
    const a = await readAttachment(p.id)
    // a photo released after the server acknowledged it (outbox · releaseSettled) is
    // fetched back when the server can be reached
    const local: Blob | null = a.ok ? a.value?.blob ?? null : null
    const blob = local ?? await fetchBlob(attachmentUrl(doc.id, p.id)).catch(() => null)
    if (!blob) { missingPhotos++; continue }
    entries.push({ name: `fotos/${photoFileName(i, p.caption, p.id, p.type)}`, data: new Uint8Array(await blob.arrayBuffer()) })
  }
  downloadBlob(buildZip(entries), `${visitFileStem(doc)} (${doc.id.slice(-4)}).zip`)
  return { missingPhotos }
}
