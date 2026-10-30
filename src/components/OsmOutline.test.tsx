// @vitest-environment jsdom
// «Gebäudeumrisse werden geladen …» forever (sweep 30.10.2026, #11): every way the picker's load
// could hang or stick, and «Erneut versuchen» actually starting over.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'

const io = vi.hoisted(() => ({
  idbGet: vi.fn<(key: string) => Promise<unknown>>(),
  idbSet: vi.fn<(key: string, value: unknown) => Promise<boolean>>(),
  idbDel: vi.fn<(key: string) => Promise<void>>(),
  apiPost: vi.fn<(path: string, body: unknown, extra?: unknown, timeoutMs?: number) => Promise<unknown>>(),
}))
vi.mock('../lib/idb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/idb')>()),
  idbGet: io.idbGet, idbSet: io.idbSet, idbDel: io.idbDel,
}))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiPost: io.apiPost,
}))

import { OsmOutline } from './OsmOutline'
import { OVERPASS_TIMEOUT_MS } from '../lib/api'

const copy = appConfig.copy.whiteboard
const never = () => new Promise<never>(() => {})
// one building, a 10 m square in the middle of the box
const answer = (lng: number, lat: number) => ({
  elements: [{ type: 'way', geometry: [
    { lat: lat - 0.00005, lon: lng - 0.00007 }, { lat: lat - 0.00005, lon: lng + 0.00007 },
    { lat: lat + 0.00005, lon: lng + 0.00007 }, { lat: lat + 0.00005, lon: lng - 0.00007 },
  ] }],
})
// the picker caches per box for the module's lifetime, so every test asks for its own place
let n = 0
const place = () => {
  const center: [number, number] = [7.5 + ++n * 0.01, 47.5]
  return { center, radiusM: 150, onAspect: () => {}, sW: 400, sH: 400 }
}

beforeEach(() => {
  io.idbGet.mockReset().mockResolvedValue(null)
  io.idbSet.mockReset().mockResolvedValue(true)
  io.idbDel.mockReset().mockResolvedValue(undefined)
  io.apiPost.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Gebäude picker · loading never sticks', () => {
  it('«Erneut versuchen» reaches its button on the Plan board, whose pan gesture captures the pointer', async () => {
    io.apiPost.mockRejectedValue(new Error('down'))
    const boardDown = vi.fn()
    render(<div onPointerDown={boardDown}><OsmOutline {...place()} /></div>)
    const retry = await screen.findByRole('button', { name: copy.osmRetry })
    fireEvent.pointerDown(retry)
    expect(boardDown).not.toHaveBeenCalled()
  })

  it('retry starts over from the server – past a stuck device cache and a stuck request', async () => {
    const p = place()
    io.idbGet.mockImplementation(never)
    io.apiPost.mockImplementation(never)
    const { container } = render(<OsmOutline {...p} />)
    const retry = await screen.findByRole('button', { name: copy.osmRetry }, { timeout: 6_000 })
    io.apiPost.mockResolvedValue(answer(...p.center))
    fireEvent.click(retry)
    await waitFor(() => expect(container.querySelectorAll('polygon')).toHaveLength(1))
    expect(io.idbDel).toHaveBeenCalledWith(expect.stringMatching(/^kp\.osm\.bld2\./))
  }, 10_000)

  it('an Overpass «runtime error» remark is a failure – shown with a retry, never cached', async () => {
    io.apiPost.mockResolvedValue({ remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.', elements: [] })
    render(<OsmOutline {...place()} />)
    expect(await screen.findByText(copy.osmError)).toBeTruthy()
    expect(io.idbSet).not.toHaveBeenCalled()
  })

  it('a stored EMPTY answer is kept – a box without buildings costs no request per load', async () => {
    io.idbGet.mockResolvedValue([])
    render(<OsmOutline {...place()} />)
    await waitFor(() => expect(io.idbGet).toHaveBeenCalledWith(expect.stringMatching(/^kp\.osm\.bld2\./)))
    await new Promise((r) => setTimeout(r, 0))
    expect(io.apiPost).not.toHaveBeenCalled()
  })

  it('asks with a bound above the server\'s own mirror bound, so its answer is not cut off', async () => {
    io.apiPost.mockImplementation(never)
    render(<OsmOutline {...place()} />)
    await waitFor(() => expect(io.apiPost).toHaveBeenCalled())
    expect(io.apiPost.mock.calls[0][3]).toBe(OVERPASS_TIMEOUT_MS)
    // read from disk, not imported (boardKinds.test explains why); vitest runs from the repo root
    const py = readFileSync(join(process.cwd(), 'backend/app/overpass.py'), 'utf-8')
    const serverS = Number(/^FETCH_TIMEOUT_S = ([\d.]+)/m.exec(py)?.[1])
    expect(serverS).toBeGreaterThan(0)
    expect(OVERPASS_TIMEOUT_MS).toBeGreaterThan(serverS * 1000 + 5_000)
  })
})
