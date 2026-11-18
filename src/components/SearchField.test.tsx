// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SearchField } from './SearchField'

afterEach(cleanup)

// design pass A1 (18.11.2026): a query is not prose – and a field whose Enter commits a name says so
describe('SearchField keyboard defaults', () => {
  it('switches autocorrect, spell check and capitals off and labels the return key «search»', () => {
    render(<SearchField value="" onChange={() => {}} aria-label="Suchen" />)
    const input = screen.getByLabelText('Suchen')
    expect(input.getAttribute('autocorrect')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
    expect(input.getAttribute('autocapitalize')).toBe('none')
    expect(input.getAttribute('enterkeyhint')).toBe('search')
  })

  it('lets a caller override them (the Gast door)', () => {
    render(<SearchField value="" onChange={() => {}} aria-label="Person" enterKeyHint="done" autoCapitalize="words" />)
    const input = screen.getByLabelText('Person')
    expect(input.getAttribute('enterkeyhint')).toBe('done')
    expect(input.getAttribute('autocapitalize')).toBe('words')
  })
})
