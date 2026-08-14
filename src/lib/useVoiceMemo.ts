import { useEffect, useRef, useState } from 'react'
import { toast } from './ui'
import { appConfig } from '../config/appConfig'

// Voice-memo recording lifecycle, extracted from App's god component. Owns the
// MediaRecorder + mic stream and guarantees the mic is released on stop/unmount. The
// caller persists the finished clip (journal row, upload, audit emit) via `onClip`.

export interface VoiceMemo {
  recording: boolean
  recStartedAt: number | null
  /** hold-to-start (latches); no-op if already recording */
  start: () => Promise<void>
  /** tap-to-stop; if the mic grant is still pending, stops as soon as it arrives */
  stop: () => void
  /** THROW the memo away — no clip, no journal row, mic released. The hold gesture starts
   *  recording the moment it latches; sliding onto «Foto» instead has to undo that, and a
   *  two-second clip of somebody deciding is not a record of anything. */
  cancel: () => void
}

/**
 * `onClip` fires once a recording finishes, with its object-URL + duration. It is read
 * through a ref so the latest closure is always used (no stale captures), while still
 * letting the caller snapshot any start-time context it needs before calling `start()`.
 */
export function useVoiceMemo(onClip: (clip: { url: string; secs: number }) => void): VoiceMemo {
  const recRef = useRef<{ rec: MediaRecorder } | null>(null)
  const stopWhenReady = useRef(false)
  /** set by `cancel` so the recorder's own `onstop` tears down without minting a clip */
  const cancelled = useRef(false)
  const [recording, setRecording] = useState(false)
  const [recStartedAt, setRecStartedAt] = useState<number | null>(null)
  const onClipRef = useRef(onClip)
  useEffect(() => { onClipRef.current = onClip }) // keep the latest callback (no stale capture)

  // Stop any in-progress memo + release the mic when the component unmounts (e.g. an
  // incident switch), so the microphone never stays hot in the background.
  useEffect(() => () => {
    const r = recRef.current?.rec
    if (!r) return
    r.onstop = null // drop the side effects — we're tearing down
    try { if (r.state !== 'inactive') r.stop() } catch { /* already stopped */ }
    r.stream?.getTracks().forEach((t) => t.stop())
    recRef.current = null
  }, [])

  const start = async () => {
    if (recording) return
    // ⚠️ BOTH flags, every time. A cancel whose recorder was already inactive never fires
    // `onstop`, so `cancelled` would still be set here and the next memo — a real one — would
    // be thrown away in silence. Whatever the last gesture left behind, a fresh start owns it.
    stopWhenReady.current = false
    cancelled.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream); const chunks: Blob[] = []
      const startedAt = Date.now()
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false); setRecStartedAt(null)
        // thrown away rather than saved (see `cancel`) — the mic is released above either way,
        // but no clip is minted and nobody is told about a recording that was abandoned
        if (cancelled.current) { cancelled.current = false; return }
        const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
        const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
        onClipRef.current({ url, secs })
      }
      recRef.current = { rec }; setRecStartedAt(startedAt); setRecording(true); rec.start()
      if (stopWhenReady.current) rec.stop() // stop tapped before the mic was granted
    } catch { toast(appConfig.copy.toast.micDenied, { icon: 'mic', tone: 'warn' }) }
  }
  const stop = () => { if (recRef.current?.rec.state === 'recording') recRef.current.rec.stop(); else stopWhenReady.current = true }
  // ⚠️ A FLAG, not `r.onstop = null`. Detaching the handler would also skip the mic release and
  // the state reset that live inside it — and reassigning a field on the recorder held in a ref
  // is the mutation the immutability lint objects to. `onstop` still runs and still tears down;
  // it just does not mint a clip. `stopWhenReady` is cleared too, or a mic grant that lands
  // after the cancel would start a recording nobody asked for.
  const cancel = () => {
    stopWhenReady.current = false
    const r = recRef.current?.rec
    if (!r) { setRecording(false); setRecStartedAt(null); return }
    cancelled.current = true
    recRef.current = null
    try { if (r.state !== 'inactive') r.stop() } catch { /* already stopped — onstop will not run */ }
    setRecording(false); setRecStartedAt(null)
  }

  return { recording, recStartedAt, start, stop, cancel }
}
