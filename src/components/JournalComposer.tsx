import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { Segmented } from './Segmented'
import { Overlay } from '../lib/overlays'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { acceptPhrase, suggestPhrases } from '../lib/quickPhrases'
import { fillTemplate, formatTime } from '../lib/format'
import { toast } from '../lib/ui'
import { ApiError } from '../lib/api'
import {
  AUDIO_IMPORT_ACCEPT,
  MAX_AUDIO_UPLOAD_MB,
  formatAudioDuration,
  probeAudioDuration,
  resolveRecordingStart,
  validateAudioImport,
} from '../lib/audioImport'
import type { TimelineEvent } from '../types'
import { useHoldRepeat } from '../lib/useHoldRepeat'
import { useTapToType } from '../lib/useTapToType'
import { useKeyboardInset } from '../lib/useKeyboardInset'

// `C` (appConfig.copy.journal) is read at the top of each component below rather than captured
// here at module-load, so the locale resolved at boot (config/copy) applies.
const MIN_STEP = 1 // exact-time minute granularity (hold the ± to repeat-fast)
const pad2 = (n: number) => String(n).padStart(2, '0')

export interface JournalDraft {
  text: string
  audioUrl?: string
  secs?: number
  /** structured audio metadata; for an imported memo audioUrl is already the SERVER url
   *  (upload happened during save) and startedAt is the operator-confirmed recording start */
  audioMeta?: TimelineEvent['audioMeta']
  photoUrl?: string
  pin: boolean
  /** set in Wiedervorlage mode: ISO time this entry becomes due (makes it a reminder) */
  dueAt?: string
}

// Wiedervorlage due selection: a relative "+N min" chip, or an exact wall-clock time.
type DueSel = { kind: 'in'; mins: number } | { kind: 'at'; hhmm: string } | null

function resolveDueAt(sel: DueSel): string | null {
  if (!sel) return null
  if (sel.kind === 'in') return new Date(Date.now() + sel.mins * 60_000).toISOString()
  const [h, m] = sel.hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  const d = new Date(); d.setHours(h, m, 0, 0)
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1) // a past time means the next occurrence
  return d.toISOString()
}

