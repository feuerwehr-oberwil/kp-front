// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Station boxes with a schema length (configGuards · TEXT_MAX_LENGTH). The config is one
// document with an autosave, so a value the API refuses for its length would stop every Station
// page from saving. Each box carries the bound as `maxLength`, which holds typing and pasting to
// it in a browser; jsdom does not enforce it, so what is typed past it here is what a chip or a
// derived Kennung could produce — and it must stay in the form, unsent.

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }))
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiGet, apiPut }
})

import { ConfigProvider } from './ConfigContext'
import { ReportSection } from './ConfigSections'
import { ObjectCategoriesCard } from './ObjectCategoriesCard'
import { ProposalFieldsEditor } from './ObjectVisitsView'
import { TEXT_MAX_LENGTH } from './configGuards'
import { REPORT_LINK_TOKENS } from '../lib/reportLinks'
import { appConfig } from '../config/appConfig'
import type { DeploymentConfig } from '../lib/deploymentConfig'

const STATION = {
  version: 'v1',
  map: { objectCategories: [] },
  report: { reversePrintOrder: true, links: [], partnerOrgs: [] },
  objectVisits: { proposalFields: [] },
}

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1200) })
/** The most recent PUT body. */
const sent = () => apiPut.mock.calls[apiPut.mock.calls.length - 1]?.[1] as DeploymentConfig | undefined
const type = (el: Element, value: string) => act(async () => { fireEvent.change(el, { target: { value } }) })
const box = (placeholder: string) => screen.getByPlaceholderText(placeholder) as HTMLInputElement

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiGet.mockReset().mockResolvedValue(structuredClone(STATION))
  apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function mount(node: React.ReactNode, add: string) {
  await act(async () => { render(<ConfigProvider>{node}</ConfigProvider>) })
  const button = await waitFor(() => screen.getByRole('button', { name: add }))
  fireEvent.click(button)
}

describe('report.links — a Formular on the Rapport', () => {
  const R = appConfig.copy.admin.report

  it('holds a title past 120 characters in the form', async () => {
    await mount(<ReportSection />, R.linkAdd)
    expect(box(R.linkTitlePlaceholder).maxLength).toBe(TEXT_MAX_LENGTH['report.links.0.title'])
    expect(box(R.linkNotePlaceholder).maxLength).toBe(TEXT_MAX_LENGTH['report.links.0.note'])
    await type(screen.getByPlaceholderText(R.linkUrlPlaceholder), 'https://formulare.example/schaden')
    await type(box(R.linkTitlePlaceholder), 'T'.repeat(121))
    await settle()
    expect(sent()?.report?.links ?? []).toEqual([])
    await type(box(R.linkTitlePlaceholder), 'Schadenmeldung')
    await settle()
    expect(sent()?.report?.links?.map((l) => l.title)).toEqual(['Schadenmeldung'])
  })
})

describe('report.links — a paste past the URL bound', () => {
  // a browser cuts a paste to `maxLength`; a prefill URL cut short still opens, without its last
  // parameters – so the box has no maxLength and the change is refused whole
  it('keeps the saved URL instead of a cut one', async () => {
    const R = appConfig.copy.admin.report
    const url = 'https://formulare.example/?nr={einsatzNr}'
    const link = { id: 'lnk1', title: 'Schadenmeldung', url }
    apiGet.mockResolvedValue({ ...structuredClone(STATION), report: { ...STATION.report, links: [link] } })
    await act(async () => { render(<ConfigProvider><ReportSection /></ConfigProvider>) })
    const area = await waitFor(() => screen.getByPlaceholderText(R.linkUrlPlaceholder) as HTMLTextAreaElement)
    expect(area.maxLength).toBe(-1)
    await type(area, `${url}&q=${'x'.repeat(TEXT_MAX_LENGTH['report.links.0.url'])}`)
    await settle()
    expect(area.value).toBe(url)
    expect(apiPut).not.toHaveBeenCalled()
  })
})

