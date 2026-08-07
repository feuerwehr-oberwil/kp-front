// @vitest-environment jsdom
//
// The two contracts differ, and the difference is the thing worth testing: a Beilage that
// cannot be re-encoded falls back to the original file (it will fail visibly at upload, and the
// operator can retry), while a Rückmeldung photo that cannot be made small enough comes back
// null (it would be dropped on the server AFTER the send button said it worked).
//
// jsdom has no canvas, so the decode/encode edges are stubbed. That is not a weakening of the
// test: what this file is guarding is the scaling arithmetic and the quality ladder, which are
// ours — whether Safari's toBlob honours a quality argument is not something a unit test can
// find out anyway.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEEDBACK_PHOTO_MAX_BYTES, prepareFeedbackPhoto, prepareUploadImage } from './imagePrep'

/** Sizes the fake encoder returns, biggest first — one per quality rung. */
let encoded: number[] = []
/** Canvas dimensions the code under test asked for, in call order. */
let drawn: Array<{ w: number; h: number }> = []
/** Quality arguments toBlob was called with. */
let qualities: number[] = []

function stubCanvas() {
  drawn = []
  qualities = []
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never
  HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
    drawn.push({ w: this.width, h: this.height })
    qualities.push(quality as number)
    const size = encoded[qualities.length - 1] ?? 0
    cb(size < 0 ? null : new Blob([new Uint8Array(size)], { type: type as string }))
  }
}

function stubBitmap(width: number, height: number) {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close: vi.fn() })))
}

beforeEach(() => {
  encoded = []
  stubCanvas()
  stubBitmap(4032, 3024)
})
afterEach(() => vi.unstubAllGlobals())

const aPhoto = () => new Blob([new Uint8Array(6_000_000)], { type: 'image/heic' })

describe('prepareFeedbackPhoto', () => {
  it('scales the long edge to 1600 px and keeps the aspect ratio', async () => {
    encoded = [10_000]
    await prepareFeedbackPhoto(aPhoto())
    // 4032×3024 is 4:3 — the long edge lands on the cap, the short one follows it.
    expect(drawn[0]).toEqual({ w: 1600, h: 1200 })
  })

  it('leaves a picture that is already smaller than the cap alone', async () => {
    stubBitmap(900, 600)
    encoded = [10_000]
    await prepareFeedbackPhoto(aPhoto())
    expect(drawn[0]).toEqual({ w: 900, h: 600 })
  })

  it('stops at the first quality that fits — most photos never see the lower rungs', async () => {
    encoded = [FEEDBACK_PHOTO_MAX_BYTES - 1]
    const out = await prepareFeedbackPhoto(aPhoto())
    expect(out?.size).toBe(FEEDBACK_PHOTO_MAX_BYTES - 1)
    expect(qualities).toEqual([0.8])
  })

  it('steps the quality down until the photo is under the cap', async () => {
    encoded = [FEEDBACK_PHOTO_MAX_BYTES + 50_000, FEEDBACK_PHOTO_MAX_BYTES + 1, 300_000]
    const out = await prepareFeedbackPhoto(aPhoto())
    expect(out?.size).toBe(300_000)
    // descending, and it really did try each one rather than guessing
    expect(qualities).toEqual([0.8, 0.6, 0.45])
  })

  it('gives up rather than hand back something the server would drop', async () => {
    // Every rung still over the cap. Returning the oversized blob would mean a send that
    // reports success and a photo that never arrives — the failure this contract exists to
    // move forward in time, to while the operator is still standing there.
    encoded = [900_000, 800_000, 700_000]
    expect(await prepareFeedbackPhoto(aPhoto())).toBeNull()
  })

  it('gives up when the browser cannot decode the file at all', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('HEIC, no decoder') }))
    expect(await prepareFeedbackPhoto(aPhoto())).toBeNull()
  })

  it('re-encodes even a small JPEG, because the EXIF is the other half of the reason', async () => {
    // A phone stamps its GPS position into the file it hands over, and a position in this app
    // is an Einsatzort. Passing a small file through untouched would ship it.
    encoded = [10_000]
    const small = new Blob([new Uint8Array(20_000)], { type: 'image/jpeg' })
    const out = await prepareFeedbackPhoto(small)
    expect(out?.size).toBe(10_000)
    expect(qualities.length).toBeGreaterThan(0)
  })
})

describe('prepareUploadImage keeps its own, different bargain', () => {
  it('passes a small file of an accepted type straight through', async () => {
    const small = new Blob([new Uint8Array(1000)], { type: 'image/jpeg' })
    expect(await prepareUploadImage(small)).toBe(small)
    expect(qualities).toEqual([])
  })

  it('falls back to the original file when the encode fails', async () => {
    encoded = [-1] // toBlob hands back null
    const file = aPhoto()
    expect(await prepareUploadImage(file)).toBe(file)
  })
})
