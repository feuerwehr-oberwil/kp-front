// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMediaQuery } from './useIsPhone'

afterEach(() => { vi.unstubAllGlobals() })

describe('useMediaQuery', () => {
  // the jsdom setup gives every file a matchMedia; a browser or a server render without one must
  // still read «no match» rather than throw
  it('reads «no match» where there is no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(renderHook(() => useMediaQuery('(max-width: 600px)')).result.current).toBe(false)
  })
})
