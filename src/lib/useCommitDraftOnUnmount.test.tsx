// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { useCommitDraftOnUnmount } from './useCommitDraftOnUnmount'

/** What the store got – a write after it closed is dropped, like a disposed journal's append. */
type Store = { closed: boolean; seen: string[] }
const write = (store: Store, s: string) => store.seen.push(store.closed ? `dropped: ${s}` : s)

/** The parent closes its store in its own passive cleanup, as the workspace's journal (useJournal). */
function Parent({ store, children }: { store: Store; children: ReactNode }) {
  useEffect(() => () => { store.closed = true }, [store])
  return <>{children}</>
}
function Field({ store, draft }: { store: Store; draft: string }) {
  useCommitDraftOnUnmount(() => write(store, draft))
  return null
}

describe('useCommitDraftOnUnmount', () => {
  // a whole surface going (another Einsatz opened): the field's draft reaches the store above it
  // before that store closes – a passive cleanup ran after the parent's
  it('commits before the parent closes its store', () => {
    const store: Store = { closed: false, seen: [] }
    const { unmount } = render(<Parent store={store}><Field store={store} draft="Wasser ab 14:20" /></Parent>)
    unmount()
    expect(store.seen).toEqual(['Wasser ab 14:20'])
  })

  it('commits the latest draft, once', () => {
    const store: Store = { closed: false, seen: [] }
    const tree = (draft: string) => <Parent store={store}><Field store={store} draft={draft} /></Parent>
    const { rerender, unmount } = render(tree('Wasser'))
    rerender(tree('Wasser ab 14:20'))
    unmount()
    expect(store.seen).toEqual(['Wasser ab 14:20'])
  })
})
