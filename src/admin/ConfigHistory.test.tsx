// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// «Letzte Änderungen» is the safety net SETUP.md §3 points a station at when a config write goes
// wrong. After one afternoon of setting a fresh station up it was 26 rows that ALL read «alarms,
// doctrine, fleet, identity, journal, map, mittel, report, roster» — four of them inside the same
// minute — because every writer replaces the whole document and the row listed what the document
// CONTAINED. What this file pins is the three things that make the list answer «which entry do I
// go back to?»: a row says what its write changed, an autosave burst is one row, and no row is
// left unattributed.

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }))
vi.mock('../lib/api', () => ({ apiGet, apiPost }))

import { ConfigHistory } from './ConfigHistory'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.backup

interface Row {
  id: number
  replacedAt: string
  source: string | null
  replacedBy: string | null
  sections: string[]
  emptied: string[]
}

/** An autosave burst: same hand, seconds apart, nothing emptied. */
const burst: Row[] = [
  { id: 5, replacedAt: '2026-08-16T10:22:30Z', source: 'api', replacedBy: 'Meier', sections: ['fleet.vehicles'], emptied: [] },
  { id: 4, replacedAt: '2026-08-16T10:22:29Z', source: 'api', replacedBy: 'Meier', sections: ['fleet.vehicles'], emptied: [] },
  { id: 3, replacedAt: '2026-08-16T10:22:27Z', source: 'api', replacedBy: 'Meier', sections: ['map.defaultView'], emptied: [] },
]
const rows = (extra: Row[] = []) => [...extra, ...burst]

const listRows = () => Array.from(document.querySelectorAll('.adm-hist-row'))
// minus the «Aktueller Stand» row, which is not a kept configuration
const keptRows = () => listRows().slice(1)

beforeEach(() => {
  vi.clearAllMocks()
  apiGet.mockResolvedValue(rows())
})
afterEach(cleanup)

const show = async (data: Row[]) => {
  apiGet.mockResolvedValue(data)
  render(<ConfigHistory onRestored={vi.fn()} />)
  await waitFor(() => expect(keptRows().length).toBeGreaterThan(0))
}

describe('a row says what its write changed', () => {
  it('names the sections that moved, not the ones the document happened to contain', async () => {
    await show([{ ...burst[0], id: 9, replacedAt: '2026-08-16T11:00:00Z', sections: ['roster.ranks'], emptied: [] }])
    expect(screen.getByText(C.histChanged.replace('{what}', 'roster.ranks'))).toBeTruthy()
  })

  it('says so when a write stored the document that was already there', async () => {
    await show([{ ...burst[0], id: 9, replacedAt: '2026-08-16T11:00:00Z', sections: [], emptied: [] }])
    expect(screen.getByText(C.histNoChange)).toBeTruthy()
  })
})

describe('a burst of autosaves is one entry', () => {
  it('collapses same-hand writes seconds apart and counts them', async () => {
    await show(rows())
    expect(keptRows()).toHaveLength(1)
    expect(screen.getByText(C.histBurst.replace('{n}', '3'))).toBeTruthy()
    // the union of what the burst touched, so the collapse hides no section name
    expect(screen.getByText(C.histChanged.replace('{what}', 'fleet.vehicles, map.defaultView'))).toBeTruthy()
  })

  it('restores the state BEFORE the burst, not before its last keystroke', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    apiPost.mockResolvedValue({})
    await show(rows())
    fireEvent.click(screen.getByRole('button', { name: C.histRestore }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/config/history/3/restore'))
  })

  it('opens into the individual writes, each with its own way back', async () => {
    await show(rows())
    fireEvent.click(screen.getByRole('button', { name: C.histBurstShow }))
    expect(keptRows()).toHaveLength(4) // the summary + its three writes
    expect(screen.getAllByRole('button', { name: C.histRestore })).toHaveLength(4)
  })

  it('never folds in a write that emptied something — that is the row this list exists for', async () => {
    const clobber: Row = {
      id: 6, replacedAt: '2026-08-16T10:22:31Z', source: 'api', replacedBy: 'Meier',
      sections: ['roster.ranks'], emptied: ['roster.ranks'],
    }
    await show(rows([clobber]))
    expect(keptRows()).toHaveLength(2)
    expect(document.querySelector('.adm-hist-warn')?.textContent).toContain('roster.ranks')
  })

  it('keeps two different hands apart, however close together they wrote', async () => {
    const other: Row = { ...burst[0], id: 7, replacedAt: '2026-08-16T10:22:31Z', replacedBy: 'Keller' }
    await show(rows([other]))
    expect(keptRows()).toHaveLength(2)
  })
})

describe('no row is left unattributed', () => {
  it('names a rank adopted during a personnel import instead of «Unbekannt»', async () => {
    const roster: Row = { ...burst[0], id: 8, replacedAt: '2026-08-16T10:32:00Z', source: 'roster' }
    await show([roster])
    expect(screen.getByText(C.histBy.replace('{source}', C.histSourceRoster).replace('{name}', 'Meier'))).toBeTruthy()
    expect(screen.queryByText(new RegExp(C.histSourceUnknown))).toBeNull()
  })

  it('says when a write came from a browser holding only the admin key', async () => {
    const anon: Row = { ...burst[0], id: 9, replacedAt: '2026-08-16T10:56:00Z', replacedBy: null }
    await show([anon])
    const expected = C.histBy.replace('{source}', C.histSourceApi).replace('{name}', C.histAdminOnly)
    expect(screen.getByText(expected)).toBeTruthy()
  })
})