describe('report.links — a token chip at the URL bound', () => {
  it('leaves a saved link as it is instead of pushing it past 2048 characters', async () => {
    const url = `https://formulare.example/?q=${'x'.repeat(TEXT_MAX_LENGTH['report.links.0.url'] - 31)}`
    const link = { id: 'lnk1', title: 'Schadenmeldung', url }
    apiGet.mockResolvedValue({ ...structuredClone(STATION), report: { ...STATION.report, links: [link] } })
    await act(async () => { render(<ConfigProvider><ReportSection /></ConfigProvider>) })
    const chip = await waitFor(() => screen.getByRole('button', { name: `{${REPORT_LINK_TOKENS[0]}}` }))
    await act(async () => { fireEvent.click(chip) })
    await settle()
    expect((screen.getByDisplayValue(url) as HTMLTextAreaElement).value).toBe(url)
    expect(apiPut).not.toHaveBeenCalled()
  })
})

describe('objectVisits.proposalFields — a Korrekturvorschlag field', () => {
  const T = appConfig.copy.admin.objectVisits

  it('holds a label past 120 characters in the form, and its Kennung to 64', async () => {
    await mount(<ProposalFieldsEditor />, T.fieldAdd)
    expect(box(T.fieldLabelPlaceholder).maxLength).toBe(TEXT_MAX_LENGTH['objectVisits.proposalFields.0.label'])
    expect(box(T.fieldIdPlaceholder).maxLength).toBe(TEXT_MAX_LENGTH['objectVisits.proposalFields.0.id'])
    await type(box(T.fieldLabelPlaceholder), 'Bezeichnung '.repeat(11))
    // the Kennung follows the label, cut to its own bound
    expect(box(T.fieldIdPlaceholder).value).toHaveLength(TEXT_MAX_LENGTH['objectVisits.proposalFields.0.id'])
    await settle()
    expect(sent()?.objectVisits?.proposalFields ?? []).toEqual([])
  })
})

describe('map.objectCategories — the plan modules of a colour rule', () => {
  const M = appConfig.copy.admin.map

  it('holds each module glob to 60 characters', async () => {
    await mount(<ObjectCategoriesCard />, M.catAdd)
    await type(box(M.catNamePlaceholder), 'Photovoltaik')
    await type(box(M.catModulesPlaceholder), `modul5-pv*, ${'m'.repeat(70)}`)
    await settle()
    expect(sent()?.map?.objectCategories?.[0]?.match?.modules).toEqual(['modul5-pv*', 'm'.repeat(60)])
  })

  it('cuts by character, never through one', async () => {
    await mount(<ObjectCategoriesCard />, M.catAdd)
    await type(box(M.catNamePlaceholder), 'Photovoltaik')
    await type(box(M.catModulesPlaceholder), `${'m'.repeat(59)}🚒x`)
    await settle()
    expect(sent()?.map?.objectCategories?.[0]?.match?.modules).toEqual([`${'m'.repeat(59)}🚒`])
  })
})

// Sweep 26.11.2026: a cut Kennung could equal a LATER, saved field's – and that saved field took
// «Diese Kennung gibt es schon» and left the save.
describe('objectVisits.proposalFields — two fields with one Kennung', () => {
  const T = appConfig.copy.admin.objectVisits

  it('holds the row being edited and keeps the saved field it now collides with', async () => {
    const fields = [{ id: 'eigentuemer', label: 'Eigentümer' }, { id: 'kontakt', label: 'Kontakt' }]
    apiGet.mockResolvedValue({ ...structuredClone(STATION), objectVisits: { proposalFields: fields } })
    await act(async () => { render(<ConfigProvider><ProposalFieldsEditor /></ConfigProvider>) })
    const [first] = await waitFor(() => screen.getAllByPlaceholderText(T.fieldIdPlaceholder))
    await type(first, 'kontakt')
    await settle()
    expect(sent()?.objectVisits?.proposalFields).toEqual([{ id: 'kontakt', label: 'Kontakt' }])
    const warning = screen.getByText(T.fieldDuplicate)
    expect(warning.closest('.adm-rec')?.contains(first)).toBe(true)
  })

  it('warns a new row given a taken Kennung before its label', async () => {
    apiGet.mockResolvedValue({ ...structuredClone(STATION), objectVisits: { proposalFields: [{ id: 'kontakt', label: 'Kontakt' }] } })
    await mount(<ProposalFieldsEditor />, T.fieldAdd)
    await type(screen.getAllByPlaceholderText(T.fieldIdPlaceholder)[1], 'kontakt')
    await settle()
    expect(screen.getByText(T.fieldDuplicate)).toBeTruthy()
    // the document is what was stored – nothing to send
    expect(apiPut).not.toHaveBeenCalled()
  })
})

