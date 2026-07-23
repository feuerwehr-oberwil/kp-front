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
