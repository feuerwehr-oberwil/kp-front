// @vitest-environment jsdom
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The PUT is what this file is about, so the API layer is the seam. `apiGet` serves the initial
// document (and the post-conflict re-read); `apiPut` is scripted per test.
// hoisted, because vi.mock's factory runs before module-level bindings exist
const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    hint?: string
    constructor(status: number, detail: string, hint?: string) {
      super(detail)
      this.status = status
      this.detail = detail
      this.hint = hint
    }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, ApiError }))
vi.mock('../lib/deploymentConfig', () => ({
  loadDeploymentConfig: vi.fn(async () => ({})),
  applyDeploymentBranding: vi.fn(),
}))

import { ConfigProvider, ConfigAutosaveStatus, useConfig } from './ConfigContext'

/** A control that edits one field, so the autosave has something to fire on. */
function Edit() {
  const { set } = useConfig()
  return <button onClick={() => set(['identity', 'appName'], `x${Math.random()}`)}>edit</button>
}

const setup = () =>
  render(
    <ConfigProvider>
      <Edit />
      <ConfigAutosaveStatus />
    </ConfigProvider>,
  )

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue({ identity: { appName: 'Wehr' }, version: 'v1' })
  apiPut.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

/** Type, then let the 700 ms debounce elapse. */
async function edit() {
  await act(async () => { screen.getByText('edit').click() })
  await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
}

describe('Verwaltung autosave — it must stop trying', () => {
  it('⚠️ gives up after two consecutive failures instead of re-sending forever', async () => {
    // The bug this pins: the autosave effect returned early on `conflict` but not on `error`,
    // and `save.kind` is one of its dependencies — so error → saving → error re-armed it every
    // 700 ms, indefinitely, for as long as the document stayed invalid.
    apiPut.mockRejectedValue(new ApiError(422, 'report.links.0.title: too short'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(apiPut.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('shows what to do, not only what broke', async () => {
    apiPut.mockRejectedValue(new ApiError(413, 'Datei zu gross', 'Bild verkleinern und erneut hochladen.'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByText('Bild verkleinern und erneut hochladen.')).toBeTruthy()
  })

  it('offers «Erneut versuchen» only once it has actually stopped', async () => {
    apiPut.mockRejectedValue(new ApiError(500, 'kaputt'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    // …because while it was still retrying by itself the button did nothing a wait would not,
    // which is how it came to read as broken
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy()
  })

  it('does not offer a retry for an expired session — that one cannot be retried into life', async () => {
    apiPut.mockRejectedValue(new ApiError(401, 'nope'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(screen.getByText(/Sitzung abgelaufen/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull()
    expect(apiPut).toHaveBeenCalledTimes(1) // halted at once, not after two
  })

  it('a save that lands clears the counter, so a later blip still gets its two tries', async () => {
    apiPut
      .mockRejectedValueOnce(new ApiError(500, 'blip'))
      .mockResolvedValueOnce({ identity: { appName: 'Wehr' }, version: 'v2' })
      .mockRejectedValue(new ApiError(500, 'blip'))
    setup()
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await edit()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(apiPut.mock.calls.length).toBeGreaterThan(2)
    expect(apiPut.mock.calls.length).toBeLessThanOrEqual(4)
  })
})
