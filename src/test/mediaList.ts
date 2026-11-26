// The MediaQueryList the jsdom tests answer with – no imports, because the jsdom setup loads it
// before every test file.

/** A MediaQueryList that never changes: `matches` as given, its listeners never called. */
export function staticMediaList(media: string, matches: boolean): MediaQueryList {
  return {
    matches, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }
}
