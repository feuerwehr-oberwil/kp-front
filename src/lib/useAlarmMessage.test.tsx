// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { getIncidentMeta } = vi.hoisted(() => ({ getIncidentMeta: vi.fn() }))
vi.mock('./incidents', () => ({ getIncidentMeta }))
const { useAlarmMessage } = await import('./useAlarmMessage')

const SENT = 'Rauch aus Fenster im 2. OG. Eine Person wird vermisst.\nAusrückeordnung: 1. TLF → 2. PIO\n\nLage & Pläne: https://front.fwo.li/l/abc'

describe('useAlarmMessage', () => {
  it('reads the words a person wrote, and the next mount starts with them while it re-reads', async () => {
    getIncidentMeta.mockResolvedValueOnce({ text: SENT })
    const first = renderHook(() => useAlarmMessage('e1'))
    expect(first.result.current).toBeNull()
    await waitFor(() => expect(first.result.current).toBe('Rauch aus Fenster im 2. OG. Eine Person wird vermisst.'))
    first.unmount()

    getIncidentMeta.mockRejectedValueOnce(new Error('offline'))
    const again = renderHook(() => useAlarmMessage('e1'))
    expect(again.result.current).toBe('Rauch aus Fenster im 2. OG. Eine Person wird vermisst.')
    await waitFor(() => expect(getIncidentMeta).toHaveBeenCalledTimes(2))
    expect(again.result.current).toBe('Rauch aus Fenster im 2. OG. Eine Person wird vermisst.')
  })

  it('an alarm with no words of its own is an empty message, not a missing one', async () => {
    getIncidentMeta.mockResolvedValueOnce({ text: 'Ausrückeordnung: 1. TLF' })
    const { result } = renderHook(() => useAlarmMessage('e2'))
    await waitFor(() => expect(result.current).toBe(''))
  })

  it('an older read that answers last does not overwrite the newer answer', async () => {
    let answerOld: (v: { text: string }) => void = () => {}
    getIncidentMeta.mockReturnValueOnce(new Promise((r) => { answerOld = r }))
    getIncidentMeta.mockResolvedValueOnce({ text: 'Neu' })
    const first = renderHook(() => useAlarmMessage('e3'))
    const second = renderHook(() => useAlarmMessage('e3'))
    await waitFor(() => expect(second.result.current).toBe('Neu'))
    first.unmount()
    second.unmount()
    answerOld({ text: 'Alt' })
    await Promise.resolve()

    getIncidentMeta.mockRejectedValueOnce(new Error('offline'))
    const later = renderHook(() => useAlarmMessage('e3'))
    expect(later.result.current).toBe('Neu')
  })
})
