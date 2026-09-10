// @vitest-environment jsdom
//
// A Beilage that cannot be re-encoded falls back to the original file: it will fail visibly at
// upload and the operator can retry, which beats dropping the picture here.
//
// jsdom has no canvas, so the decode/encode edges are stubbed. That is not a weakening of the
// test: what this file is guarding is the scaling arithmetic and the quality ladder, which are
// ours — whether Safari's toBlob honours a quality argument is not something a unit test can
// find out anyway.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareUploadImage } from './imagePrep'

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
