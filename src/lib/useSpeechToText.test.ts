// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSpeechToText } from './useSpeechToText'

// A scriptable stand-in for the browser SpeechRecognition object. Tests drive recognition
// by calling .emitResult()/.emitError()/.emitEnd() on the most recently constructed instance.
class FakeRecognition {
  static instances: FakeRecognition[] = []
  static last() { return FakeRecognition.instances[FakeRecognition.instances.length - 1] }

  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 1
  started = false
  aborted = false
  onresult: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onend: (() => void) | null = null

  constructor() { FakeRecognition.instances.push(this) }
  start() { this.started = true }
  stop() { this.started = false; this.onend?.() }
  abort() { this.aborted = true; this.started = false }

  emitResult(segments: { transcript: string; isFinal: boolean }[]) {
    const results = segments.map((s) => {
      const r = [{ transcript: s.transcript, confidence: 1 }] as unknown as {
        0: { transcript: string }
        isFinal: boolean
        length: number
      }
      r.isFinal = s.isFinal
      r.length = 1
      return r
    })
    ;(results as unknown as { length: number }).length = segments.length
    this.onresult?.({ resultIndex: 0, results })
  }
  emitError(error: string) { this.onerror?.({ error, message: '' }) }
  emitEnd() { this.onend?.() } // engine auto-stopped (e.g. a speech pause)
}

function installApi() {
  FakeRecognition.instances = []
  ;(window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
}
function removeApi() {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
}

afterEach(() => removeApi())

describe('useSpeechToText', () => {
  it('reports unsupported when no Web Speech API is present', () => {
    removeApi()
    const { result } = renderHook(() => useSpeechToText())
    expect(result.current.supported).toBe(false)
    // start() is a safe no-op when unsupported
    act(() => result.current.start())
    expect(result.current.listening).toBe(false)
  })

  describe('with the API available', () => {
    beforeEach(() => installApi())

    it('starts a continuous de-CH recognizer and sets listening', () => {
      const { result } = renderHook(() => useSpeechToText())
      expect(result.current.supported).toBe(true)
      act(() => result.current.start())
      const rec = FakeRecognition.last()
      expect(rec.lang).toBe('de-CH')
      expect(rec.continuous).toBe(true)
      expect(rec.interimResults).toBe(true)
      expect(rec.started).toBe(true)
      expect(result.current.listening).toBe(true)
    })

    it('accumulates final results and surfaces interim text', () => {
      const { result } = renderHook(() => useSpeechToText())
      act(() => result.current.start())
      const rec = FakeRecognition.last()
      act(() => rec.emitResult([{ transcript: 'Hallo Welt ', isFinal: true }]))
      // trailing space from a finalized segment is preserved so the next segment appends cleanly
      expect(result.current.transcript).toBe('Hallo Welt ')
      // the real API's results list is CUMULATIVE within a session — each event carries the full
      // list so far (final segment + the new interim tail)
      act(() => rec.emitResult([{ transcript: 'Hallo Welt ', isFinal: true }, { transcript: 'wie gehts', isFinal: false }]))
      expect(result.current.transcript).toBe('Hallo Welt wie gehts')
    })

    it('does not duplicate when the engine replays already-final results (Android)', () => {
      const { result } = renderHook(() => useSpeechToText())
      act(() => result.current.start())
      const rec = FakeRecognition.last()
      act(() => rec.emitResult([{ transcript: 'Hallo Welt ', isFinal: true }]))
      // buggy engines re-fire the same finalized result on the next interim tick — the transcript
      // must be rebuilt (idempotent), never appended again
      act(() => rec.emitResult([{ transcript: 'Hallo Welt ', isFinal: true }]))
      act(() => rec.emitResult([{ transcript: 'Hallo Welt ', isFinal: true }]))
      expect(result.current.transcript).toBe('Hallo Welt ') // not 'Hallo Welt Hallo Welt '
    })

    it('re-starts the same recognizer on a pause and does not duplicate when it replays its results', () => {
      const { result } = renderHook(() => useSpeechToText())
      act(() => result.current.start())
      const rec = FakeRecognition.last()
      act(() => rec.emitResult([{ transcript: 'Hallo ', isFinal: true }]))
      expect(result.current.transcript).toBe('Hallo ')
      act(() => rec.emitEnd()) // engine paused → re-starts the SAME instance (no new recognizer)
      expect(FakeRecognition.last()).toBe(rec)
      expect(rec.started).toBe(true)
      // Android replays the old final AND adds the new word in one cumulative list — the old slot
      // is already processed, so it's skipped; only the new word is appended (no duplication)
      act(() => rec.emitResult([{ transcript: 'Hallo ', isFinal: true }, { transcript: 'Welt', isFinal: true }]))
      expect(result.current.transcript).toBe('Hallo Welt')
    })

    it('falls back to de-DE when de-CH is not supported', () => {
      const { result } = renderHook(() => useSpeechToText())
      act(() => result.current.start())
      act(() => FakeRecognition.last().emitError('language-not-supported'))
      const rec = FakeRecognition.last()
      expect(rec.lang).toBe('de-DE')
      expect(rec.started).toBe(true)
      expect(result.current.listening).toBe(true)
    })

    it('stop() halts the recognizer and clears listening', () => {
      const { result } = renderHook(() => useSpeechToText())
      act(() => result.current.start())
      act(() => result.current.stop())
      expect(result.current.listening).toBe(false)
      expect(FakeRecognition.last().started).toBe(false)
    })

    it('aborts the recognizer on unmount', () => {
      const { result, unmount } = renderHook(() => useSpeechToText())
      act(() => result.current.start())
      const rec = FakeRecognition.last()
      unmount()
      expect(rec.aborted).toBe(true)
    })
  })
})
