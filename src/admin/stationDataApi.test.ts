import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiGet = vi.fn()
const apiPost = vi.fn()
const apiPut = vi.fn()
const apiUpload = vi.fn()
vi.mock('../lib/api', () => ({
  apiGet: (p: string) => apiGet(p),
  apiPost: (p: string, b: unknown) => apiPost(p, b),
  apiPut: (p: string, b: unknown) => apiPut(p, b),
  apiUpload: (p: string, f: FormData, m?: string) => apiUpload(p, f, m),
}))

import {
  checklistUploadBlob,
  deleteChecklistDatasets,
  groupChecklists,
  normaliseObjectKey,
  objectIdForKey,
  parseChecklistTemplate,
  saveObject,
  uploadPlan,
} from './stationDataApi'

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── object ids ────────────────────────────────────────────────────────────────

/**
 * The contract with `backend/app/admin_objects.py · object_id_for_key`. These are not invented
 * expectations: each was produced by the Python helper itself
 * (`uuid5(uuid5(NAMESPACE_URL, 'https://kp-front.ch/einsatzobjekte'), ' '.join(key.split()).casefold())`).
 *
 * ⚠️ If this fails after a change here, the browser and the CLI have started addressing DIFFERENT
 * Einsatzobjekte for the same key — which shows up not as an error but as a duplicate object
 * with half the plans on each. Fix the code, never the expectation.
 */
describe('objectIdForKey — the same uuid5 the admin_objects CLI derives', () => {
  const vectors: [string, string][] = [
    ['schulhaus-dorfmatt', 'f4db7b86-e0fb-5ba7-856d-8e356d2ff3af'],
    ['Altersheim Sonnhalde', '9acb06ae-bc5e-59f7-b790-4c4b58143991'],
    ['ÜBUNGSOBJEKT', 'db9686bb-7381-5c80-b0ca-88e736605dca'],
  ]
  for (const [key, expected] of vectors) {
    it(`${key} → ${expected}`, async () => {
      expect(await objectIdForKey(key)).toBe(expected)
    })
  }

  it('collapses whitespace and case exactly like the CLI, so a retyped key still hits', async () => {
    expect(await objectIdForKey('  Schulhaus   Dorfmatt  ')).toBe('45681346-f331-573e-8ef7-b0c686f79062')
    expect(await objectIdForKey('schulhaus dorfmatt')).toBe('45681346-f331-573e-8ef7-b0c686f79062')
  })

  // Python's casefold() folds ß to ss; JS toLowerCase() does not. A Swiss station types both.
  it('folds ß to ss, like casefold() and unlike toLowerCase()', async () => {
    expect(normaliseObjectKey('Straßenmeisterei')).toBe('strassenmeisterei')
    expect(await objectIdForKey('Straßenmeisterei')).toBe('758d776e-e72b-52bc-951e-a97de10f5ee3')
    expect(await objectIdForKey('Strassenmeisterei')).toBe('758d776e-e72b-52bc-951e-a97de10f5ee3')
  })

  it('refuses an empty key rather than deriving the namespace itself', async () => {
    await expect(objectIdForKey('   ')).rejects.toThrow()
  })
})

// ─── the two writes ObjectSheet mocks away ─────────────────────────────────────
//
// ObjectSheet.test.tsx replaces `saveObject` and `uploadPlan` with `vi.fn()`s, so the requests
// themselves – the verb and the multipart fields – were asserted nowhere. Both are contracts with
// the backend rather than internal detail, and both fail QUIETLY when broken: the wrong verb
// creates a SECOND object under a server-chosen id, and a missing `source_note` costs the only
// record of which file a Modul-PDF came from.

