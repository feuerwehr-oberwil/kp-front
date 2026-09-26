import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import type { ReportAttachment } from '../types'
import type { IncidentMeta } from './api/incidents'
import type { Dropper, UndoDomain } from './undoTimeline'
import { recordKey, type RecordKey } from './undoKeys'
import type { MediaQueueApi } from './useMediaQueue'
import { uploadMedia } from './incidents'
import { prepareUploadImage } from './imagePrep'
import { forgetLocalThumb, mintLocalThumb } from './mediaUrl'
import { newId } from './ids'
import { fillTemplate } from './format'
import { REPORT_COALESCE_MS } from './reportUndo'
import { toast, undoToast } from './ui'

interface Args {
  incidentMeta: Pick<IncidentMeta, 'id'>
  /** this session may write the record domains (IncidentWorkspace · canWriteRecord) */
  canWriteRecord: boolean
  media: MediaQueueApi
  /** swap ONE picture of a row by value (journal · swapPhoto) */
  swapPhoto: (rowId: string, from: string, to: string) => void
  /** swap a row's local media URL for the server one (IncidentWorkspace · swapRowMedia) */
  swapRowMedia: (rowId: string, kind: 'photo' | 'audio', url: string, replaces?: string) => void
  attachments: ReportAttachment[]
  setAttachments: Dispatch<SetStateAction<ReportAttachment[]>>
  emit: (op: string, payload?: Record<string, unknown>) => void
  /** ⚠️ The REF OBJECT, not its value: the workspace assigns the timeline's one-shot pusher to it
   *  much further down its render, after this hook has run. */
  rememberOneShotRef: MutableRefObject<(domain: UndoDomain, label: string, restore: () => void, reapply: () => void, touches: () => readonly RecordKey[] | null, rows?: 'silent') => Dropper>
  /** …and the Bildlegende's standing fold window, which the workspace's remote hydrate resets */
  lastCaptionStepRef: MutableRefObject<{ key: string; at: number; from: string | undefined; drop: () => void } | null>
}

/**
 * The media a Verlauf row carries and the Rapport-Beilagen, lifted out of IncidentWorkspace
 * (23.09.2026): the upload of a row's photo / Sprachnotiz that swaps its session blob: URL for the
 * server's (or parks the blob in the offline queue), and the Beilagen's add / caption / remove,
 * each one step on the one timeline (a typed caption folds into ONE) and the remove
 * confirm-with-undo.
 *
 * Moved verbatim and called where the block stood. The callbacks' deps are the old ones plus the
 * two ref OBJECTS, which arrive as arguments now — stable identities, so nothing re-memoizes.
 */
