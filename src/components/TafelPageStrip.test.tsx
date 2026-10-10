// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TafelPageStrip } from './TafelPageStrip'
import { formAnno, newFormPage, pageTitles, type FormAnno } from '../lib/boardForm'
import { BUNDLED_TEMPLATES } from '../lib/boardTemplates'
import { SKIZZE } from '../lib/tafelPages'

afterEach(cleanup)

const FKS = BUNDLED_TEMPLATES[0]
const pageOf = (id: string, at: string): FormAnno => formAnno(newFormPage(FKS, FKS.pages.find((p) => p.id === id)!, {}, at))

describe('the page strip (owner, 10.10. evening)', () => {
  const pages = [pageOf('ef', '2026-10-10T09:00:00Z'), pageOf('konzept', '2026-10-10T09:01:00Z'), pageOf('konzept', '2026-10-10T09:02:00Z')]
  it('numbers the second Konzept, and «+ Seite» lists only page titles — a repeatable one stays on offer', async () => {
    const onAdd = vi.fn()
    render(<TafelPageStrip pages={pages} titles={pageTitles(pages)} current={SKIZZE} templates={BUNDLED_TEMPLATES} readOnly={false} onPick={() => {}} onAdd={onAdd} />)
    const strip = screen.getByTestId('tafel-strip')
    expect([...strip.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent)).toEqual(['Skizze', 'Erste Führung', 'Konzept', 'Konzept 2'])
    const add = screen.getByRole('button', { name: 'Seite hinzufügen' })
    expect(add.getAttribute('title')).toBe('Seite hinzufügen')
    await act(async () => { fireEvent.click(add) })
    const items = screen.getAllByRole('menuitem')
    // no «FKS – Erste Führung» heading, just the pages
    expect(document.body.textContent).not.toMatch(/FKS – Erste Führung/)
    const konzept = items.find((i) => i.textContent?.startsWith('Konzept'))!
    expect(konzept.textContent).not.toMatch(/schon da/)
    expect(items.find((i) => i.textContent?.startsWith('Erste Führung'))!.textContent).toMatch(/schon da/)
    await act(async () => { fireEvent.click(konzept) })
    expect(onAdd).toHaveBeenCalledWith(FKS, expect.objectContaining({ id: 'konzept', repeatable: true }))
  })
})