// …and a row held for its length said nothing: it stayed in the form and out of the save.
describe('a row held for its length names the limit', () => {
  const R = appConfig.copy.admin.report
  const T = appConfig.copy.admin.objectVisits
  const M = appConfig.copy.admin.map
  const line = (label: string, n: number) => screen.queryByText(`${label}: höchstens ${n} Zeichen – so wird der Eintrag nicht gespeichert.`)

  it('says so under a title typed past the limit, and not once it fits', async () => {
    await mount(<ReportSection />, R.linkAdd)
    await type(screen.getByPlaceholderText(R.linkUrlPlaceholder), 'https://formulare.example/schaden')
    await type(box(R.linkTitlePlaceholder), 'T'.repeat(121))
    expect(line(R.linkTitle, 120)).not.toBeNull()
    await type(box(R.linkTitlePlaceholder), 'T'.repeat(120))
    expect(line(R.linkTitle, 120)).toBeNull()
  })

  it('says so under a stored field that is already over the limit', async () => {
    const fields = [{ id: 'lang', label: 'L'.repeat(121) }, { id: 'kurz', label: 'Kurz' }]
    apiGet.mockResolvedValue({ ...structuredClone(STATION), objectVisits: { proposalFields: fields } })
    await act(async () => { render(<ConfigProvider><ProposalFieldsEditor /></ConfigProvider>) })
    const note = await waitFor(() => line(T.fieldLabel, 120)!)
    expect(note.closest('.adm-rec')?.textContent).toContain('lang')
    expect(screen.getAllByText(/höchstens/)).toHaveLength(1)
  })

  it('says so under a stored colour rule with a module glob past 60', async () => {
    const rule = { id: 'pv', label: 'Photovoltaik', color: '#f59e0b', match: { modules: ['m'.repeat(61)] } }
    apiGet.mockResolvedValue({ ...structuredClone(STATION), map: { objectCategories: [rule] } })
    await act(async () => { render(<ConfigProvider><ObjectCategoriesCard /></ConfigProvider>) })
    await waitFor(() => expect(line(M.catModules, 60)).not.toBeNull())
  })
})

