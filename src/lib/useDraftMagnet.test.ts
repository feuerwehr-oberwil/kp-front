// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { joinTargets, useDraftMagnet } from './useDraftMagnet'
import { MAGNET_DWELL_MS, type MagneticTarget, type Point } from './lineAttachments'

// The draft magnet both surfaces draw lines with (MapView, Whiteboard), on a plain px surface:
// a symbol at (40, 0) and another line's free end at (0, 100).
const symbol: MagneticTarget = { key: 'object:fire', target: { kind: 'object', id: 'fire' }, point: [40, 0] }
const lineEnd: MagneticTarget = { key: 'line:hose:end:0', target: { kind: 'line', id: 'hose', endpoint: 'end' }, point: [0, 100], port: 0 }

function mount(targets: MagneticTarget[] = [symbol, lineEnd]) {
  return renderHook(() => useDraftMagnet<Point>({
    project: (p) => p,
    candidates: () => targets,
    attachmentFor: (c) => ({ target: c.target, routing: 'direct' }),
  }))
}
const onFire = { target: { kind: 'object', id: 'fire' }, routing: 'direct' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useDraftMagnet', () => {
  it('a press that lands on a target arms at once and banks it on the end it names', () => {
    const { result } = mount()
    let banked = {}
    act(() => { banked = result.current.start([38, 0], true) })
    expect(banked).toEqual({ startAttachment: onFire })
    expect(result.current.state?.dwell.armed).toBe(true)
    let out
    act(() => { out = result.current.end() })
    expect(out).toEqual({ startAttachment: onFire, endAttachment: undefined })
  })

  it('a SHORT stroke that finds its symbol near the start keeps the start\'s claim (the Plan parity bug)', () => {
    const { result } = mount()
    act(() => { result.current.start([0, 0], true) }) // 40 px away — out of reach at the press
    act(() => { result.current.move([9, 0]) }) // still within STROKE_START_RADIUS_PX, now in reach
    expect(result.current.state?.atStart).toBe(true)
    expect(result.current.state?.dwell.armed).toBe(false)
    act(() => { vi.advanceTimersByTime(MAGNET_DWELL_MS) }) // the motionless finger closes the ring
    let out
    act(() => { out = result.current.end() })
    expect(out).toEqual({ startAttachment: onFire, endAttachment: undefined })
  })

  it('leaving the start radius ends the claim for good — the far end earns its own ring', () => {
    const { result } = mount()
    act(() => { result.current.start([0, 0], true) })
    act(() => { result.current.move([30, 30]) })
    act(() => { result.current.move([9, 0]) }) // back near the start: still the FAR end's aim
    expect(result.current.state?.atStart).toBe(false)
    act(() => { vi.advanceTimersByTime(MAGNET_DWELL_MS) })
    let out
    act(() => { out = result.current.end() })
    expect(out).toEqual({ startAttachment: undefined, endAttachment: onFire })
  })

  it('a symbol passed over without pausing lands free — only a closed ring attaches', () => {
    const { result } = mount()
    act(() => { result.current.start([100, 100], true) })
    act(() => { result.current.move([60, 40]) })
    act(() => { result.current.move([42, 2]) })
    act(() => { vi.advanceTimersByTime(MAGNET_DWELL_MS - 50) })
    let out
    act(() => { out = result.current.end() })
    expect(out).toEqual({ startAttachment: undefined, endAttachment: undefined })
    // …and the pending timer went with the release: nothing arms afterwards
    act(() => { vi.advanceTimersByTime(MAGNET_DWELL_MS) })
    expect(result.current.state).toBeNull()
  })

  it('another line\'s end arms on acquisition, with no dwell', () => {
    const { result } = mount()
    act(() => { result.current.start([100, 0], true) })
    act(() => { result.current.move([60, 60]) })
    act(() => { result.current.move([2, 98]) })
    expect(result.current.state?.dwell.armed).toBe(true)
    let out
    act(() => { out = result.current.end() })
    expect(out).toEqual({ startAttachment: undefined, endAttachment: { target: lineEnd.target, routing: 'direct' } })
  })

  it('a start pressed on a line end holds its joint for the whole stroke', () => {
    const { result } = mount()
    act(() => { result.current.start([0, 98], true) })
    act(() => { result.current.move([60, 60]) })
    expect(result.current.state?.startJoin?.key).toBe(lineEnd.key)
    expect(joinTargets(result.current.state, null).map((t) => t.key)).toEqual([lineEnd.key])
  })

  it('a later node tap aims for the END, even when it lands on a target', () => {
    const { result } = mount()
    let banked = {}
    act(() => { banked = result.current.start([40, 2], false) })
    expect(banked).toEqual({ endAttachment: onFire })
  })

  it('a release with no stroke in progress reports nothing', () => {
    const { result } = mount()
    let out: unknown = 'unset'
    act(() => { out = result.current.end() })
    expect(out).toBeUndefined()
  })
})

describe('joinTargets', () => {
  const armed = { key: lineEnd.key, since: 0, armed: true }
  it('rings an armed line target once, whether the draft or a dragged end is on it', () => {
    const draft = { startJoin: lineEnd, dwell: armed, candidate: lineEnd }
    expect(joinTargets(draft, { dwell: armed, candidate: lineEnd })).toEqual([lineEnd])
  })

  it('never rings a symbol, nor a line target whose ring has not closed', () => {
    expect(joinTargets({ dwell: { key: symbol.key, since: 0, armed: true }, candidate: symbol }, null)).toEqual([])
    expect(joinTargets(null, { dwell: { ...armed, armed: false }, candidate: lineEnd })).toEqual([])
  })
})
