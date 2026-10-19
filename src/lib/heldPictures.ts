// Pictures that must paint with the FIRST frame of every later mount: the device cards and the
// device page's hero of the Checkliste surface (review round 2, 19.10.2026 – owner: the pictures
// «always have to refetch», each open showed empty cards, then the photos).
//
// Why a held copy and not the browser's caches: with a service worker controlling the page,
// WebKit hands every NEW <img>'s request to the worker, even for an immutable URL it has just
// shown – the picture arrives asynchronously, after the first paint, and on an iPhone whose
// worker went to sleep that is a visible pop on every open (e2e/checkliste-pictures.mjs, `--sw`).
// A `blob:` URL is never handed to the worker: an <img> with one is complete the moment it is
// created. So the first mount shows the asset URL (and holds its bytes); every later one the blob.
//
//   <img src={heldPicture(url)} />  +  useEffect(() => holdPicture(url), [url])
//
// Held for the session, never revoked: a station has a handful of devices, ~100 KB each. The
// asset URL carries its version (lib/checklists · checklistAssetUrl), so a replaced picture is a
// new key, never a stale copy.

const held = new Map<string, string>()
const loading = new Set<string>()

/** the blob URL held for `url`, or `url` itself until its bytes are held */
export function heldPicture(url: string): string {
  return held.get(url) ?? url
}

/** fetch `url` once (through the service worker and its cache) and hold its bytes; a failure
 *  leaves it unheld, to be tried again on the next mount */
export function holdPicture(url: string): void {
  if (held.has(url) || loading.has(url) || typeof URL.createObjectURL !== 'function') return
  loading.add(url)
  void fetch(url, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((b) => { held.set(url, URL.createObjectURL(b)) })
    .catch(() => { /* not held: the asset URL keeps working */ })
    .finally(() => loading.delete(url))
}

/** test seam */
export function resetHeldPictures() { held.clear(); loading.clear() }