// default exact time when the Uhrzeit chip is first chosen: ~5 min out, snapped to the grid
function defaultExactHHMM(): string {
  const d = new Date(Date.now() + 5 * 60_000)
  d.setMinutes(Math.ceil(d.getMinutes() / MIN_STEP) * MIN_STEP, 0, 0)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// the resolved due rolled to tomorrow (an exact time earlier than now → next day)
function isNextDay(iso: string): boolean {
  const due = new Date(iso); const today = new Date()
  return due.getDate() !== today.getDate() || due.getMonth() !== today.getMonth()
}

// Custom HH:MM stepper — replaces the native <input type="time"> (whose OS spinner clashed with
// the dark UI). ± hours/minutes via the shared hold-repeat steppers; both columns wrap.
function TimeStepper({ hhmm, onChange }: { hhmm: string; onChange: (v: string) => void }) {
  const C = appConfig.copy.journal // read per-render so the resolved locale applies
  const [h, m] = hhmm.split(':').map(Number)
  const set = (nh: number, nm: number) => onChange(`${pad2((nh + 24) % 24)}:${pad2((nm + 60) % 60)}`)
  const hDec = useHoldRepeat(() => set(h - 1, m))
  const hInc = useHoldRepeat(() => set(h + 1, m))
  const mDec = useHoldRepeat(() => set(h, m - MIN_STEP))
  const mInc = useHoldRepeat(() => set(h, m + MIN_STEP))
  // tap either column's value to type it (commit wraps modulo, like the ± buttons)
  const hEdit = useTapToType({ min: 0, max: 23, onCommit: (v) => set(v, m) })
  const mEdit = useTapToType({ min: 0, max: 59, onCommit: (v) => set(h, v) })
  return (
    <div className="jc-time">
      <div className="jc-time-col">
        <button type="button" className="jc-time-btn" aria-label={C.hourUp} {...hInc}><Icon id="chevron-up" /></button>
        {hEdit.editing
          ? <input className="jc-time-input" aria-label={C.hourUp} {...hEdit.inputProps} />
          : <button type="button" className="jc-time-val" onClick={() => hEdit.start(h)} title="Tippen zum Eingeben">{pad2(h)}</button>}
        <button type="button" className="jc-time-btn" aria-label={C.hourDown} {...hDec}><Icon id="chevron-down" /></button>
      </div>
      <span className="jc-time-sep">:</span>
      <div className="jc-time-col">
        <button type="button" className="jc-time-btn" aria-label={C.minUp} {...mInc}><Icon id="chevron-up" /></button>
        {mEdit.editing
          ? <input className="jc-time-input" aria-label={C.minUp} {...mEdit.inputProps} />
          : <button type="button" className="jc-time-val" onClick={() => mEdit.start(m)} title="Tippen zum Eingeben">{pad2(m)}</button>}
        <button type="button" className="jc-time-btn" aria-label={C.minDown} {...mDec}><Icon id="chevron-down" /></button>
      </div>
    </div>
  )
}

// Quick-add for the unified journal: a free-text note and/or a voice memo,
// optionally pinned to the current view. Reachable from both surfaces (mounted
// at app level), it records its own clip so the audio is attached to the entry
// rather than auto-logged. `surface` only drives the pin label + default.
export function JournalComposer({ surface, onSubmit, onClose, incidentStartAt, uploadAudio }: {
  surface: 'map' | 'plan'
  onSubmit: (d: JournalDraft) => void
  onClose: () => void
  /** alarm/start time of the incident — prefill for the imported memo's «Aufnahme begann» */
  incidentStartAt?: string
  /** uploads an imported memo during save (large files never enter the offline queue) */
  uploadAudio?: (blob: Blob, filename: string) => Promise<{ url: string }>
}) {
  const C = appConfig.copy.journal // read per-render so the resolved locale applies
  // station Textbausteine over the national defaults (deployment config wins when set)
  const quickPhrases = getDeploymentConfig().journal?.quickPhrases?.length
    ? getDeploymentConfig().journal!.quickPhrases!
    : appConfig.journal.quickPhrases
  const [text, setText] = useState('')
  const suggestions = useMemo(() => suggestPhrases(text, quickPhrases), [text, quickPhrases])
  const textRef = useRef<HTMLTextAreaElement>(null)
  // Accepting a Textbaustein must keep the operator in the writing flow: textarea stays
  // focused (tablet keyboard stays up) with the caret right after the inserted phrase,
  // ready to type on. rAF so the refocus runs after React committed the new value.
  const accept = (phrase: string) => {
    setText((t) => acceptPhrase(t, phrase))
    requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }
  const [mode, setMode] = useState<'entry' | 'reminder'>('entry')
  const [dueSel, setDueSel] = useState<DueSel>(null)
  const dueAt = mode === 'reminder' ? resolveDueAt(dueSel) : undefined
  const [pin, setPin] = useState(false)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [clip, setClip] = useState<{ url: string; secs: number; startedAt: string } | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  // imported external voice memo (Voice Memos → Files → picker); mutually exclusive with `clip`
  const [imported, setImported] = useState<{
    file: File; url: string; name: string; durationSec: number | null; contentType: string
  } | null>(null)
  const [startHHMM, setStartHHMM] = useState(() => {
    const d = incidentStartAt ? new Date(incidentStartAt) : new Date()
    return Number.isNaN(d.getTime()) ? `${pad2(new Date().getHours())}:${pad2(new Date().getMinutes())}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  })
  // hard gate (2026-07-15 decision): save stays disabled until the operator edits the
  // stepper or explicitly confirms — the row lands at this time in the Verlauf
  const [startConfirmed, setStartConfirmed] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [clipPlaying, setClipPlaying] = useState(false)
  const clipAudio = useRef<HTMLAudioElement | null>(null)
  // recorded clip and imported memo are exclusive, so one preview player serves both
  const previewUrl = clip?.url ?? imported?.url ?? null
  const toggleClip = () => {
    if (!previewUrl) return
    if (clipPlaying && clipAudio.current) { clipAudio.current.pause(); setClipPlaying(false); return }
    const a = new Audio(previewUrl)
    clipAudio.current = a
    a.onended = () => setClipPlaying(false)
    a.onpause = () => setClipPlaying(false)
    void a.play().then(() => setClipPlaying(true)).catch(() => setClipPlaying(false))
  }
  const recRef = useRef<{ rec: MediaRecorder; startedAt: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const audioFileRef = useRef<HTMLInputElement>(null)
  // closing the composer mid-upload means "cancel": the upload may finish server-side (the
  // orphaned blob is harmless) but no journal row is created after unmount. The unmount also
  // revokes the imported preview URL — saves/closes must not pin up to 100 MB per import.
  const alive = useRef(true)
  const importedUrlRef = useRef<string | null>(null)
  importedUrlRef.current = imported?.url ?? null
  useEffect(() => () => {
    alive.current = false
    if (importedUrlRef.current) URL.revokeObjectURL(importedUrlRef.current)
  }, [])

  // In-app voice-to-text dictation was removed — use the native OS keyboard dictation
  // (e.g. iPadOS mic key) to fill the text field instead.

  // live recording timer
  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => { const s = recRef.current; if (s) setElapsed(Math.round((Date.now() - s.startedAt) / 1000)) }, 250)
    return () => clearInterval(id)
  }, [recording])

  // stop any in-flight recording + release the stream when the composer unmounts
  useEffect(() => () => { try { recRef.current?.rec.stop() } catch { /* already stopped */ } }, [])

  const toggleRecord = async () => {
    if (recording) { recRef.current?.rec.stop(); return }
    discardImport() // one audio per entry — a fresh recording replaces an imported memo
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream); const chunks: Blob[] = []
      const startedAt = Date.now()
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
        setClip({ url, secs: Math.max(1, Math.round((Date.now() - startedAt) / 1000)), startedAt: new Date(startedAt).toISOString() })
        setRecording(false); setElapsed(0)
      }
      recRef.current = { rec, startedAt }; setRecording(true); rec.start()
    } catch { toast(appConfig.copy.toast.micDenied, { icon: 'mic', tone: 'warn' }) }
  }

  const discardClip = () => { clipAudio.current?.pause(); setClipPlaying(false); if (clip) URL.revokeObjectURL(clip.url); setClip(null) }
  const discardImport = () => {
    clipAudio.current?.pause(); setClipPlaying(false)
    setImported((cur) => { if (cur) URL.revokeObjectURL(cur.url); return null })
    setStartConfirmed(false)
  }

  const pickSeq = useRef(0)
  const importAudioFile = async (f: File) => {
    const v = validateAudioImport(f)
    if (!v.ok) {
      toast(v.reason === 'size' ? fillTemplate(C.audioTooLarge, { max: MAX_AUDIO_UPLOAD_MB }) : C.audioUnsupported, { icon: 'warn', tone: 'warn' })
      return
    }
    discardClip(); discardImport() // one audio per entry — the new pick replaces both
    const seq = ++pickSeq.current
    const url = URL.createObjectURL(f)
    const durationSec = await probeAudioDuration(url)
    // a slow probe must not resurrect a pick the operator already replaced
    if (seq !== pickSeq.current || !alive.current) { URL.revokeObjectURL(url); return }
    setImported({ file: f, url, name: f.name, durationSec, contentType: v.contentType })
  }
  const onAudioPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''
    if (f) void importAudioFile(f)
  }

  // Pasting a copied Voice Memo (or photo) is the easier mobile path than the Files detour —
  // handled on the composer root so a paste into the textarea bubbles here too.
  const onPaste = (e: React.ClipboardEvent) => {
    if (mode !== 'entry') return
    const files = Array.from(e.clipboardData?.files ?? [])
    const audio = files.find((f) => f.type.startsWith('audio/') || /\.m4a$/i.test(f.name))
    const image = files.find((f) => f.type.startsWith('image/'))
    if (!audio && !image) return // plain text paste stays with the textarea
    e.preventDefault()
    if (audio) void importAudioFile(audio)
    else if (image) { if (photo) URL.revokeObjectURL(photo); setPhoto(URL.createObjectURL(image)) }
  }

  // recording start resolved to the most recent past occurrence (no date picker by design)
  const importStartAt = imported ? resolveRecordingStart(startHHMM) : null

  // Upload during save (2026-07-15 decision): the row is only created once the server URL
  // exists — an imported memo never enters the offline IndexedDB queue, so offline is an
  // explicit refusal and a failed upload keeps the composer open for a retry.
  const submitImported = async () => {
    if (!imported || !uploadAudio) return
    // resolve at SAVE time — the render-time value can carry a stale day-rollover decision
    // (e.g. 23:50 entered at 23:49 rolled to yesterday, but the operator saves at 23:52)
    const startAt = resolveRecordingStart(startHHMM)
    if (!startAt) return
    if (!navigator.onLine) { toast(C.audioOffline, { icon: 'warn', tone: 'warn' }); return }
    setUploading(true)
    try {
      // re-wrap when the picker's MIME needed normalising (empty/x-wav) so the backend
      // allowlist sees a supported content type
      const blob = imported.file.type === imported.contentType
        ? imported.file
        : new File([imported.file], imported.name, { type: imported.contentType })
      const { url } = await uploadAudio(blob, imported.name)
      if (!alive.current) return // closed mid-upload — cancelled, no row
      onSubmit({
        text: text.trim(), pin, photoUrl: photo ?? undefined,
        audioUrl: url, secs: imported.durationSec ?? undefined,
        audioMeta: {
          source: 'imported', startedAt: startAt.toISOString(),
          durationSec: imported.durationSec ?? undefined, originalName: imported.name,
        },
      })
    } catch (e) {
      if (!alive.current) return
      const msg = e instanceof ApiError && e.status === 413 ? fillTemplate(C.audioTooLarge, { max: MAX_AUDIO_UPLOAD_MB })
        : e instanceof ApiError && e.status === 415 ? C.audioUnsupported
        : C.audioUploadFailed
      toast(msg, { icon: 'warn', tone: 'warn' })
      setUploading(false)
    }
  }

  const onPhotoPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    if (photo) URL.revokeObjectURL(photo)
    setPhoto(URL.createObjectURL(f)); e.target.value = ''
  }
  const discardPhoto = () => { if (photo) URL.revokeObjectURL(photo); setPhoto(null) }

  const canSend = mode === 'reminder'
    ? text.trim().length > 0 && !!dueAt
    : imported != null
      // hard gate: an imported memo saves only with a confirmed, valid start time
      ? startConfirmed && importStartAt != null && !uploading
      : text.trim().length > 0 || (mode === 'entry' && (clip != null || photo != null))
  const submit = () => {
    if (!canSend || uploading) return
    if (mode === 'reminder') { onSubmit({ text: text.trim(), pin: false, dueAt: dueAt! }); return }
    if (imported) { void submitImported(); return }
    onSubmit({
      text: text.trim(), audioUrl: clip?.url, secs: clip?.secs, photoUrl: photo ?? undefined, pin,
      audioMeta: clip ? { source: 'recorded', startedAt: clip.startedAt, durationSec: clip.secs } : undefined,
    })
  }

  const kbInset = useKeyboardInset()
  return (
    // <Overlay> (Base UI) owns focus-trap + scroll-lock + backdrop-close; its pointerdown-based
    // outside-press already ignores the opening tap, so the old Android `armed` delay is gone.
    // dismissEscape=false: the composer holds unsaved text — Esc must not discard it (parity with
    // the old surface, which never closed on Esc). The keyboard inset lifts the phone bottom sheet.
    <Overlay open onClose={onClose} className="journal-composer" backdropClassName="modal-backdrop"
      ariaLabel={C.composerTitle} dismissEscape={false} initialFocus={textRef} style={{ marginBottom: kbInset }}>
      <div onPaste={onPaste} style={{ display: 'contents' }}>
        <div className="jc-head">
          <span className="jc-title"><Icon id={mode === 'reminder' ? 'clock' : 'type'} />{mode === 'reminder' ? C.modeReminder : C.composerTitle}</span>
          <button className="journal-x" title={appConfig.copy.closeDialog} aria-label={appConfig.copy.closeDialog} onClick={onClose}><Icon id="close" /></button>
        </div>

        {/* mode: a normal Eintrag, or a time-due Wiedervorlage (reminder) */}
        <div className="jc-mode">
          <Segmented
            ariaLabel={C.composerTitle}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'entry', label: <><Icon id="type" />{C.modeEntry}</> },
              { value: 'reminder', label: <><Icon id="clock" />{C.modeReminder}</> },
            ]}
          />
        </div>

        <textarea
          ref={textRef}
          className="jc-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={mode === 'reminder' ? C.reminderTextPlaceholder : C.textPlaceholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
            // Tab accepts the top Textbaustein suggestion (keyboard path; touch just taps)
            else if (e.key === 'Tab' && suggestions.length > 0) {
              e.preventDefault()
              accept(suggestions[0].phrase)
            }
          }}
        />

        {/* Textbausteine as autocomplete (2026-07-02 decision: no static chip row) — while
            typing, the current fragment fuzzy-matches the station's phrase list and the best
            completions appear here; tap (or Tab for the first) replaces the fragment. */}
        {suggestions.length > 0 && (
          <div className="jc-phrases" role="group" aria-label={C.quickPhrasesAria}>
            {suggestions.map((m) => (
              <button
                key={m.phrase}
                className="jc-phrase"
                // keep the textarea focused through the tap — no blur, no keyboard close
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => accept(m.phrase)}
              >{m.phrase}</button>
            ))}
          </div>
        )}

        {mode === 'reminder' && (
          <div className="jc-due">
            <span className="jc-due-label">{C.reminderWhen}</span>
            <div className="jc-due-chips">
              {C.reminderChips.map((n) => (
                <button
                  key={n}
                  className={`jc-due-chip ${dueSel?.kind === 'in' && dueSel.mins === n ? 'on' : ''}`}
                  onClick={() => setDueSel({ kind: 'in', mins: n })}
                >{C.reminderChipLabel.replace('{n}', String(n))}</button>
              ))}
              <button
                className={`jc-due-chip ${dueSel?.kind === 'at' ? 'on' : ''}`}
                onClick={() => setDueSel((s) => (s?.kind === 'at' ? s : { kind: 'at', hhmm: defaultExactHHMM() }))}
              ><Icon id="clock" />{C.reminderExact}</button>
            </div>
            {dueSel?.kind === 'at' && (
              <TimeStepper hhmm={dueSel.hhmm} onChange={(hhmm) => setDueSel({ kind: 'at', hhmm })} />
            )}
            {dueAt && (
              <span className="jc-due-preview">
                <Icon id="check" />{formatTime(new Date(dueAt))}
                {isNextDay(dueAt) && <em>{C.reminderTomorrow}</em>}
              </span>
            )}
          </div>
        )}

        {/* media: record a voice memo or attach a photo (entry mode only — a Wiedervorlage is text + due) */}
        {mode === 'entry' && (<>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhotoPicked} />
          <input ref={audioFileRef} type="file" accept={AUDIO_IMPORT_ACCEPT} hidden onChange={(e) => void onAudioPicked(e)} />
          <div className="jc-audio">
            <button className={`jc-rec ${recording ? 'on' : ''}`} onClick={toggleRecord} title={recording ? C.recordStop : C.record}>
              <Icon id="mic" />{recording ? `${C.recordStop} · ${elapsed}s` : C.record}
            </button>
            <button className="jc-rec" onClick={() => audioFileRef.current?.click()} title={C.audioUpload}><Icon id="upload" />{C.audioUpload}</button>
            <button className="jc-rec" onClick={() => fileRef.current?.click()} title={C.photo}><Icon id="cam" />{C.photo}</button>
            {clip && (
              <span className="jc-clip">
                <button className={`tl-play ${clipPlaying ? 'playing' : ''}`} title={clipPlaying ? C.recordStop : appConfig.copy.play} aria-label={clipPlaying ? C.recordStop : appConfig.copy.play} onClick={toggleClip}><Icon id={clipPlaying ? 'pause' : 'play'} /></button>
                <span className="jc-clip-len">{clip.secs}s</span>
                <button className="jc-clip-x" title={C.discardAudio} aria-label={C.discardAudio} onClick={discardClip}><Icon id="close" /></button>
              </span>
            )}
          </div>
          {imported && (
            <div className="jc-import">
              <div className="jc-import-row">
                <button className={`tl-play ${clipPlaying ? 'playing' : ''}`} title={clipPlaying ? C.recordStop : appConfig.copy.play} aria-label={clipPlaying ? C.recordStop : appConfig.copy.play} onClick={toggleClip}><Icon id={clipPlaying ? 'pause' : 'play'} /></button>
                <span className="jc-import-name">
                  <strong>{C.audioImportLabel}</strong>
                  <em>{imported.name}{imported.durationSec != null ? ` · ${formatAudioDuration(imported.durationSec)}` : ''}</em>
                </span>
                <button className="jc-clip-x" title={C.audioDiscardImport} aria-label={C.audioDiscardImport} onClick={discardImport}><Icon id="close" /></button>
              </div>
              <div className="jc-import-start">
                <span className="jc-due-label">{C.audioStartLabel}</span>
                <TimeStepper hhmm={startHHMM} onChange={(v) => { setStartHHMM(v); setStartConfirmed(true) }} />
                <button className={`jc-due-chip ${startConfirmed ? 'on' : ''}`} aria-pressed={startConfirmed} onClick={() => setStartConfirmed(true)}>
                  <Icon id="check" />{C.audioStartConfirm}
                </button>
              </div>
              <p className="jc-import-hint">{C.audioStartHint}</p>
            </div>
          )}
          {photo && (
            <div className="jc-photo">
              <img src={photo} alt="" />
              <button className="jc-clip-x" title={C.discardPhoto} aria-label={C.discardPhoto} onClick={discardPhoto}><Icon id="close" /></button>
            </div>
          )}
        </>)}

        <div className="jc-foot">
          {mode === 'entry' ? (
            <button className={`jc-pin ${pin ? 'on' : ''}`} aria-pressed={pin} onClick={() => setPin((v) => !v)}>
              <Icon id="coords" />{surface === 'plan' ? C.pinPlan : C.pinMap}
            </button>
          ) : <span className="jc-pin-spacer" />}
          <button className="jc-send" disabled={!canSend || uploading} onClick={submit}>
            <Icon id="check" />{uploading ? C.audioUploading : mode === 'reminder' ? C.reminderSend : C.send}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
