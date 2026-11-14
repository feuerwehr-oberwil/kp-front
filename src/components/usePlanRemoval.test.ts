// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePlanRemoval } from './usePlanRemoval'
import * as ui from '../lib/ui'
import type { BoardAnno, LineAttachment } from '../types'

vi.mock('../lib/ui', () => ({ toast: vi.fn(), confirmDialog: vi.fn(async () => true), undoToast: vi.fn() }))

const onObject = (id: string): LineAttachment => ({ target: { kind: 'object', id }, routing: 'direct' })
const tlf: BoardAnno = { id: 'a', kind: 'symbol', x: 0.1, y: 0.1, label: 'TLF' }
const other: BoardAnno = { id: 'b', kind: 'symbol', x: 0.9, y: 0.9, label: 'HRB' }
const hose = (id: string, over: Partial<BoardAnno> = {}): BoardAnno => ({ id, kind: 'draw', pts: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }], ...over })

// The Plan's removals over a live list the commit stub applies to.
function setup(annos: BoardAnno[], selIds: string[] = []) {
  let live = annos
  const commit = vi.fn((next: BoardAnno[]) => { live = next })
  const remove = vi.fn((id: string) => { live = live.filter((a) => a.id !== id) })
  const { result } = renderHook(() => usePlanRemoval({
    readOnly: false, annos, renderAnnos: annos, selId: null, setSelId: vi.fn(), selIds, setSelIds: vi.fn(),
    barIds: selIds, remove, commit, emit: vi.fn(), log: vi.fn(), activeId: 'p1',
  }))
  return { result, commit, remove, live: () => live }
}

afterEach(() => { vi.clearAllMocks() })

// Owner 14.11.2026, Lage ↔ Plan parity with useMapActions · deleteEntity: a symbol that Leitungen
// hang on asks first; either answer is ONE write (one ↶ step), nothing joined asks nothing.
describe('Plan delete — the joined-lines card', () => {
  const annos = () => [tlf, other, hose('h1', { startAttachment: onObject('a') }), hose('h2', { startAttachment: onObject('b'), endAttachment: onObject('a') }), hose('free')]

  it('nothing joined: no card, one step', async () => {
    const { result, remove, live } = setup([tlf, hose('free')])
    await act(async () => { await result.current.removeWithConnections(tlf) })
    expect(ui.confirmDialog).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(live().map((a) => a.id)).toEqual(['free'])
  })

  it('«Nur Symbol»: the lines stay, their ends let go – one commit', async () => {
    const { result, commit, live } = setup(annos())
    await act(async () => { await result.current.removeWithConnections(tlf) })
    expect(vi.mocked(ui.confirmDialog).mock.calls[0][0]).toMatchObject({ title: 'TLF hat 2 Leitungen' })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(live().map((a) => a.id)).toEqual(['b', 'h1', 'h2', 'free'])
    expect(live().find((a) => a.id === 'h1')?.startAttachment).toBeUndefined()
  })

  it('«Mit Leitungen»: the symbol and every line on it go in one commit', async () => {
    vi.mocked(ui.confirmDialog).mockResolvedValueOnce('alt' as never)
    const { result, commit, live } = setup(annos())
    let went: boolean | undefined
    await act(async () => { went = await result.current.removeWithConnections(tlf) })
    expect(went).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(live().map((a) => a.id)).toEqual(['b', 'free'])
    expect(ui.toast).toHaveBeenCalledWith('TLF und 2 Leitungen entfernt', expect.anything())
  })

  it('Abbrechen: nothing is written', async () => {
    vi.mocked(ui.confirmDialog).mockResolvedValueOnce(false)
    const { result, commit, remove } = setup(annos())
    let went: boolean | undefined
    await act(async () => { went = await result.current.removeWithConnections(tlf) })
    expect(went).toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('a group asks once (the Delete key), the lines counted over all of it', async () => {
    vi.mocked(ui.confirmDialog).mockResolvedValueOnce('alt' as never)
    const { commit, live } = setup(annos(), ['a', 'b'])
    // the Delete key runs deleteSelection (the bar is on the group) → deleteGroup
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })) })
    expect(ui.confirmDialog).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ui.confirmDialog).mock.calls[0][0]).toMatchObject({ title: 'Auswahl hat 2 Leitungen', confirmLabel: 'Nur Auswahl' })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(live().map((a) => a.id)).toEqual(['free'])
    expect(ui.toast).toHaveBeenCalledWith('2 Objekte und 2 Leitungen entfernt', expect.anything())
  })
})
