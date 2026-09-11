// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { applyLocale } from '../config/copy'
import { JournalDeliveryNotice } from './JournalDeliveryNotice'

afterEach(() => { cleanup(); applyLocale('de-CH') })

it('does not claim local safety when persistence failed, and permits export without acknowledging entries', () => {
  const save = vi.fn()
  render(<JournalDeliveryNotice status="storage" count={2} onRetry={vi.fn()} onExport={save} />)
  expect(screen.getByRole('alert').textContent).toContain('App offen lassen')
  expect(screen.queryByText(/Auf diesem Gerät gespeichert/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Einträge sichern' }))
  expect(save).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert')).toBeTruthy()
})

it('a failed retry leaves the warning and recovery action available', async () => {
  const retry = vi.fn().mockRejectedValue(new Error('offline'))
  render(<JournalDeliveryNotice status="error" count={2} onRetry={retry} onExport={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy())
  expect(screen.getByRole('alert').textContent).toContain('2 Einträge nicht übertragen')
})

it('normal in-flight saves do not flash a warning', () => {
  render(<JournalDeliveryNotice status="pending" count={1} onRetry={vi.fn()} onExport={vi.fn()} />)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

it.each([
  ['de-CH', '1 Eintrag nicht übertragen'],
  ['en', '1 entry not uploaded'],
  ['fr', '1 entrée non transmise'],
  ['it', '1 voce non trasmessa'],
])('uses the singular delivery title in %s', async (locale, title) => {
  await applyLocale(locale)
  render(<JournalDeliveryNotice status="error" count={1} onRetry={vi.fn()} onExport={vi.fn()} />)
  expect(screen.getByRole('alert').querySelector('strong')?.textContent).toBe(title)
})
