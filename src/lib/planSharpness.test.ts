import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delayedSharpness, PREFETCH_CAP, resetWarmedTiles, sharpChip, tileSetSharpness, warmTiles, type PlanSharpness } from './planSharpness'

describe('tileSetSharpness', () => {
  it('is quiet while the underlay is still cold — the reader says «lädt» itself', () => {
    expect(tileSetSharpness(false, 5, 0)).toBe('sharp')
  })
  it('loads while a tile of the current view is pending, and that wins over a failure', () => {
    expect(tileSetSharpness(true, 3, 0)).toBe('loading')
    expect(tileSetSharpness(true, 1, 2)).toBe('loading')
  })
  it('fails once nothing is pending and a tile could not be had; sharp otherwise', () => {
    expect(tileSetSharpness(true, 0, 1)).toBe('failed')
    expect(tileSetSharpness(true, 0, 0)).toBe('sharp')
  })
})

describe('sharpChip', () => {
  it('says nothing for a sharp view, online or not', () => {
    expect(sharpChip('sharp', false)).toBeNull()
    expect(sharpChip('sharp', true)).toBeNull()
  })
  it('a failure offline is «nur mit Netz», online a failure', () => {
    expect(sharpChip('failed', true)).toBe('offline')
    expect(sharpChip('failed', false)).toBe('failed')
  })
  it('loading stays a spinner offline (a stored tile still comes, a missing one fails fast)', () => {
    expect(sharpChip('loading', true)).toBe('loading')
    expect(sharpChip('loading', false)).toBe('loading')
  })
})

describe('delayedSharpness', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('holds the first «not sharp» back, so a quick load never flashes', () => {
    const seen: PlanSharpness[] = []
    const d = delayedSharpness((s) => seen.push(s), 300)
    d.report('loading')
    vi.advanceTimersByTime(200)
    d.report('sharp')
    vi.advanceTimersByTime(500)
    expect(seen).toEqual(['sharp'])
  })

  it('shows a lasting load after the delay, hides at once when sharp', () => {
    const seen: PlanSharpness[] = []
    const d = delayedSharpness((s) => seen.push(s), 300)
    d.report('loading')
    vi.advanceTimersByTime(299)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['loading'])
    d.report('sharp')
    expect(seen).toEqual(['loading', 'sharp'])
  })

  it('once up, a change of reason goes through without another delay', () => {
    const seen: PlanSharpness[] = []
    const d = delayedSharpness((s) => seen.push(s), 300)
    d.report('loading')
    vi.advanceTimersByTime(300)
    d.report('failed')
    expect(seen).toEqual(['loading', 'failed'])
  })

  it('cancel drops a pending show (unmount)', () => {
    const seen: PlanSharpness[] = []
    const d = delayedSharpness((s) => seen.push(s), 300)
    d.report('failed')
    d.cancel()
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([])
  })
})

describe('warmTiles', () => {
  beforeEach(() => {
    resetWarmedTiles()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('asks for each tile once, at low priority, with the session cookie', () => {
    expect(warmTiles(['/t/1', '/t/2'], true)).toEqual(['/t/1', '/t/2'])
    expect(warmTiles(['/t/2', '/t/3'], true)).toEqual(['/t/3'])
    expect(vi.mocked(fetch).mock.calls.map((c) => c[0])).toEqual(['/t/1', '/t/2', '/t/3'])
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', priority: 'low' })
  })

  it('never more than a screenful, and nothing offline', () => {
    const many = Array.from({ length: PREFETCH_CAP + 20 }, (_, i) => `/t/${i}`)
    expect(warmTiles(many, false)).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(warmTiles(many, true)).toHaveLength(PREFETCH_CAP)
  })

  it('a failed warm-up may be asked again', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'))
    warmTiles(['/t/x'], true)
    await vi.waitFor(() => expect(warmTiles(['/t/x'], true)).toEqual(['/t/x']))
  })
})
