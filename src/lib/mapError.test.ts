import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('./reportError', () => ({ reportClientError: vi.fn() }))
import { reportClientError } from './reportError'
import { reportMapError } from './mapError'

beforeEach(() => vi.clearAllMocks())
it('does not turn a cancelled map request into a crash report', () => {
  const controller = new AbortController()
  controller.abort()
  reportMapError(controller.signal.reason)
  reportMapError(new DOMException('signal is aborted without reason', 'AbortError'))
  expect(reportClientError).not.toHaveBeenCalled()
})
it.each([
  new Error('signal is aborted without reason'), // matching words are not proof of cancellation
  new DOMException('The request timed out', 'TimeoutError'),
  new TypeError('Failed to fetch'),
  new Error('WebGL context lost'),
])('still reports genuine map failures: %s', (error) => {
  reportMapError(error)
  expect(reportClientError).toHaveBeenCalledWith(error, { kind: 'error' })
})
it('retains a diagnostic for an error event with no payload', () => {
  reportMapError(undefined)
  expect(reportClientError).toHaveBeenCalledWith(expect.objectContaining({ message: 'map error' }), { kind: 'error' })
})
