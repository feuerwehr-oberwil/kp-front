// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// «Links & Zugänge» is six surfaces in one list — one RECORD CARD per address since the admin
// got its one grammar (13.09.) — and what the consolidation can get wrong is exactly what is
// pinned here:
//
//   · every configured card shows ITS OWN address, once — four cards built from four endpoints
//     is four chances to hand out the wrong one, or the same one twice.
//   · the page is ADDRESSES. The Einsatz-Link minting key left for «Zugangsdaten» on
//     2026-09-11 because it never had one, and the test below holds it gone: not merely
//     invisible, but not even fetched from here.
//   · ⚠️ THE TWO GENERAL GUARDS, and the reason they are written over ALL cards rather than per
//     card: (1) no card hands out the same secret twice — a key that is already inside its own
//     address never gets a second chip, because two fields holding one secret make the reader
//     guess which one to use; (2) NO chip anywhere contains `<` or `>`. Every regression of
//     this class so far has been a template string on a copy button — `/l/<token>`,
//     `?secret=<Alarm-Webhook-Secret>` — which copies clean and fails somewhere else. Where no
//     working value exists, the row says so in words.
//   · the alarm intake is two addresses on ONE key, so it is two cards — both carrying the same
//     chip, both leading to the page where that key is actually set, and both saying under the
//     address that the secret still has to be appended (it is write-only server-side, so it can
//     never be baked in).
//   · a card whose key is off offers «Aktivieren» instead of a chip nobody can use. The address
//     is derived from the key, so an off card has none — and a dead copy chip under «Adresse»
//     is the failure this page exists to end.
//   · ONE grammar, and it is the reason the page was rebuilt: every card carries exactly one ⓘ
//     (on its name) and not a single primary button. The table before it had an ⓘ in three
//     different columns and a blue «Aktivieren» beside secondary buttons and a ⋮ menu.
//   · the state chip says only the state. The card's head already names the surface, and a chip
//     carrying its own label reads «Status — Erfassung aktiv» (same bug the settings table was
//     just cured of).
//   · rotating still costs two clicks. The ⋮ menu closes on selection, so the question had to
//     be re-implemented on the card — and the thing it destroys is already hanging on a wall.

const { apiGet, apiPost, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(),
}))
vi.mock('../lib/api', () => ({ apiGet, apiPost, apiDelete }))

import { LinksView } from './LinksView'
import { appConfig } from '../config/appConfig'

const E = appConfig.copy.admin.erfassung
const I = appConfig.copy.admin.einsatzlink
const T = appConfig.copy.admin.terminal
const A = appConfig.copy.admin.atemschutzUrl
const S = appConfig.copy.admin.statistik
const L = appConfig.copy.admin.links
const D = appConfig.copy.admin.data
const Z = appConfig.copy.admin.zugaenge
const COMMON = appConfig.copy.admin.common

/** The four secret endpoints, each answering with its own key — so a row showing somebody
 *  else's address is visible as such.
 *
 *  ⚠️ `/api/incident-link/secret` is deliberately NOT in here: the minting key belongs to
 *  «Zugangsdaten» now, and a GET for it from this page falls into the rejection below. */
const KEYS: Record<string, string> = {
  '/api/capture/secret': 'cap-1',
  '/api/incident-link/terminal/secret': 'term-1',
  '/api/incident-link/atemschutz/secret': 'as-1',
  '/api/stats/secret': 'stats-1',
}

/** `configured` decides which rows are live; the credential list backs the Alarm row. */
function server(configured: (path: string) => boolean) {
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/integrations/credentials')) {
      return Promise.resolve([{ name: 'alarm_webhook_secret', configured: true }])
    }
    const token = KEYS[path]
    if (token === undefined) return Promise.reject(new Error(`unexpected GET ${path}`))
    return Promise.resolve(configured(path) ? { configured: true, token } : { configured: false })
  })
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

/** Every copy chip of one card, in order — the values this entry actually hands out. */
const chips = (card: HTMLElement): string[] =>
  [...card.querySelectorAll('.adm-copychip code')].map((c) => c.textContent ?? '')

/** The labels of a card's value rows — the note row's empty label cell is not one. */
const labels = (card: HTMLElement): string[] =>
  [...card.querySelectorAll('.lnk-rec-lbl')].map((l) => l.textContent ?? '').filter(Boolean)

