/**
 * Engine APIs pdf.js v6.2 calls UNGUARDED that are too new for browsers the fleet actually
 * runs. Verified in the shipped bundles (both `pdf.mjs` and `pdf.worker.min.mjs`):
 *
 * - `Map.prototype.getOrInsertComputed` / `getOrInsert` (TC39 upsert, ~Chrome 141) — hit on
 *   EVERY document open (MessageHandler's callbacks map), which is the 08.09. field report:
 *   «typeerror · f(...).getOrInsertComputed is not a function» on a current Samsung phone.
 *   Samsung Internet trails Chrome by months, so this broke PDFs for mainstream Android.
 * - `Uint8Array.fromBase64` / `toBase64` (~Chrome 140) — the signature-annotation path.
 *
 * Spec-shaped where pdf.js needs them, installed only where missing, and imported by BOTH
 * sides: statically by PdfViewport (before the pdfjs chunk resolves, which also covers the
 * fake-worker fallback) and by lib/pdfWorkerEntry, the shim the real worker boots through.
 * `missingPdfCapability` (lib/pdfDiagnosis) keeps probing only what is NOT polyfilled here.
 */

interface UpsertProto {
  has(key: unknown): boolean
  get(key: unknown): unknown
  set(key: unknown, value: unknown): unknown
  getOrInsert?(key: unknown, value: unknown): unknown
  getOrInsertComputed?(key: unknown, compute: (key: unknown) => unknown): unknown
}

function installUpsert(proto: UpsertProto): void {
  if (typeof proto.getOrInsert !== 'function') {
    proto.getOrInsert = function (this: UpsertProto, key: unknown, value: unknown) {
      if (!this.has(key)) this.set(key, value)
      return this.get(key)
    }
  }
  if (typeof proto.getOrInsertComputed !== 'function') {
    proto.getOrInsertComputed = function (this: UpsertProto, key: unknown, compute: (key: unknown) => unknown) {
      if (!this.has(key)) this.set(key, compute(key))
      return this.get(key)
    }
  }
}

installUpsert(Map.prototype as unknown as UpsertProto)
installUpsert(WeakMap.prototype as unknown as UpsertProto)

interface Base64Ctor {
  fromBase64?(s: string): Uint8Array
  prototype: { toBase64?(): string }
}

const U8 = Uint8Array as unknown as Base64Ctor
if (typeof U8.fromBase64 !== 'function') {
  U8.fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}
if (typeof U8.prototype.toBase64 !== 'function') {
  U8.prototype.toBase64 = function (this: Uint8Array) {
    let bin = ''
    for (const b of this) bin += String.fromCharCode(b)
    return btoa(bin)
  }
}

export {}
