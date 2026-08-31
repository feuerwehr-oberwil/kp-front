// External media import: pure helpers for validating a PICKED file (voice memo, picture or a
// generic Beilage), normalising its MIME type for the backend allowlist, and resolving the
// operator-confirmed «Aufnahme begann» HH:MM to an absolute timestamp. The upload itself rides
// the existing media endpoint; nothing here touches the offline queue — large imports are
// deliberately upload-during-save only (no IndexedDB copy).

/** v1 cap, mirrored server-side (backend/app/api/media.py MAX_UPLOAD_BYTES; the multipart
 *  body middleware cap `max_upload_mb` must stay above this). MB value feeds the copy. */
export const MAX_AUDIO_UPLOAD_MB = 100
export const MAX_AUDIO_UPLOAD_BYTES = MAX_AUDIO_UPLOAD_MB * 1024 * 1024

/** picker hint only — the backend allowlist stays authoritative */
export const AUDIO_IMPORT_ACCEPT = '.m4a,audio/mp4,audio/x-m4a,audio/m4a,audio/mpeg,audio/wav,audio/webm,audio/ogg'

// Types the server accepts (media.py _ALLOWED_AUDIO). audio/x-wav is normalised to audio/wav;
// an empty type on a .m4a file (iOS Files sometimes omits it) is normalised to audio/mp4.
const ALLOWED = new Set(['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/ogg'])

/** Server-compatible MIME type for a picked file, or null if unsupported. */
export function normalizeAudioType(type: string, name: string): string | null {
  const t = type.toLowerCase().split(';')[0].trim()
  if (t === 'audio/x-wav') return 'audio/wav'
  if (ALLOWED.has(t)) return t
  if (!t && /\.m4a$/i.test(name)) return 'audio/mp4'
  return null
}

// ── generic Beilagen (PDF, Dokument, Tabelle …) ────────────────────────────────────────────
// The journal's upload button takes ANY file, not just a voice memo: what arrives at 3am is as
// often a PDF from the Gebäudeeigentümer as a recording. Pictures and audio keep their own
// paths (thumbnail / player); everything else lands as a named Beilage on the row.

/** Same 100 MB endpoint cap as audio — one number for everything the composer sends. */
export const MAX_FILE_UPLOAD_MB = MAX_AUDIO_UPLOAD_MB
export const MAX_FILE_UPLOAD_BYTES = MAX_AUDIO_UPLOAD_BYTES

// Types the server stores as a generic Beilage (media.py _ALLOWED_FILE). Deliberately a list
// and not «anything»: the blob is served back to a browser, so an allowlist stays the guard
// even though the server hands generic files out as a download and never inline.
const ALLOWED_FILE = new Set([
  'application/pdf', 'text/plain', 'text/csv', 'application/zip',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
])
// …by extension, for the pickers that hand over an empty or wrong type (iOS Files, Android
// document providers and every «application/octet-stream» in between).
const FILE_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
}

/** picker hint for the ONE upload button — pictures, recordings and documents in one dialog */
export const MEDIA_IMPORT_ACCEPT = `image/*,${AUDIO_IMPORT_ACCEPT},${Object.keys(FILE_BY_EXT).map((e) => `.${e}`).join(',')}`

/** Server-compatible MIME type for a picked document, or null if unsupported. */
export function normalizeFileType(type: string, name: string): string | null {
  const t = type.toLowerCase().split(';')[0].trim()
  if (ALLOWED_FILE.has(t)) return t
  return FILE_BY_EXT[name.toLowerCase().split('.').pop() ?? ''] ?? null
}

export type AudioImportError = 'type' | 'size'

export function validateFileImport(
  file: { type: string; name: string; size: number },
  maxBytes: number = MAX_FILE_UPLOAD_BYTES,
): { ok: true; contentType: string } | { ok: false; reason: AudioImportError } {
  const contentType = normalizeFileType(file.type, file.name)
  if (!contentType) return { ok: false, reason: 'type' }
  if (file.size > maxBytes) return { ok: false, reason: 'size' }
  return { ok: true, contentType }
}

/** Which of the three paths a picked file takes. A picture goes to the photo list, a recording
 *  to the voice-memo import (one per entry, with its duration probe), the rest to Beilagen. */
export function classifyPick(file: { type: string; name: string }): 'photo' | 'audio' | 'file' {
  const t = file.type.toLowerCase()
  if (t.startsWith('image/')) return 'photo'
  if (t.startsWith('audio/') || /\.m4a$/i.test(file.name)) return 'audio'
  return 'file'
}

/** «2.4 MB» / «812 kB» — the one thing a Beilage chip can say about a file it cannot preview. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} kB`
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`
}

export function validateAudioImport(
  file: { type: string; name: string; size: number },
  maxBytes: number = MAX_AUDIO_UPLOAD_BYTES,
): { ok: true; contentType: string } | { ok: false; reason: AudioImportError } {
  const contentType = normalizeAudioType(file.type, file.name)
  if (!contentType) return { ok: false, reason: 'type' }
  if (file.size > maxBytes) return { ok: false, reason: 'size' }
  return { ok: true, contentType }
}

/** Resolve an HH:MM recording start to its most recent occurrence at or before `now`
 *  (23:50 entered at 00:30 → yesterday 23:50) — the app-wide no-date-picker convention. */
export function resolveRecordingStart(hhmm: string, now: Date = new Date()): Date | null {
  const [h, m] = hhmm.split(':').map(Number)
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1)
  return d
}

/** Compact duration for labels: 47s → "47s", 754s → "12:34", 3675s → "1:01:15". */
export function formatAudioDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs))
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}

/** Read a clip's duration via HTMLAudioElement metadata; null when unavailable (some
 *  containers report Infinity/NaN until fully decoded — treated as unknown, not an error). */
export function probeAudioDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = new Audio()
    a.preload = 'metadata'
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? Math.round(a.duration) : null)
    a.onerror = () => resolve(null)
    a.src = url
  })
}
