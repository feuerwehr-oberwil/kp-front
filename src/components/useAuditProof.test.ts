// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { verifyChain } from '../lib/incidents'
import { useAuditProof } from './useAuditProof'

vi.mock('../lib/incidents', () => ({ verifyChain: vi.fn() }))
afterEach(() => vi.mocked(verifyChain).mockReset())

describe('useAuditProof', () => {
  it('reads as unchecked — never intact — until the server answers', async () => {
    vi.mocked(verifyChain).mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useAuditProof('inc-1'))
    expect(result.current.checking).toBe(true)
    expect(result.current.proof).toMatchObject({ intact: null, offline: true })
  })

  it('carries a broken chain with the sequence it broke at', async () => {
    vi.mocked(verifyChain).mockResolvedValue({ intact: false, broken_at_seq: 17, count: 40, head: 'abc' })
    const { result } = renderHook(() => useAuditProof('inc-1'))
    await waitFor(() => expect(result.current.checking).toBe(false))
    expect(result.current.proof).toMatchObject({ intact: false, brokenAtSeq: 17, count: 40, head: 'abc' })
    expect(result.current.proof.offline).toBeUndefined()
    expect(verifyChain).toHaveBeenCalledWith('inc-1')
  })

  it('a failed check is «offline», not intact', async () => {
    vi.mocked(verifyChain).mockRejectedValue(new Error('network'))
    const { result } = renderHook(() => useAuditProof('inc-1'))
    await waitFor(() => expect(result.current.checking).toBe(false))
    expect(result.current.proof).toMatchObject({ intact: null, offline: true })
  })
})
