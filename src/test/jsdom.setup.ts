// Vitest setup (vite.config.ts · test.setupFiles): runs before every test file. jsdom implements
// no `matchMedia`, and every surface that asks `useIsPhone` or the pointer type calls it – so a
// jsdom file starts with one that matches no query: a desk with a mouse. A test that needs a
// query to match calls `stubMatchMedia` (./dom.test-utils). Node-environment files have no window
// and get nothing.
import { staticMediaList } from './mediaList'

if (typeof window !== 'undefined') window.matchMedia = (query: string) => staticMediaList(query, false)
