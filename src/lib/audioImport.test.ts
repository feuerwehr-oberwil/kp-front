import { describe, expect, it } from 'vitest'
import {
  MAX_AUDIO_UPLOAD_BYTES,
  formatAudioDuration,
  normalizeAudioType,
  resolveRecordingStart,
  validateAudioImport,
} from './audioImport'

describe('normalizeAudioType', () => {
  it('passes server-allowed types through', () => {
    expect(normalizeAudioType('audio/mp4', 'memo.m4a')).toBe('audio/mp4')
    expect(normalizeAudioType('audio/x-m4a', 'memo.m4a')).toBe('audio/x-m4a')
    expect(normalizeAudioType('audio/mpeg', 'x.mp3')).toBe('audio/mpeg')
  })
  it('normalises x-wav and casing/params', () => {
    expect(normalizeAudioType('audio/x-wav', 'x.wav')).toBe('audio/wav')
    expect(normalizeAudioType('Audio/MP4; codecs=mp4a', 'memo.m4a')).toBe('audio/mp4')
  })
  it('rescues a typeless .m4a (iOS Files omits the MIME) but nothing else', () => {
    expect(normalizeAudioType('', 'Aufnahme 3.m4a')).toBe('audio/mp4')
    expect(normalizeAudioType('', 'movie.mov')).toBeNull()
    expect(normalizeAudioType('video/mp4', 'movie.mp4')).toBeNull()
    expect(normalizeAudioType('application/octet-stream', 'memo.m4a')).toBeNull()
  })
})

describe('validateAudioImport', () => {
  it('accepts a normal Voice Memos export', () => {
    const r = validateAudioImport({ type: 'audio/x-m4a', name: 'memo.m4a', size: 5_000_000 })
    expect(r).toEqual({ ok: true, contentType: 'audio/x-m4a' })
  })
  it('rejects unsupported type before size', () => {
    expect(validateAudioImport({ type: 'video/mp4', name: 'a.mp4', size: 10 }))
      .toEqual({ ok: false, reason: 'type' })
  })
  it('enforces the byte cap inclusively', () => {
    const at = { type: 'audio/mp4', name: 'a.m4a', size: MAX_AUDIO_UPLOAD_BYTES }
    const over = { ...at, size: MAX_AUDIO_UPLOAD_BYTES + 1 }
    expect(validateAudioImport(at).ok).toBe(true)
    expect(validateAudioImport(over)).toEqual({ ok: false, reason: 'size' })
  })
})

describe('resolveRecordingStart', () => {
  const now = new Date('2026-07-15T14:30:00')
  it('resolves to today when the time is in the past', () => {
    expect(resolveRecordingStart('13:05', now)?.toISOString())
      .toBe(new Date('2026-07-15T13:05:00').toISOString())
  })
  it('rolls back to yesterday when the time would be in the future (midnight crossing)', () => {
    const after = new Date('2026-07-16T00:30:00')
    expect(resolveRecordingStart('23:50', after)?.toISOString())
      .toBe(new Date('2026-07-15T23:50:00').toISOString())
  })
  it('"now" itself stays today', () => {
    expect(resolveRecordingStart('14:30', now)?.getDate()).toBe(15)
  })
  it('rejects malformed input', () => {
    expect(resolveRecordingStart('24:00', now)).toBeNull()
    expect(resolveRecordingStart('aa:bb', now)).toBeNull()
    expect(resolveRecordingStart('', now)).toBeNull()
  })
})

describe('formatAudioDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatAudioDuration(47)).toBe('47s')
    expect(formatAudioDuration(754)).toBe('12:34')
    expect(formatAudioDuration(3675)).toBe('1:01:15')
    expect(formatAudioDuration(0)).toBe('0s')
  })
})
