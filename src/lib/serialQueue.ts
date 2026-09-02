// One lane of asynchronous work: jobs start strictly one after another, in the order they were
// handed in, whatever the caller does with the returned promises.
//
// The case this exists for is memory, not ordering. Decoding a phone photo costs ~48 MB of RGBA
// per picture (12 MP × 4 B) plus its canvas, and a multi-select of ten photos used to start ten
// of those in the same tick — an iPhone's WebKit process is gone before the first upload begins.
// Through one lane the peak is one decode, and the tenth picture simply lands a moment later.
// The same shape serves the plan prewarm (components/PdfViewport · warmQueue).

/**
 * Make a lane. The returned `run(job)` starts `job` only once every job queued before it has
 * settled, and resolves/rejects with that job's own outcome — a failed job never blocks the lane,
 * and never leaks its rejection into the next caller's promise.
 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return function run<T>(job: () => Promise<T>): Promise<T> {
    const p = tail.then(job)
    tail = p.catch(() => {})
    return p
  }
}
