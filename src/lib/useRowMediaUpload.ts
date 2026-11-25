import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import type { ReportAttachment } from '../types'
import type { Dropper, UndoDomain } from './undoTimeline'
import { recordKey, type RecordKey } from './undoKeys'
import type { MediaQueueApi } from './useMediaQueue'
import { prepareUploadImage } from './imagePrep'
import { mintLocalThumb } from './mediaUrl'
import { newId } from './ids'
import { REPORT_COALESCE_MS } from './reportUndo'

interface Args {
  /** this session may write the record domains (IncidentWorkspace · canWriteRecord) */
  canWriteRecord: boolean
  media: MediaQueueApi
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
 * (23.09.2026): a row's photo / Sprachnotiz goes into the durable media queue and from there to
 * the server (its receipt swaps the session blob: URL for the server's), and the Beilagen's add /
 * caption / remove, each one step on the one timeline (a typed caption folds into ONE) and the
 * remove confirm-with-undo.
 *
 * The callbacks' deps include the two ref OBJECTS, which arrive as arguments — stable identities,
 * so nothing re-memoizes. Journal media and Rapport-Beilagen alike enter the durable media queue
 * BEFORE upload. A Beilage's URL swap never recreates a deleted row; kept undo values learn the
 * uploaded URL too.
 */
export function useRowMediaUpload({
  canWriteRecord, media, attachments, setAttachments, emit,
  rememberOneShotRef, lastCaptionStepRef,
}: Args) {
  /**
   * Hand ONE capture of a Verlauf row (a photo of the row's list, or its in-app Sprachnotiz) to
   * the durable media queue, then ask the queue to send it. The upload lands as a receipt, and the
   * receipt links the server URL into the row (useMediaOutbox · linkUploaded), by value: a row
   * with three photos keeps the other two.
   * ⚠️ The bytes are stored BEFORE the upload (hunt 24.11.2026, offline-sync F2). They used to be
   * queued only when the upload failed, so for the whole upload – up to five minutes on a weak
   * link – the capture lived in page memory alone, and a tab killed meanwhile kept the row
   * without its picture or voice memo while the badge said «gespeichert».
   * `slot` is the photo's place in the row as captured (mediaQueue · slot).
   */
  const queueRowCapture = useCallback(async (rowId: string, localUrl: string, kind: 'photo' | 'audio', slot?: number) => {
    if (!canWriteRecord) return
    let blob: Blob
    try {
      blob = await (await fetch(localUrl)).blob()
    } catch { return /* the blob: URL is already gone — nothing to persist */ }
    // A photo is re-encoded BEFORE it is queued: the server takes jpeg/png/webp only and a phone
    // hands over a 4–12 MB HEIC, so the upload used to 4xx, retry forever from the offline queue,
    // and the picture quietly never reached the printed Rapport. See lib/imagePrep.
    if (kind === 'photo') blob = await prepareUploadImage(blob)
    // a photo is keyed by its own blob: URL — a row-wide key made each photo of a multi-photo row
    // evict the previous one; a Sprachnotiz is one per row (mediaQueue · mediaQueueId)
    await media.enqueue(rowId, kind, blob, `${kind}-${rowId}`, new Date().toISOString(), kind === 'photo' ? localUrl : undefined, undefined, undefined, slot)
    void media.flush()
  }, [canWriteRecord, media])
  /** picture `slot` of the row's list */
  const uploadPhotoForRow = useCallback((rowId: string, localUrl: string, slot: number) => queueRowCapture(rowId, localUrl, 'photo', slot), [queueRowCapture])
  /** the row's in-app Sprachnotiz */
  const uploadAudioForRow = useCallback((rowId: string, localUrl: string) => queueRowCapture(rowId, localUrl, 'audio'), [queueRowCapture])

  /**
   * Rapport-Beilagen: add one or more photos that belong to the REPORT (an ID document, a damage
   * close-up). The row appears immediately with a local blob: URL and swaps to the server URL when
   * the upload lands — same shape as a journal photo, so an offline KP can still assemble the
   * Rapport and the picture catches up. A failed upload leaves the blob: row, and the preflight
   * says «noch nicht hochgeladen» beside it rather than pretending it will print.
   */
  /** what the list says right now, for the handlers that have to read a row before changing it */
  const attachmentsRef = useRef(attachments); attachmentsRef.current = attachments
  const keptAttachments = useRef(new Map<string, { row: ReportAttachment }>())
  const swapAttachmentMedia = useCallback((id: string, url: string) => {
    const kept = keptAttachments.current.get(id)
    if (kept) kept.row = { ...kept.row, url }
    setAttachments((list) => list.map((a) => (a.id === id ? { ...a, url } : a)))
  }, [setAttachments])
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
        const blob = await prepareUploadImage(file)
        const kept: { row: ReportAttachment } = { row: { id, url: localUrl, at } }
        keptAttachments.current.set(id, kept)
        setAttachments((list) => [...list, kept.row])
        emit('report.attachment.add', { id })
        // ↶ takes the Beilage off again. ⚠️ The box, not a captured row: the upload swaps this
        // row's `blob:` URL for the server one a moment later, and a ↷ that put the local URL
        // back would restore a picture that exists on no other device and after no reload.
        rememberOneShotRef.current(
          'rapport', appConfig.copy.preflight.attachmentAdded,
          () => setAttachments((list) => { const cur = list.find((a) => a.id === id); if (cur) kept.row = cur; return list.filter((a) => a.id !== id) }),
          () => setAttachments((list) => (list.some((a) => a.id === id) ? list : [...list, kept.row])),
          () => [recordKey('attachments', id)],
          // a Beilage writes no Verlauf row, so neither does taking it back (D6, 26.09.2026)
          'silent',
        )
        // Persist the actual prepared bytes before attempting the network. An upload failure
        // used to leave ONLY a blob: URL, so a reload destroyed the Rapport's only picture.
        // The shared status reports pending/error/storage, and the queue retries on reconnect.
        await media.enqueue(id, 'photo', blob, file.name || 'beilage.jpg', at, localUrl, 'attachment')
        void media.flush()
      })()
    }
  }, [canWriteRecord, media, setAttachments, emit, rememberOneShotRef])
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
    // a one-shot on the ↶ timeline: the picture and its Bildlegende come back at the index they
    // stood at
    const index = attachmentsRef.current.findIndex((a) => a.id === id)
    const row = attachmentsRef.current[index]
    if (!row) return
    setAttachments((list) => list.filter((a) => a.id !== id))
    emit('report.attachment.remove', { id })
    const kept = keptAttachments.current.get(id) ?? { row }
    kept.row = row
    keptAttachments.current.set(id, kept)
    const restore = () => setAttachments((list) => (list.some((a) => a.id === id) ? list : [...list.slice(0, index), kept.row, ...list.slice(index)]))
    // the header's ↶ brings it back (no toast, owner pick 28, 17.11.2026)
    rememberOneShotRef.current(
      'rapport', appConfig.copy.preflight.attachmentRemoved,
      restore, () => setAttachments((list) => list.filter((a) => a.id !== id)),
      () => [recordKey('attachments', id)],
      'silent',
    )
  }, [canWriteRecord, setAttachments, emit, rememberOneShotRef])

  return { uploadPhotoForRow, uploadAudioForRow, addAttachments, captionAttachment, removeAttachment, swapAttachmentMedia }
}