describe('saveObject – PUT, because the id is derived and the call has to upsert', () => {
  it('PUTs to /api/objects/{id}', async () => {
    apiPut.mockResolvedValue({})
    await saveObject('45681346-f331-573e-8ef7-b0c686f79062', {
      name: 'Schulhaus Dorfmatt', address: 'Dorfmattweg 4', lat: 47.46, lng: 7.55, source_note: 'Planordner 2026',
    })
    // ⚠️ NOT POST /api/objects: that route mints its own id, so the same Einsatzobjekt would end
    // up twice – once under the uuid5 of its key (where the CLI and every later edit look for it)
    // and once under a random one, with half the Modul-PDFs on each.
    expect(apiPut).toHaveBeenCalledWith('/api/objects/45681346-f331-573e-8ef7-b0c686f79062', expect.anything())
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('sends `source_note` – where this object came from, and the only place it is recorded', async () => {
    apiPut.mockResolvedValue({})
    const body = {
      name: 'Altersheim Sonnhalde', address: null, lat: null, lng: null, source_note: 'Planordner 2026',
    }
    await saveObject('9acb06ae-bc5e-59f7-b790-4c4b58143991', body)
    expect(apiPut.mock.calls[0][1]).toEqual(body)
  })

  it('escapes the id rather than letting it walk the path', async () => {
    apiPut.mockResolvedValue({})
    await saveObject('a/b c', { name: 'x', address: null, lat: null, lng: null, source_note: null })
    expect(apiPut.mock.calls[0][0]).toBe('/api/objects/a%2Fb%20c')
  })
})

describe('uploadPlan – the Modul-PDF, and the filename that says which sheet it is', () => {
  const pdf = () => new File(['%PDF-1.7'], 'Schulhaus Modul 3.pdf', { type: 'application/pdf' })

  it('PUTs the file to /api/objects/{id}/plans/{module}', async () => {
    apiUpload.mockResolvedValue({})
    const file = pdf()
    await uploadPlan('45681346-f331-573e-8ef7-b0c686f79062', 'modul3', file)
    const [path, form, method] = apiUpload.mock.calls[0] as [string, FormData, string | undefined]
    expect(path).toBe('/api/objects/45681346-f331-573e-8ef7-b0c686f79062/plans/modul3')
    // ⚠️ PUT is what makes a corrected sheet REPLACE the plan (store_plan bumps its version
    // under the same `plan:<object>:<module>` id). apiUpload defaults to POST, and the route is
    // registered as PUT only – so the default would 405 every upload.
    expect(method).toBe('PUT')
    // appended WITH its filename (`form.append('file', file, file.name)`), which is what the
    // server files the plan under – an unnamed part arrives as «blob»
    expect(form.get('file')).toMatchObject({ name: file.name, type: 'application/pdf' })
  })

  it('sends the filename as `source_note`, so the stored plan says which file it is', async () => {
    apiUpload.mockResolvedValue({})
    await uploadPlan('obj', 'modul3', pdf())
    const form = apiUpload.mock.calls[0][1] as FormData
    expect(form.get('source_note')).toBe('Schulhaus Modul 3.pdf')
    // no sha256: objects.py:143-147 exempts a person picking a file in the form from the digest
    // a machine publish must send
    expect([...form.keys()].sort()).toEqual(['file', 'source_note'])
  })

  it('escapes both the object id and the module', async () => {
    apiUpload.mockResolvedValue({})
    await uploadPlan('a/b', 'modul 3', pdf())
    expect(apiUpload.mock.calls[0][0]).toBe('/api/objects/a%2Fb/plans/modul%203')
  })
})

// ─── checklists ────────────────────────────────────────────────────────────────

const ds = (id: string) => ({
  id,
  object_id: null,
  module: null,
  kind: 'checklists',
  title: id,
  source_type: 'uploaded',
  source_note: null,
  content_type: 'application/json',
  size_bytes: 10,
  feature_count: null,
  current_version: 1,
  updated_at: '2026-08-16T10:00:00Z',
})

describe('groupChecklists', () => {
  it('files diagram assets under their template', () => {
    const { rows, orphanAssets } = groupChecklists([
      ds('checklists:el-playbook'),
      ds('checklists:el-playbook:p12'),
      ds('checklists:el-playbook:p14'),
      ds('checklists:fu-aktion'),
      ds('geo:hydrant'),
    ])
    expect(rows.map((r) => r.slug)).toEqual(['el-playbook', 'fu-aktion'])
    expect(rows[0].assets.map((a) => a.id)).toEqual(['checklists:el-playbook:p12', 'checklists:el-playbook:p14'])
    expect(orphanAssets).toEqual([])
  })

  it('surfaces a renamed template’s leftover diagrams instead of hiding them', () => {
    const { rows, orphanAssets } = groupChecklists([
      ds('checklists:el-playbook-2026'),
      ds('checklists:el-playbook:p12'),
    ])
    expect(rows.map((r) => r.slug)).toEqual(['el-playbook-2026'])
    expect(orphanAssets.map((a) => a.id)).toEqual(['checklists:el-playbook:p12'])
  })
})

describe('deleteChecklistDatasets — the keep-list is the payload', () => {
  it('re-reads the registry and keeps every OTHER checklist dataset', async () => {
    apiGet.mockResolvedValue([
      ds('checklists:fu-aktion'),
      ds('checklists:el-playbook'),
      ds('checklists:el-playbook:p12'),
      ds('geo:hydrant'),
      ds('symbols:tactical'),
    ])
    apiPost.mockResolvedValue({ pruned: ['checklists:el-playbook', 'checklists:el-playbook:p12'] })

    await deleteChecklistDatasets(['checklists:el-playbook', 'checklists:el-playbook:p12'])

    // the listing is re-read at delete time, not taken from a render that may be minutes old
    expect(apiGet).toHaveBeenCalledWith('/api/reference')
    expect(apiPost).toHaveBeenCalledWith('/api/reference/checklists/prune', ['checklists:fu-aktion'])
  })

  it('never lists a non-checklist dataset — prune only ever touches checklists:*', async () => {
    apiGet.mockResolvedValue([ds('checklists:fu-aktion'), ds('geo:hydrant')])
    apiPost.mockResolvedValue({ pruned: [] })
    await deleteChecklistDatasets(['checklists:nonexistent'])
    expect(apiPost).toHaveBeenCalledWith('/api/reference/checklists/prune', ['checklists:fu-aktion'])
  })
})

// ─── template validation ───────────────────────────────────────────────────────

const MSG = {
  notJson: 'notJson',
  notObject: 'notObject',
  fieldMissing: 'missing:{field}',
  badKind: 'badKind:{kind}',
  needsPhasesOrEntries: 'needsOne',
  badId: 'badId',
}

describe('parseChecklistTemplate — the same refusals as the server, without the round trip', () => {
  const good = {
    id: 'fu-aktion',
    kind: 'action',
    title: 'Aufgaben FU',
    version: 1,
    source: 'Checklisten FU.pdf',
    phases: [{ id: 'p1', title: 'Erkundung', items: [] }],
  }

  it('accepts a well-formed action template', () => {
    const res = parseChecklistTemplate(JSON.stringify(good), MSG)
    expect(res).toMatchObject({ ok: true, value: { id: 'fu-aktion', kind: 'action', sections: 1 } })
  })

  it.each([
    ['not json at all', 'nope{', 'notJson'],
    ['a bare array', '[]', 'notObject'],
    ['a missing title', JSON.stringify({ ...good, title: '  ' }), 'missing:title'],
    ['an unknown kind', JSON.stringify({ ...good, kind: 'playbook' }), 'badKind:playbook'],
    ['neither phases nor entries', JSON.stringify({ ...good, phases: [] }), 'needsOne'],
    ['both phases and entries', JSON.stringify({ ...good, entries: [{ id: 'e' }] }), 'needsOne'],
    // a colon would forge a diagram-asset id (`checklists:<slug>:p<N>`)
    ['a colon in the id', JSON.stringify({ ...good, id: 'el:p12' }), 'badId'],
  ])('refuses %s', (_case, text, error) => {
    expect(parseChecklistTemplate(text, MSG)).toEqual({ ok: false, error })
  })
})

describe('checklistUploadBlob', () => {
  it('stamps the rail order into the uploaded copy, like admin_checklists._template_bytes', async () => {
    const parsed = parseChecklistTemplate(
      JSON.stringify({ id: 'x', kind: 'reference', title: 'X', entries: [{ id: 'e' }] }),
      MSG,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const written = JSON.parse(await checklistUploadBlob(parsed.value, 3).text())
    expect(written).toMatchObject({ id: 'x', kind: 'reference', order: 3 })
  })
})
