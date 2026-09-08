/**
 * The pdf.js WORKER's boot shim: polyfills first, then the real worker code. pdf.js loads its
 * worker from a bare URL, so a main-thread polyfill can never reach it — this module IS the
 * worker (PdfViewport imports it `?worker&url` and hands the bundled URL to
 * `GlobalWorkerOptions.workerSrc`), and Vite bundles the polyfills and the 1.2 MB worker
 * into one asset. Without the shim, every browser below ~Chrome 141 threw
 * «getOrInsertComputed is not a function» inside the worker on the first document open —
 * see lib/pdfPolyfills for the field report.
 */
import './pdfPolyfills'
import 'pdfjs-dist/build/pdf.worker.min.mjs'