// Sweep 25.11.2026 (config-keep-row): the server serves a stored row past its bound as stored
// (#813), and an edit of ANOTHER row of its list saved the list without it. It stays in the save
// as stored – the server then refuses the save – until the admin shortens or deletes it.
describe('a stored row past its bound stays in the save', () => {
  const R = appConfig.copy.admin.report
  const T = appConfig.copy.admin.objectVisits
  const M = appConfig.copy.admin.map
  const remove = async (label: string, i: number) => {
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: label })[i]) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: appConfig.copy.admin.common.confirmYes })) })
  }
  /** The body of a PUT made after this call – never one sent before it. */
  const nextPut = async () => {
    const before = apiPut.mock.calls.length
    await settle()
    expect(apiPut.mock.calls.length).toBeGreaterThan(before)
    return sent()
  }

  describe('Formulare & Links', () => {
    const long = { id: 'lnk1', title: 'T'.repeat(130), url: 'https://formulare.example/lang' }
    const ok = { id: 'lnk2', title: 'Schaden', url: 'https://formulare.example/schaden' }
    const titles = () => screen.getAllByPlaceholderText(R.linkTitlePlaceholder)
    const urls = () => screen.getAllByPlaceholderText(R.linkUrlPlaceholder)
    beforeEach(() => { apiGet.mockResolvedValue({ ...structuredClone(STATION), report: { ...STATION.report, links: [long, ok] } }) })

    it('keeps the stored link through an edit of another one, and while it is still too long', async () => {
      await act(async () => { render(<ConfigProvider><ReportSection /></ConfigProvider>) })
      await type((await waitFor(titles))[1], 'Schadenmeldung')
      expect((await nextPut())?.report?.links).toEqual([long, { ...ok, title: 'Schadenmeldung' }])
      await type(titles()[0], 'T'.repeat(125))
      await type(titles()[1], 'Schadenmeldung 2')
      expect((await nextPut())?.report?.links).toEqual([long, { ...ok, title: 'Schadenmeldung 2' }])
    })

    it('saves it once shortened', async () => {
      await act(async () => { render(<ConfigProvider><ReportSection /></ConfigProvider>) })
      await type((await waitFor(titles))[0], 'T'.repeat(120))
      expect((await nextPut())?.report?.links).toEqual([{ ...long, title: 'T'.repeat(120) }, ok])
    })

    it('saves the list without it once deleted while still too long', async () => {
      await act(async () => { render(<ConfigProvider><ReportSection /></ConfigProvider>) })
      await waitFor(titles)
      await remove(R.linkRemove, 0)
      expect((await nextPut())?.report?.links).toEqual([ok])
    })

    it('falls back to the stored link while a repair is not saved yet', async () => {
      await act(async () => { render(<ConfigProvider><ReportSection /></ConfigProvider>) })
      await type((await waitFor(titles))[0], 'T'.repeat(120))
      // …the URL cleared before the autosave ran: the shortened title never reached the server
      await type(urls()[0], '')
      await type(titles()[1], 'Schadenmeldung')
      expect((await nextPut())?.report?.links).toEqual([long, { ...ok, title: 'Schadenmeldung' }])
    })

    it('treats a link saved short as an ordinary one: a half-typed edit of it is held back', async () => {
      await act(async () => { render(<ConfigProvider><ReportSection /></ConfigProvider>) })
      await type((await waitFor(titles))[0], 'Kurz')
      await nextPut()
      await type(urls()[0], '')
      expect((await nextPut())?.report?.links).toEqual([ok])
    })

    it('lets the admin shorten a stored URL past its bound', async () => {
      const url = `https://formulare.example/?q=${'x'.repeat(TEXT_MAX_LENGTH['report.links.0.url'])}`
      apiGet.mockResolvedValue({ ...structuredClone(STATION), report: { ...STATION.report, links: [{ ...ok, url }] } })
      await act(async () => { render(<ConfigProvider><ReportSection /></ConfigProvider>) })
      const area = await waitFor(() => screen.getByPlaceholderText(R.linkUrlPlaceholder) as HTMLTextAreaElement)
      await type(area, url.slice(0, -1))
      expect(area.value).toBe(url.slice(0, -1))
    })
  })

  describe('Korrekturvorschlag fields', () => {
    const long = { id: 'lang', label: 'L'.repeat(121) }
    const ok = { id: 'kurz', label: 'Kurz' }
    const labels = () => screen.getAllByPlaceholderText(T.fieldLabelPlaceholder)
    beforeEach(() => { apiGet.mockResolvedValue({ ...structuredClone(STATION), objectVisits: { proposalFields: [long, ok] } }) })

    it('keeps the stored field through an edit of another one', async () => {
      await act(async () => { render(<ConfigProvider><ProposalFieldsEditor /></ConfigProvider>) })
      await type((await waitFor(labels))[1], 'Kurz Name')
      expect((await nextPut())?.objectVisits?.proposalFields).toEqual([long, { id: 'kurz_name', label: 'Kurz Name' }])
    })

    it('keeps only a row past a length: a stored blank one is left out as before', async () => {
      apiGet.mockResolvedValue({ ...structuredClone(STATION), objectVisits: { proposalFields: [{ id: 'leer', label: ' ' }, ok] } })
      await act(async () => { render(<ConfigProvider><ProposalFieldsEditor /></ConfigProvider>) })
      await type((await waitFor(labels))[1], 'Kurz Name')
      expect((await nextPut())?.objectVisits?.proposalFields).toEqual([{ id: 'kurz_name', label: 'Kurz Name' }])
    })

    it('keeps it exactly as stored, untrimmed', async () => {
      const padded = { ...long, label: ` ${long.label}` }
      apiGet.mockResolvedValue({ ...structuredClone(STATION), objectVisits: { proposalFields: [padded, ok] } })
      await act(async () => { render(<ConfigProvider><ProposalFieldsEditor /></ConfigProvider>) })
      await type((await waitFor(labels))[1], 'Kurz Name ')
      expect((await nextPut())?.objectVisits?.proposalFields).toEqual([padded, { id: 'kurz_name', label: 'Kurz Name' }])
    })

    it('saves it once shortened', async () => {
      await act(async () => { render(<ConfigProvider><ProposalFieldsEditor /></ConfigProvider>) })
      await type((await waitFor(labels))[0], 'L'.repeat(120))
      expect((await nextPut())?.objectVisits?.proposalFields).toEqual([{ ...long, label: 'L'.repeat(120) }, ok])
    })

    it('saves the list without it once deleted while still too long', async () => {
      await act(async () => { render(<ConfigProvider><ProposalFieldsEditor /></ConfigProvider>) })
      await waitFor(labels)
      await remove(T.fieldRemove, 0)
      expect((await nextPut())?.objectVisits?.proposalFields).toEqual([ok])
    })

    it('falls back to the stored field while a repair is not saved yet', async () => {
      await act(async () => { render(<ConfigProvider><ProposalFieldsEditor /></ConfigProvider>) })
      await type((await waitFor(labels))[0], 'L'.repeat(120))
      await type(labels()[0], '')
      await type(labels()[1], 'Kurz Name')
      expect((await nextPut())?.objectVisits?.proposalFields).toEqual([long, { id: 'kurz_name', label: 'Kurz Name' }])
    })
  })

  describe('Objektfarben', () => {
    const long = { id: 'pv', label: 'Photovoltaik', color: '#f59e0b', match: { modules: ['m'.repeat(61)] } }
    const ok = { id: 'rest', label: 'Rest', color: '#64748b', match: { kinds: ['objekt'] } }
    const names = () => screen.getAllByPlaceholderText(M.catNamePlaceholder)
    const modules = () => screen.getAllByPlaceholderText(M.catModulesPlaceholder)[0] as HTMLInputElement
    beforeEach(() => { apiGet.mockResolvedValue({ ...structuredClone(STATION), map: { objectCategories: [long, ok] } }) })

    it('keeps the stored rule through an edit of another one', async () => {
      await act(async () => { render(<ConfigProvider><ObjectCategoriesCard /></ConfigProvider>) })
      await type((await waitFor(names))[1], 'Andere')
      expect((await nextPut())?.map?.objectCategories).toEqual([long, { ...ok, id: 'andere', label: 'Andere' }])
    })

    it('saves it once shortened', async () => {
      await act(async () => { render(<ConfigProvider><ObjectCategoriesCard /></ConfigProvider>) })
      await waitFor(names)
      await type(modules(), 'm'.repeat(60))
      expect((await nextPut())?.map?.objectCategories).toEqual([{ ...long, match: { modules: ['m'.repeat(60)] } }, ok])
    })

    it('saves the list without it once deleted while still too long', async () => {
      await act(async () => { render(<ConfigProvider><ObjectCategoriesCard /></ConfigProvider>) })
      await waitFor(names)
      await remove(M.catRemove, 0)
      expect((await nextPut())?.map?.objectCategories).toEqual([ok])
    })

    it('keeps an untouched glob with a line break as stored, which the box shows without it', async () => {
      const glob = `${'a'.repeat(30)}\n${'a'.repeat(30)}`
      const stored = { ...long, match: { modules: [glob, 'kurz'] } }
      apiGet.mockResolvedValue({ ...structuredClone(STATION), map: { objectCategories: [stored, ok] } })
      await act(async () => { render(<ConfigProvider><ObjectCategoriesCard /></ConfigProvider>) })
      await waitFor(names)
      // what a browser hands the handler: the text as shown, line break gone
      await type(modules(), `${'a'.repeat(60)}, kurz2`)
      await type(names()[1], 'Andere')
      expect((await nextPut())?.map?.objectCategories?.[0]).toEqual(stored)
    })

    it('never cuts a stored glob: an edit of the box keeps it, shortening it is the admin\'s', async () => {
      const stored = { ...long, match: { modules: ['modul5-pv*', 'm'.repeat(70)] } }
      apiGet.mockResolvedValue({ ...structuredClone(STATION), map: { objectCategories: [stored, ok] } })
      await act(async () => { render(<ConfigProvider><ObjectCategoriesCard /></ConfigProvider>) })
      await waitFor(names)
      await type(modules(), `modul6-pv*, ${'m'.repeat(70)}`)
      await type(names()[1], 'Andere')
      expect(modules().value).toBe(`modul6-pv*, ${'m'.repeat(70)}`)
      expect((await nextPut())?.map?.objectCategories?.[0]).toEqual(stored)
      await type(modules(), `modul6-pv*, ${'m'.repeat(70)}*`)
      expect(modules().value).toBe(`modul6-pv*, ${'m'.repeat(70)}*`)
      // a comma typed into it leaves a fragment still past the cap – not cut either
      await type(modules(), `modul6-pv*, m,${'m'.repeat(69)}*`)
      expect(modules().value).toBe(`modul6-pv*, m, ${'m'.repeat(69)}*`)
      await type(modules(), `modul6-pv*, ${'m'.repeat(69)}`)
      expect(modules().value).toBe(`modul6-pv*, ${'m'.repeat(69)}`)
      await type(names()[1], 'Andere 2')
      expect((await nextPut())?.map?.objectCategories?.[0]).toEqual(stored)
    })
  })
})

