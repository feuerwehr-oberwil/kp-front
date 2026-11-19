// The QR decoder behind «Scan» (components/TagScan): zxing-cpp compiled to WebAssembly
// (`zxing-wasm`, reader build). Safari has no `BarcodeDetector`, so the decoder ships with the app.
//
// ⚠️ OFFLINE. The .wasm is a hashed build asset (the `?url` import below) and the service worker
// precaches every `*.wasm` (vite.config · globPatterns), so a scan works in a cellar without
// network. Never let the package fetch its default jsDelivr URL – that is what `locateFile` stops.
// The JS half is a lazy chunk: nobody pays for it until the first «Scan».
//
// One frame may hold the whole Trupp: the reader returns every code in it at once (the owner's
// iPhone, 19.11.2026: 4 tags in one frame within 0.24 s, 12 ms per decode at 1280 px). No cap of
// our own on how many – a frame with a few unrelated codes in it must not crowd a tag out.

import { useEffect, useState } from 'react'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import type { ReaderOptions } from 'zxing-wasm/reader'

const OPTIONS: ReaderOptions = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: false,
  tryDownscale: true,
}

let reader: Promise<typeof import('zxing-wasm/reader')> | undefined

/** Load (once) and warm the decoder – call it when the camera starts, so the first frame is not
 *  the one that waits for 900 KB of WebAssembly to compile. */
export function loadTagDecoder() {
  if (!reader) {
    const loading = import('zxing-wasm/reader').then(async (m) => {
      await m.prepareZXingModule({
        overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
        fireImmediately: true,
      })
      return m
    })
    // a failed load is not remembered: the next «Scan» tries again (the network may be back)
    loading.catch(() => { if (reader === loading) reader = undefined })
    reader = loading
  }
  return reader
}

/** Every valid QR text in one camera frame. */
export async function readTags(frame: ImageData): Promise<string[]> {
  const m = await loadTagDecoder()
  const results = await m.readBarcodes(frame, OPTIONS)
  return results.filter((r) => r.isValid).map((r) => r.text)
}

let camera: Promise<boolean> | undefined

/** Whether this device has a camera at all – the «Scan» button is only drawn where it can work.
 *  `enumerateDevices` lists a camera without asking for permission (labels stay empty until it
 *  is granted, the KIND does not). */
export function hasCamera(): Promise<boolean> {
  camera ??= (async () => {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices?.()
      return !!devices?.some((d) => d.kind === 'videoinput')
    } catch {
      return false
    }
  })()
  return camera
}

/** `hasCamera` as React state: false until the device answers (and in tests, which have none). */
export function useHasCamera(): boolean {
  const [has, setHas] = useState(false)
  useEffect(() => {
    let alive = true
    void hasCamera().then((v) => { if (alive) setHas(v) })
    return () => { alive = false }
  }, [])
  return has
}
