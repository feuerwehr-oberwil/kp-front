import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import { isModuleDisabled, mintIntegrationKey, OV_ROUTES, putAttachment, putVisit, sha256Hex } from './api'
import { newVisitDoc } from './doc'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => { vi.unstubAllGlobals() })

describe('object-visits api', () => {
  it('sha256Hex is the hex SHA-256 of the bytes', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('PUT returns the accepted answer, and a revision conflict as a VALUE (bare or under detail)', async () => {
    const doc = newVisitDoc({ object: { id: 'o', name: 'O' }, checklist: null })
    const visit = { ...doc, revision: 2, ready: true, missing: [] }
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(200, { revision: 1, ready: true, missing: [], visit }))
      .mockResolvedValueOnce(json(409, { code: 'revision_conflict', revision: 2, visit }))
      .mockResolvedValueOnce(json(409, { detail: { code: 'revision_conflict', revision: 2, visit } }))
    vi.stubGlobal('fetch', fetch)
    const body = { opId: 'ovo1-ab', baseRevision: null, doc }
    expect((await putVisit(doc.id, body)).kind).toBe('accepted')
    expect(await putVisit(doc.id, body)).toMatchObject({ kind: 'conflict', revision: 2 })
    expect(await putVisit(doc.id, body)).toMatchObject({ kind: 'conflict', revision: 2 })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(OV_ROUTES.visit(doc.id))
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toMatchObject({ opId: 'ovo1-ab', baseRevision: null })
  })

  it('every other refusal throws the app\'s ApiError with its code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(404, { detail: { code: 'object_visits_disabled' } })))
    const doc = newVisitDoc({ object: { id: 'o', name: 'O' }, checklist: null })
    const e = await putVisit(doc.id, { opId: 'ovo1-ab', baseRevision: null, doc }).catch((x) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(isModuleDisabled(e)).toBe(true)
  })

  it('an attachment goes up raw with its type and X-Content-SHA256', async () => {
    const fetch = vi.fn().mockResolvedValue(json(201, { id: 'ova1', sha256: 'h', size: 3 }))
    vi.stubGlobal('fetch', fetch)
    await putAttachment('ov1-ab', 'ova1', new Blob(['abc']), 'image/jpeg', 'h')
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/object-visits/ov1-ab/attachments/ova1')
    expect(init.headers).toMatchObject({ 'Content-Type': 'image/jpeg', 'X-Content-SHA256': 'h' })
    expect(init.body).toBeInstanceOf(Blob)
  })

  it('an answer that does not name this photo and hash is NOT an upload (captive portal, proxy)', async () => {
    const blob = new Blob(['abc'])
    for (const res of [
      new Response('<html>Login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      json(200, { id: 'other', sha256: 'h', size: 3 }),
      json(201, { id: 'ova1', sha256: 'different', size: 3 }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res))
      const e = await putAttachment('ov1-ab', 'ova1', blob, 'image/jpeg', 'h').catch((x) => x)
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(0)
    }
  })

  it('mints a 32-byte base64url key', () => {
    const k = mintIntegrationKey()
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(mintIntegrationKey()).not.toBe(k)
  })
})
