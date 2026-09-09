// Trigger a browser "save file" for an in-memory Blob. The object URL is revoked on a short
// delay (not immediately) so large blobs — e.g. a server-rendered PDF — stay alive long enough
// for the download to start in every browser.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// Download a same-origin URL WITHOUT navigating to it. `location.assign` on a file response
// walked the only window of an installed PWA onto iOS' quick-look page, which has no way back
// (Feldtest 08.09., «bleibt hier stecken»). An anchor with `download` saves in place — the
// server's Content-Disposition names the file — and a browser that ignores the attribute falls
// back to the old navigation, no worse than before. Streamed by the browser, so a large ZIP
// never sits in JS memory the way a Blob would.
export function downloadUrl(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}
