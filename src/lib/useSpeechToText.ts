import { useCallback, useEffect, useRef, useState } from 'react'

// Minimal Web Speech API typings — these live in lib.dom in some TS configs but not all,
// so we declare just the surface we use here rather than relying on the ambient types.
interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}
interface SpeechRecognitionResult {
  readonly length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
  isFinal: boolean
}
interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}
interface SpeechRecognitionErrorEventLike extends Event {
  error: string
  message: string
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface SpeechToText {
  /** Whether the browser exposes the Web Speech API at all. */
  supported: boolean
  /** Whether dictation is currently active. */
  listening: boolean
  /** Best-effort recognized text since the last start() — final + live interim. */
  transcript: string
  start: () => void
  stop: () => void
}

// Wraps the Web Speech API for German dictation (de-CH, falling back to de-DE if the
// engine rejects the Swiss locale). `continuous` + `interimResults` give live partials.
// `transcript` accumulates finalized segments and surfaces the current interim tail;
// it resets on each start(). Degrades to a no-op (supported: false) where the API is
// missing (Firefox; older/embedded Safari).
export function useSpeechToText(lang = 'de-CH'): SpeechToText {
  const Ctor = getRecognitionCtor()
  const supported = Ctor != null

  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')

  const recRef = useRef<SpeechRecognitionLike | null>(null)
  // committed = all finalized text so far. processed = how many result slots we've already folded
  // into it, so a result is appended EXACTLY ONCE no matter how often the engine re-fires it (the
  // Android "replay finals on every interim/restart" bug that was duplicating the text). lastLen
  // spots a genuine new session (results shrink) so we resync instead of dropping its first words.
  const committedRef = useRef('')
  const processedRef = useRef(0)
  const lastLenRef = useRef(0)
  const triedFallbackRef = useRef(false)
  // Track intentional stops so onend doesn't flip listening back/forth unexpectedly.
  const wantListeningRef = useRef(false)

  const stop = useCallback(() => {
    wantListeningRef.current = false
    const rec = recRef.current
    if (rec) {
      try { rec.stop() } catch { /* not started */ }
    }
    setListening(false)
  }, [])

  const start = useCallback(() => {
    if (!Ctor) return
    // Already running — don't start a second recognizer.
    if (recRef.current && wantListeningRef.current) return

    committedRef.current = ''
    processedRef.current = 0
    lastLenRef.current = 0
    triedFallbackRef.current = false
    setTranscript('')

    const begin = (useLang: string) => {
      const rec = new Ctor()
      rec.lang = useLang
      rec.continuous = true
      rec.interimResults = true
      rec.maxAlternatives = 1

      rec.onresult = (e) => {
        const results = e.results
        // a real new session (the engine cleared its list) → resync our slot counter so we don't
        // skip the new session's first words
        if (results.length < processedRef.current) processedRef.current = 0
        lastLenRef.current = results.length
        // fold each FINAL slot into `committed` exactly once (slots below `processed` are already
        // done — re-fired/replayed results are simply skipped, so nothing is ever appended twice)
        let interim = ''
        for (let i = 0; i < results.length; i++) {
          const text = results[i][0]?.transcript ?? ''
          if (results[i].isFinal) {
            if (i >= processedRef.current) { committedRef.current += text; processedRef.current = i + 1 }
          } else {
            interim += text
          }
        }
        setTranscript((committedRef.current + interim).replace(/\s+/g, ' ').trimStart())
      }

      rec.onerror = (e) => {
        // de-CH isn't recognized everywhere — fall back once to de-DE on a language error.
        if (
          (e.error === 'language-not-supported' || e.error === 'bad-grammar') &&
          !triedFallbackRef.current &&
          useLang !== 'de-DE'
        ) {
          triedFallbackRef.current = true
          try { rec.abort() } catch { /* noop */ }
          begin('de-DE')
          return
        }
        wantListeningRef.current = false
        setListening(false)
      }

      rec.onend = () => {
        // Engine auto-stopped on a pause but we still want to listen → re-start the SAME instance
        // (NOT a fresh one — overlapping recognizers each transcribe the same audio, which made the
        // duplication far worse). The `processed` slot counter above carries across the restart, so
        // an engine that replays its old results on restart no longer re-appends them.
        if (wantListeningRef.current) {
          try { rec.start() } catch { wantListeningRef.current = false; setListening(false) }
          return
        }
        setListening(false)
      }

      recRef.current = rec
      try {
        rec.start()
        wantListeningRef.current = true
        setListening(true)
      } catch {
        wantListeningRef.current = false
        setListening(false)
      }
    }

    begin(lang)
  }, [Ctor, lang])

  // Tear down the recognizer on unmount.
  useEffect(() => {
    return () => {
      wantListeningRef.current = false
      const rec = recRef.current
      if (rec) {
        rec.onresult = null
        rec.onerror = null
        rec.onend = null
        try { rec.abort() } catch { /* noop */ }
      }
      recRef.current = null
    }
  }, [])

  return { supported, listening, transcript, start, stop }
}