// Lead review of #834 (S4): rows are keyed by index, so an armed «Löschen?» stayed at its index
// when the rows moved and deleted the row that came there.
describe('an armed delete never lands on another row', () => {
  const T = appConfig.copy.admin.objectVisits
  const M = appConfig.copy.admin.map
  const yes = () => screen.queryAllByRole('button', { name: appConfig.copy.admin.common.confirmYes })
  const click = (el: Element) => act(async () => { fireEvent.click(el) })

  it('Objektfarben: a move drops it', async () => {
    const rule = (id: string) => ({ id, label: id, color: '#64748b', match: { kinds: ['objekt'] } })
    apiGet.mockResolvedValue({ ...structuredClone(STATION), map: { objectCategories: [rule('a'), rule('b')] } })
    await act(async () => { render(<ConfigProvider><ObjectCategoriesCard /></ConfigProvider>) })
    await click((await waitFor(() => screen.getAllByRole('button', { name: M.catRemove })))[0])
    expect(yes()).toHaveLength(1)
    await click(screen.getAllByRole('button', { name: M.catDown })[0])
    expect(yes()).toHaveLength(0)
  })

  it('Korrekturvorschlag fields: deleting a row above drops it', async () => {
    const fields = ['a', 'b', 'c'].map((id) => ({ id, label: id }))
    apiGet.mockResolvedValue({ ...structuredClone(STATION), objectVisits: { proposalFields: fields } })
    await act(async () => { render(<ConfigProvider><ProposalFieldsEditor /></ConfigProvider>) })
    await click((await waitFor(() => screen.getAllByRole('button', { name: T.fieldRemove })))[1])
    await click(screen.getAllByRole('button', { name: T.fieldRemove })[0])
    expect(yes()).toHaveLength(2)
    await click(yes()[0])
    expect(yes()).toHaveLength(0)
    expect(screen.getAllByPlaceholderText(T.fieldIdPlaceholder).map((el) => (el as HTMLInputElement).value)).toEqual(['b', 'c'])
  })
})
