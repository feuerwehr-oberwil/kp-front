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
