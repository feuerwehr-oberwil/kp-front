// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

// The remembered-length auto-login (07.09.): a device that has signed an account in once
// submits by itself the moment the typed PIN reaches that account's proven length — no ✓.
// First logins, other devices, and a PIN that changed length keep the explicit ✓, and a
// failed auto-attempt disarms itself so a LONGER new PIN can still be typed out.

const login = vi.fn()
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ login }),
}))
vi.mock('../lib/api', () => ({
  apiGet: vi.fn(async () => [{ id: 'u1', display_name: 'Keller Anna', color: null, role: 'editor' }]),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public detail: string, public retryAfter?: number, public hint?: string) { super(detail) }
  },
}))
vi.mock(import('../lib/deploymentConfig'), async (importOriginal) => ({
  ...(await importOriginal()),
  demoNote: () => null,
  deploymentName: () => 'Test',
}))

const { LoginScreen } = await import('./LoginScreen')

const typePin = (digits: string) => {
  for (const d of digits) fireEvent.click(screen.getByRole('button', { name: d }))
}

async function openPad() {
  render(<LoginScreen />)
  await act(async () => {}) // roster fetch resolves
  fireEvent.click(screen.getByText('Keller Anna'))
}

// jsdom exposes localStorage as a getter-only accessor in this setup — install the same
// minimal stub ErrorBoundary.test.tsx / storageMigration.test.ts use.
function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size },
    } as Storage,
  })
}

beforeEach(() => {
  installLocalStorage()
  login.mockReset().mockResolvedValue(undefined)
})
afterEach(cleanup)

describe('LoginScreen — auto-login at the remembered PIN length', () => {
  it('a first login still needs the ✓, and its length is remembered on success', async () => {
    await openPad()
    typePin('123456')
    expect(login).not.toHaveBeenCalled() // nothing remembered yet — no silent jump
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }))
    await act(async () => {})
    expect(login).toHaveBeenCalledExactlyOnceWith('u1', '123456')
    expect(JSON.parse(localStorage.getItem('kp.pinlen')!)).toEqual({ u1: 6 })
  })

  it('the next login on this device submits by itself at that length', async () => {
    localStorage.setItem('kp.pinlen', JSON.stringify({ u1: 6 }))
    await openPad()
    typePin('123456')
    await act(async () => {})
    expect(login).toHaveBeenCalledExactlyOnceWith('u1', '123456')
  })

  it('a failed auto-attempt disarms the jump, so a longer changed PIN can be typed out', async () => {
    localStorage.setItem('kp.pinlen', JSON.stringify({ u1: 6 }))
    const { ApiError } = (await import('../lib/api')) as unknown as { ApiError: new (status: number, detail: string) => Error }
    login.mockRejectedValueOnce(new ApiError(401, 'PIN falsch'))
    await openPad()
    typePin('123456') // the old length — auto-fires and fails
    await act(async () => {})
    expect(login).toHaveBeenCalledTimes(1)

    typePin('12345678') // the new, longer PIN — must survive digit 6 without a second auto-fire
    expect(login).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }))
    await act(async () => {})
    expect(login).toHaveBeenCalledTimes(2)
    expect(login).toHaveBeenLastCalledWith('u1', '12345678')
    expect(JSON.parse(localStorage.getItem('kp.pinlen')!)).toEqual({ u1: 8 }) // re-learned
  })
})