describe('Links & Zugänge — one card per address', () => {
  it('gives every configured card its own address, exactly once', async () => {
    server(() => true)
    render(<LinksView />)
    const origin = window.location.origin

    await waitFor(() => expect(screen.getByText(`${origin}/e/cap-1`)).toBeTruthy())
    expect(screen.getByText(`${origin}/l/tterm-1`)).toBeTruthy()
    expect(screen.getByText(`${origin}/l/sas-1`)).toBeTruthy()
    expect(screen.getByText(`${origin}/api/stats/incidents?year=${new Date().getFullYear()}`)).toBeTruthy()
    expect(screen.getByText('stats-1')).toBeTruthy()
    // the poster's secret IS its URL, and so are the terminal's and the Atemschutz code's:
    // none of the three repeats its key on a chip beside the address
    for (const key of ['cap-1', 'term-1', 'as-1']) expect(screen.queryByText(key)).toBeNull()

    // and the two printable artefacts hang on their own cards, not on a shared action bar
    expect(screen.getByRole('button', { name: E.printBtn })).toBeTruthy()
    expect(screen.getByRole('button', { name: A.printBtn })).toBeTruthy()
  })

  it('never hands the same secret out twice, and never puts a placeholder on a copy button', async () => {
    server(() => true)
    const { container } = render(<LinksView />)

    await waitFor(() => expect(screen.getByText(`${window.location.origin}/e/cap-1`)).toBeTruthy())
    const cards = [...container.querySelectorAll('.lnk-rec')] as HTMLElement[]
    expect(cards.length).toBe(6)

    for (const card of cards) {
      const values = chips(card)
      expect(values.length).toBeGreaterThan(0)
      for (const v of values) {
        // a chip whose content has to be edited before it works is the bug this guards
        expect(v).not.toMatch(/[<>]/)
        // …and no value may hide inside another one: that is the same secret, twice
        expect(values.filter((other) => other.includes(v)).length).toBe(1)
      }
    }
  })

  it('does not carry the Einsatz-Link signing key at all — that one is a credential', async () => {
    server(() => true)
    render(<LinksView />)

    await waitFor(() => expect(screen.getByText(`${window.location.origin}/e/cap-1`)).toBeTruthy())
    // It has no address and never can have one: the alerting system signs a per-incident token
    // with it. So the row is not here, and neither is the request behind it — a page of
    // addresses does not read a key it has nothing to show for.
    expect(screen.queryByText(I.stateLabel)).toBeNull()
    expect(apiGet.mock.calls.flat()).not.toContain('/api/incident-link/secret')
  })

  it('gives every value its own labelled row, and only Statistik a second one', async () => {
    server(() => true)
    render(<LinksView />)
    await waitFor(() => expect(screen.getByText('stats-1')).toBeTruthy())

    // the cards whose key already rides in the address carry ONE row, and it says «Adresse» —
    // in the card grammar a value without a label is a value nobody can name
    for (const url of [`${window.location.origin}/l/tterm-1`, `${window.location.origin}/l/sas-1`]) {
      const card = screen.getByText(url).closest('.lnk-rec') as HTMLElement
      expect(chips(card)).toEqual([url])
      expect(labels(card)).toEqual([L.addressLabel])
    }

    // Statistik is the one card that legitimately carries two — the feed URL holds no token, the
    // token travels as a header — so it has a second row, and both say which is which
    const stats = screen.getByText('stats-1').closest('.lnk-rec') as HTMLElement
    expect(labels(stats)).toEqual([L.addressLabel, L.keyLabel])
  })

  it('splits the alarm intake into one card per address, both on the same key', async () => {
    server(() => true)
    const go = vi.fn()
    render(<LinksView onNavigate={go} />)
    const origin = window.location.origin

    await waitFor(() => expect(screen.getByText(D.genericLabel)).toBeTruthy())
    const generic = screen.getByText(D.genericLabel).closest('.lnk-rec') as HTMLElement
    const firehub = screen.getByText(D.firehubLabel).closest('.lnk-rec') as HTMLElement
    // ⚠️ The bare endpoint, without the `?secret=` the intake requires: that secret is
    // write-only in the credential table (backend · credentials.py), so no complete URL can be
    // built here — and a chip that only LOOKS complete is worse than one that says what is
    // missing. The sentence in the cell is what says it.
    expect(chips(generic)).toEqual([`${origin}/api/alarms`])
    expect(chips(firehub)).toEqual([`${origin}/api/firehub/webhook`])

    // one key behind both: same chip, same instruction, and both lead to the page that sets it
    for (const card of [generic, firehub]) {
      expect(within(card).getByText(Z.stateStored)).toBeTruthy()
      expect(within(card).getByText(L.secretAppend)).toBeTruthy()
      fireEvent.click(within(card).getByRole('button', { name: L.toCredentials }))
    }
    expect(go.mock.calls).toEqual([['zugaenge'], ['zugaenge']])
  })

  it('offers «Aktivieren» on every card whose key is off, and no address to copy', async () => {
    const off = ['/api/incident-link/atemschutz/secret', '/api/stats/secret']
    server((path) => !off.includes(path))
    render(<LinksView />)

    await waitFor(() => expect(screen.getByRole('button', { name: A.enableBtn })).toBeTruthy())
    expect(screen.queryByText(`${window.location.origin}/l/sas-1`)).toBeNull()
    expect(screen.getAllByText(L.notConfigured).length).toBe(off.length)
    // ⚠️ Statistik too: its address is a constant feed URL, which is exactly why it could lose
    // the button and still look plausible — «nicht eingerichtet» and no way to set it up.
    expect(screen.getByRole('button', { name: S.enableBtn })).toBeTruthy()
    // nothing to print off a key that does not exist
    expect(screen.queryByRole('button', { name: A.printBtn })).toBeNull()

    apiPost.mockResolvedValue({ configured: true, token: 'as-2' })
    fireEvent.click(screen.getByRole('button', { name: A.enableBtn }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/incident-link/atemschutz/secret/rotate', {}))
  })

  it('says only the state on the chip — never the name of the thing beside it', async () => {
    server(() => true)
    render(<LinksView />)

    await waitFor(() => expect(screen.getAllByText(E.stateOn).length).toBe(4))
    for (const badge of screen.getAllByText(E.stateOn)) {
      const pill = badge.closest('.adm-badge')
      expect(pill).toBeTruthy()
      expect(pill?.textContent).toBe(E.stateOn)
    }
    // The surfaces are named once, in the card's head. Statistik takes `links.nameStats`, not
    // its own `stateLabel` («Export»), which reads too thin beside «Stations-Terminal».
    for (const name of [E.stateLabel, T.stateLabel, A.stateLabel, L.nameStats]) {
      expect(screen.getByText(name).className).toContain('lnk-rec-name')
    }
  })

  it('gives every card exactly one ⓘ, and the page not one primary button', async () => {
    // ⚠️ With one card off, so the «Aktivieren» button is on the page: that one was the blue
    // primary among secondary buttons and a ⋮ menu, on a list where a filled button does not
    // read as «do this» but as «this one is broken».
    server((path) => path !== '/api/stats/secret')
    const { container } = render(<LinksView />)

    await waitFor(() => expect(screen.getByRole('button', { name: S.enableBtn })).toBeTruthy())
    const cards = [...container.querySelectorAll('.lnk-rec')] as HTMLElement[]
    expect(cards.length).toBe(6)
    for (const card of cards) {
      // the whole explanation of an entry hangs on its name — not one ⓘ per column, as the
      // table before it had (Zweck, Adresse, Status)
      expect(card.querySelectorAll('.adm-tip').length).toBe(1)
      expect(card.querySelector('.lnk-rec-name .adm-tip')).toBeTruthy()
    }
    expect(container.querySelectorAll('.adm-save-btn').length).toBe(0)
  })

  it('rotating takes two clicks, from inside the ⋮ menu', async () => {
    server(() => true)
    apiPost.mockResolvedValue({ configured: true, token: 'cap-2' })
    render(<LinksView />)

    await waitFor(() => expect(screen.getByText(`${window.location.origin}/e/cap-1`)).toBeTruthy())
    // ⚠️ `expanded: false` is the WAIT, not a nicety. The ⋮ is a Base UI trigger, and Base UI
    // hands it the handler that opens the menu one commit AFTER the button itself is in the DOM –
    // the card's address chip and its ⋮ land in the same render, but the trigger only becomes a
    // trigger when the effect that publishes the menu's floating context has run. That effect is
    // also what writes `aria-expanded="false"`, so the attribute is the readiness marker: waiting
    // for it waits for a button the click can actually reach. Clicking on the plain `getByRole`
    // right after the row appears is a lost click on an inert button roughly 1 run in 50 under
    // CI load – the menu never opens and the test dies on «Token rotieren» not existing.
    fireEvent.click(await screen.findByRole('button', {
      name: `${E.stateLabel} – ${L.colActions}`, expanded: false,
    }))
    fireEvent.click(await screen.findByRole('menuitem', { name: E.rotateBtn }))

    // the menu closed; the question is asked on the card and nothing has been sent yet
    const ask = await screen.findByRole('alertdialog', { name: E.rotateMsg })
    expect(apiPost).not.toHaveBeenCalled()

    fireEvent.click(within(ask).getByRole('button', { name: COMMON.confirmYes }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/capture/secret/rotate', {}))
  })
})
