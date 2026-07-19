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
}

/**
 * `onClip` fires once a recording finishes, with its object-URL + duration. It is read
 * through a ref so the latest closure is always used (no stale captures), while still
 * letting the caller snapshot any start-time context it needs before calling `start()`.
 */
export function useVoiceMemo(onClip: (clip: { url: string; secs: number }) => void): VoiceMemo {
  const recRef = useRef<{ rec: MediaRecorder } | null>(null)
  const stopWhenReady = useRef(false)
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
    stopWhenReady.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream); const chunks: Blob[] = []
      const startedAt = Date.now()
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false); setRecStartedAt(null)
        const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
        const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
        onClipRef.current({ url, secs })
      }
      recRef.current = { rec }; setRecStartedAt(startedAt); setRecording(true); rec.start()
      if (stopWhenReady.current) rec.stop() // stop tapped before the mic was granted
    } catch { toast(appConfig.copy.toast.micDenied, { icon: 'mic', tone: 'warn' }) }
  }
  const stop = () => { if (recRef.current?.rec.state === 'recording') recRef.current.rec.stop(); else stopWhenReady.current = true }

  return { recording, recStartedAt, start, stop }
}