export function useRowMediaUpload({
  incidentMeta, canWriteRecord, media, swapPhoto, swapRowMedia, attachments, setAttachments, emit,
  rememberOneShotRef, lastCaptionStepRef,
}: Args) {
  // upload a captured photo/audio blob and swap the timeline row's session blob: URL for the
  // persistent server URL (so history keeps the media). On failure the blob is persisted to the
  // offline queue so the capture survives a reload and re-uploads when connectivity returns.
  /**
   * Upload ONE picture of a row that may carry several, and swap that picture's local blob: URL
   * for the server URL — by value, not by field: a row with three photos must not lose two of
   * them because the third finished uploading. Failures keep the blob: entry, which the Rapport
   * preflight already counts as pending media.
   */
  const uploadPhotoForRow = useCallback(async (rowId: string, localUrl: string) => {
    if (!canWriteRecord) return
    let blob: Blob
    try {
      blob = await (await fetch(localUrl)).blob()
    } catch { return }
    blob = await prepareUploadImage(blob)
    try {
      const { url } = await uploadMedia(incidentMeta.id, blob, 'photo', `photo-${rowId}`)
      swapPhoto(rowId, localUrl, url)
      forgetLocalThumb(localUrl) // the chip reads the server's small copy from here on
    } catch {
      // queue THIS picture (keyed by its own blob: URL) — a row-wide key made each photo of a
      // multi-photo row evict the previous one, losing every capture but the last while offline
      await media.enqueue(rowId, 'photo', blob, `photo-${rowId}`, new Date().toISOString(), localUrl)
    }
  }, [incidentMeta.id, canWriteRecord, media, swapPhoto])

  const uploadMediaForRow = useCallback(async (rowId: string, localUrl: string, kind: 'photo' | 'audio') => {
    if (!canWriteRecord) return
    let blob: Blob
    try {
      blob = await (await fetch(localUrl)).blob()
    } catch { return /* the blob: URL is already gone — nothing to persist */ }
    // A photo is re-encoded BEFORE the first attempt (and therefore before it is queued): the
    // server takes jpeg/png/webp only and a phone hands over a 4–12 MB HEIC, so the upload used
    // to 4xx, retry forever from the offline queue, and the picture quietly never reached the
    // printed Rapport. See lib/imagePrep.
    if (kind === 'photo') blob = await prepareUploadImage(blob)
    try {
      const { url } = await uploadMedia(incidentMeta.id, blob, kind, `${kind}-${rowId}`)
      swapRowMedia(rowId, kind, url, localUrl)
    } catch {
      // offline / server error — keep the blob for later instead of losing it this session
      await media.enqueue(rowId, kind, blob, `${kind}-${rowId}`, new Date().toISOString(), kind === 'photo' ? localUrl : undefined)
    }
  }, [incidentMeta.id, canWriteRecord, media, swapRowMedia])

  /**
   * Rapport-Beilagen: add one or more photos that belong to the REPORT (an ID document, a damage
   * close-up). The row appears immediately with a local blob: URL and swaps to the server URL when
   * the upload lands — same shape as a journal photo, so an offline KP can still assemble the
   * Rapport and the picture catches up. A failed upload leaves the blob: row, and the preflight
   * says «noch nicht hochgeladen» beside it rather than pretending it will print.
   */
  /** what the list says right now, for the handlers that have to read a row before changing it */
  const attachmentsRef = useRef(attachments); attachmentsRef.current = attachments
  const addAttachments = useCallback((files: File[]) => {
    if (!canWriteRecord) return
    const at = new Date().toISOString()
    for (const file of files) {
      const id = newId('att')
      const localUrl = URL.createObjectURL(file)
      void (async () => {
        // the Beilagen list shows a session thumbnail, never the camera file (lib/mediaUrl) —
        // minted before the row appears, so the chip never renders without one
        await mintLocalThumb(localUrl, file)
        setAttachments((list) => [...list, { id, url: localUrl, at }])
        emit('report.attachment.add', { id })
        // ↶ takes the Beilage off again. ⚠️ The box, not a captured row: the upload swaps this
        // row's `blob:` URL for the server one a moment later, and a ↷ that put the local URL
        // back would restore a picture that exists on no other device and after no reload.
        const kept: { row: ReportAttachment } = { row: { id, url: localUrl, at } }
        rememberOneShotRef.current(
          'rapport', appConfig.copy.preflight.attachmentAdded,
          () => setAttachments((list) => { const cur = list.find((a) => a.id === id); if (cur) kept.row = cur; return list.filter((a) => a.id !== id) }),
          () => setAttachments((list) => (list.some((a) => a.id === id) ? list : [...list, kept.row])),
          // a Beilage writes no Verlauf row, so neither does taking it back (D6, 26.09.2026)
          () => [recordKey('attachments', id)],
          'silent',
        )
        try {
          // Re-encode first: the server takes jpeg/png/webp only and a phone hands over HEIC at
          // 4–12 MB, so the raw file 4xx'd and the Beilage silently never printed (lib/imagePrep).
          const blob = await prepareUploadImage(file)
          const { url } = await uploadMedia(incidentMeta.id, blob, 'photo', file.name || 'beilage.jpg')
          setAttachments((list) => list.map((a) => (a.id === id ? { ...a, url } : a)))
          forgetLocalThumb(localUrl)
        } catch (e) {
          // NOT silent: an upload that failed means this Beilage will not be on the paper, and
          // the operator has to hear that while they can still do something about it.
          toast(fillTemplate(appConfig.copy.preflight.attachmentsFailed, { name: file.name || '' }), { icon: 'warn', tone: 'warn' })
          console.warn('Beilage upload failed', e)
        }
      })()
    }
  }, [incidentMeta.id, canWriteRecord, setAttachments, emit, rememberOneShotRef])
  const captionAttachment = useCallback((id: string, caption: string) => {
    if (!canWriteRecord) return
    // Stored AS TYPED. `.trim()` here ran on every keystroke, so the space you pressed was
    // deleted before the next letter arrived — «Ausweis Lenker» came out «AusweisLenker» and a
    // trailing space was impossible. Trimming belongs where the caption is USED (the print
    // payload), not where it is being written.
    const key = `caption:${id}`
    const now = Date.now()
    const prev = lastCaptionStepRef.current
    // still the same Bildlegende, still being typed: take the standing step off the timeline and
    // put back a wider one, so ↶ gives the caption the operator started from — not one letter.
    const folding = prev?.key === key && now - prev.at <= REPORT_COALESCE_MS
    const from = folding ? prev.from : attachmentsRef.current.find((a) => a.id === id)?.caption
    if (folding) prev.drop()
    const to = caption || undefined
    setAttachments((list) => list.map((a) => (a.id === id ? { ...a, caption: to } : a)))
    const drop = rememberOneShotRef.current(
      'rapport', appConfig.copy.preflight.attachmentCaptioned,
      () => setAttachments((list) => list.map((a) => (a.id === id ? { ...a, caption: from } : a))),
      () => setAttachments((list) => list.map((a) => (a.id === id ? { ...a, caption: to } : a))),
      () => [recordKey('attachments', id)],
      'silent',
    )
    lastCaptionStepRef.current = { key, at: now, from, drop }
  }, [canWriteRecord, setAttachments, rememberOneShotRef, lastCaptionStepRef])
  const removeAttachment = useCallback((id: string) => {
    if (!canWriteRecord) return
    // confirm-with-undo, the standing rule for a one-shot that destroys something: the picture
    // and its Bildlegende come back at the index they stood at, and the toast's «Rückgängig»
    // drops the timeline entry so the act can never be taken back twice (see the Gebäude pair).
    const index = attachmentsRef.current.findIndex((a) => a.id === id)
    const row = attachmentsRef.current[index]
    if (!row) return
    setAttachments((list) => list.filter((a) => a.id !== id))
    emit('report.attachment.remove', { id })
    const restore = () => setAttachments((list) => (list.some((a) => a.id === id) ? list : [...list.slice(0, index), row, ...list.slice(index)]))
    const drop = rememberOneShotRef.current(
      'rapport', appConfig.copy.preflight.attachmentRemoved,
      restore, () => setAttachments((list) => list.filter((a) => a.id !== id)),
      () => [recordKey('attachments', id)],
      'silent',
    )
    undoToast(appConfig.copy.preflight.attachmentRemoved, () => { restore(); drop() }, drop.standing)
  }, [canWriteRecord, setAttachments, emit, rememberOneShotRef])

  return { uploadPhotoForRow, uploadMediaForRow, addAttachments, captionAttachment, removeAttachment }
}
