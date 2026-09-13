// Links & Zugänge — every address this Wehr hands out, in ONE list.
//
// Until 2026-09-10 the same object lived in three places: «Erfassung» carried the poster
// secret next to the paper Erfassungsblatt, «Einsatz-Link» carried the minting key plus both
// standing links (Stations-Terminal, fixer Atemschutz-Code), «Statistik-Export» carried its
// token, and the Alarmierungs-Seite printed the two Webhook-Adressen a third time. Whoever
// asked «welche Adresse hat diese Wache nach aussen gegeben?» had to visit four pages and
// know which one to look on.
//
// ⚠️ …and on 2026-09-11 the Einsatz-Link minting key LEFT again, for «Zugangsdaten»
// (CredentialsView · IncidentLinkKey). It is a credential, not an address: it gets pasted into
// the alerting system once, exactly like every other integration key. There is no station-level
// URL for it and there never can be one — it is a SIGNING key, and the alerting system signs a
// per-incident token with it (`/l/<token>` in the alarm), just as the app mints the same
// per-incident thing from a running Einsatz (backend · api/incident_link.py ·
// `mint_incident_link_token`, which names ONE incident). Three times over, the question asked of
// this row was «und welche URL gehört jetzt dahin?» — the answer is that the row does not belong
// on a page of addresses. What is left here really is addresses, every one of them copyable.
//
// ⚠️ Since 2026-09-13 the page follows the admin's ONE grammar — Karten für Datensätze, Zeilen
// für Werte. Each entry is a RECORD CARD: a head that names it (name + its one ⓘ · state chip ·
// the line saying what it is for · its actions, right-aligned), and under it one labelled row
// per value. The four-column table it replaces mixed three kinds of button (a blue «Aktivieren»,
// open secondary buttons, a ⋮ menu), carried an ⓘ in three different columns and wrapped
// «Schlüssel fehlt» over two lines in a 16 %-wide cell.
//
// ⚠️ ONE action grammar, and it is worth keeping: everything a card offers is a secondary
// `btn` — activate, print, «Zugangsdaten» — and the rare, destructive rest (rotieren,
// deaktivieren, Doku) stays behind the ⋮ menu. No blue primary on a list: on a page of six
// entries a filled button does not mean «do this», it means «this one is broken».
//
// ⚠️ THE RULE, and the only one that matters here: a card shows the ONE thing you can actually
// use. Never the same secret in two rows (the key is already inside the Terminal and the
// Atemschutz address), and never a chip that has to be edited before it works — no `<token>`,
// no `?secret=<…>`. Where no working value exists, the card says so in words instead of
// copying a lie. See AddrLine for which cards that leaves with two rows, and why.
//
// ⚠️ The cards run on the SHARED secret trio (admin/ui · useSecret) — GET <basePath>,
// POST <basePath>/rotate, DELETE <basePath>. `SecretRows` is not reused: it renders rows of
// the settings GRID (`display: contents`), and these are cards of their own. What was worth
// keeping from it — the hook, CopyChip, StatusBadge, the two-step confirm — is composed here.
//
// ⚠️ Every one of these GETs returns the value itself, not just `configured` (backend ·
// api/capture.py, api/incident_link.py, api/stats.py). That is what lets the list show a
// real address on every visit and print a poster months after minting.

import { useEffect, useState, type ReactNode } from 'react'
import { apiGet } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { InfoTip } from './InfoTip'
import {
  ActionMenu, Card, CopyChip, ResultChip, StatusBadge, useSecret,
  type MenuAction, type SecretApi,
} from './ui'
import './links.css'

const origin = () => window.location.origin
const appName = () => getDeploymentConfig().identity?.appName ?? 'KP Front'

const captureUrl = (token: string) => `${origin()}/e/${token}`
const terminalEnrollUrl = (token: string) => `${origin()}/l/t${token}`
const standingAsUrl = (token: string) => `${origin()}/l/s${token}`

/** Everything one card says. Assembled at the call site from the surface's OWN copy namespace
 *  (admin.erfassung / admin.einsatzlink / admin.terminal / admin.atemschutzUrl /
 *  admin.statistik), so this file holds no strings of its own.
 *
 *  ⚠️ `name` is `admin.links.name*` where the namespace's own `stateLabel` reads too thin out of
 *  context («Export» beside «Stations-Terminal»), and that `stateLabel` otherwise. Either way the
 *  card's head names the surface, and the state chip beside it therefore carries no label of its
 *  own — a chip repeating its neighbour reads «Status — Erfassung aktiv». */
interface RowCopy {
  name: string
  purpose: string
  /** what this link IS — the first half of the card's one ⓘ */
  body: string
  /** how the key behaves — the second half of the same ⓘ */
  hint: string
  stateOn: string
  stateOff: string
  enableBtn: string
  rotateBtn: string
  rotateMsg: string
  disableBtn: string
  disableMsg: string
  docsLink?: string
}

/** An armed destructive action, waiting for its second click. Same two-step contract as
 *  ui/ConfirmButton — the ⋮ menu closes on selection, so the question is asked on the card. */
interface Pending { question: string; danger?: boolean; run: () => void }

/** One copyable value in a card's body, built from the key the backend returned.
 *
 *  ⚠️ TWO rules, and every card on this page is an application of them:
 *
 *  1. **A card shows the one thing you can actually use.** No row may contain another row's
 *     value. Until 2026-09-11 the Stations-Terminal and the fixe Atemschutz-Code carried the
 *     address AND, under it, the key that was already inside that address — the same secret
 *     twice, with nothing on the screen saying which of the two to take. The Statistik card is
 *     the one that legitimately has two: its token travels as a header, not in the feed URL.
 *  2. **Nothing that is not a working value goes on a chip.** A copy button whose content has
 *     to be edited before it works (`/l/<token>`, `?secret=<Alarm-Webhook-Secret>`) is worse
 *     than no chip: it copies clean and fails later, somewhere else.
 *
 *  `label` names the row; it defaults to «Adresse», which is what all but the Statistik card
 *  carry. */
interface AddrLine {
  label?: string
  value: string
}

/** One entry, in the page's card grammar: the head names it and carries its ONE ⓘ, the body is
 *  one labelled row per value. `note` is the dim line a value needs beside it — today only the
 *  Alarm-Eingänge, whose address is deliberately incomplete. */
function LinkCard({ name, tip, tipTone, purpose, badge, actions, rows, note }: {
  name: string
  /** everything this card has to explain, on the name — the only ⓘ an entry gets */
  tip: string
  tipTone?: 'default' | 'warn'
  purpose: string
  badge?: ReactNode
  actions: ReactNode
  rows: { label: string; value: ReactNode }[]
  note?: string
}) {
  return (
    <article className="lnk-rec">
      <header className="lnk-rec-head">
        <span className="lnk-rec-name">
          {name}
          <InfoTip label={name} text={tip} tone={tipTone} />
        </span>
        {badge}
        <span className="lnk-rec-purpose">{purpose}</span>
        <span className="lnk-rec-acts">{actions}</span>
      </header>
      {rows.map((row) => (
        <div className="lnk-rec-row" key={row.label}>
          <span className="lnk-rec-lbl">{row.label}</span>
          <span className="lnk-rec-val">{row.value}</span>
        </div>
      ))}
      {/* the caveat sits UNDER the value it belongs to, aligned with it — what is missing from a
          copied address has to be readable without a second tap, or it gets pasted as-is */}
      {note && (
        <div className="lnk-rec-row">
          <span className="lnk-rec-lbl" />
          <span className="lnk-note">{note}</span>
        </div>
      )}
    </article>
  )
}

/**
 * One secret-backed card. `lines` builds what the entry hands out from the key the backend
 * returned — one row for almost every card, two only where the address and the key are
 * genuinely different things (see AddrLine).
 */
function SecretCard({ copy, secret, lines, tips, tipTone, docsUrl, print }: {
  copy: RowCopy
  secret: SecretApi
  lines: (token: string) => AddrLine[]
  /** what the surface still has to say beyond `body` + `hint` — folded into the same ⓘ, because
   *  an entry gets exactly one and a reader should not have to find the second */
  tips?: string[]
  tipTone?: 'default' | 'warn'
  docsUrl?: string
  /** the printable artefact this link lives on — open on the card, never in the menu */
  print?: { label: string; run: (token: string) => void }
}) {
  const CO = appConfig.copy.admin.common
  const L = appConfig.copy.admin.links
  const [pending, setPending] = useState<Pending | null>(null)
  const { state, busy, result, clearResult, rotate, disable } = secret
  if (state === null) return null
  const token = state.configured ? state.token ?? null : null

  const actions: MenuAction[] = [
    { label: copy.rotateBtn, onClick: () => setPending({ question: copy.rotateMsg, run: () => void rotate() }) },
    { label: copy.disableBtn, danger: true, onClick: () => setPending({ question: copy.disableMsg, danger: true, run: () => void disable() }) },
  ]
  if (docsUrl && copy.docsLink) {
    actions.push({ label: copy.docsLink, onClick: () => window.open(docsUrl, '_blank', 'noopener,noreferrer') })
  }

  const rows = token
    ? lines(token).map((line) => ({
      label: line.label ?? L.addressLabel,
      value: <CopyChip value={line.value} />,
    }))
    : [{ label: L.addressLabel, value: <span className="lnk-none">{L.notConfigured}</span> }]

  return (
    <LinkCard
      name={copy.name}
      tip={[copy.body, copy.hint, ...(tips ?? [])].join(' ')}
      tipTone={tipTone}
      purpose={copy.purpose}
      badge={<StatusBadge tone={state.configured ? 'on' : 'off'} label=""
        state={state.configured ? copy.stateOn : copy.stateOff} />}
      rows={rows}
      actions={
        <>
          {pending ? (
            <span className="adm-confirm" role="alertdialog" aria-label={pending.question}>
              <span className="adm-confirm-q">{pending.question}</span>
              <button type="button" className={`btn ${pending.danger ? 'adm-danger-btn' : 'adm-save-btn'}`}
                onClick={() => { const { run } = pending; setPending(null); run() }}>{CO.confirmYes}</button>
              <button type="button" className="btn adm-int-btn"
                onClick={() => setPending(null)}>{CO.confirmNo}</button>
            </span>
          ) : state.configured ? (
            <>
              {print && token && (
                <button type="button" className="btn adm-int-btn" disabled={busy}
                  onClick={() => print.run(token)}>{print.label}</button>
              )}
              <ActionMenu ariaLabel={`${copy.name} – ${L.colActions}`} disabled={busy} actions={actions} />
            </>
          ) : (
            // ⚠️ Secondary, like every other button on the page. An entry whose key is off is not
            // a call to action — it is a state — and a blue button on one card of six reads as
            // «this one is wrong» long before anybody has decided the Wehr even wants that link.
            <button type="button" className="btn adm-int-btn" disabled={busy}
              onClick={() => void rotate()}>{copy.enableBtn}</button>
          )}
          {result && <ResultChip tone={result.tone} onExpire={clearResult}>{result.text}</ResultChip>}
        </>
      }
    />
  )
}

/**
 * Is the shared `alarm_webhook_secret` set at all? Read ONCE for both intake cards — they are two
 * addresses on one key, and asking twice would put two GETs on the page to answer one question.
 *
 * ⚠️ null = we could not ask (no admin session, server down). Then the cards say nothing about
 * the key rather than guessing: a card claiming «Schlüssel fehlt» over a working intake would
 * send somebody to re-enter a key that is already there.
 */
function useAlarmSecretSet(): boolean | null {
  const [keySet, setKeySet] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const creds = await apiGet<{ name: string; configured: boolean }[]>('/api/integrations/credentials')
        if (alive) setKeySet(creds.find((c) => c.name === 'alarm_webhook_secret')?.configured ?? false)
      } catch { /* unknown stays unknown */ }
    })()
    return () => { alive = false }
  }, [])

  return keySet
}

/**
 * One alarm-intake card — the addresses here that are NOT this page's to mint. There are two of
 * them (the generic POST endpoint and FireHub's own webhook target), and they used to share a
 * cell: two labelled chips under one name, so the Zweck column named neither and the state chip
 * sat beside a pair. One card per address instead, both reading the same key.
 *
 * ⚠️ The chip carries the BARE endpoint, without the `?secret=` the intake actually requires,
 * and that is deliberate: the secret is write-only in the credential table (backend ·
 * credentials.py · `CredentialField("alarm_webhook_secret", …, secret=True)`, and api/
 * credentials.py `value=None if f.secret`), so no admin session can read it back and no
 * complete URL can be built here. A chip showing `?secret=<Alarm-Webhook-Secret>` looked like
 * a URL, copied like a URL and was not one. The note under it says what still has to be
 * appended, and the button leads to the one surface that can set the key.
 */
function AlarmCard({ name, purpose, address, keySet, onNavigate }: {
  name: string
  purpose: string
  address: string
  keySet: boolean | null
  onNavigate?: (id: string) => void
}) {
  const L = appConfig.copy.admin.links
  const D = appConfig.copy.admin.data
  const Z = appConfig.copy.admin.zugaenge

  return (
    <LinkCard
      name={name}
      tip={`${D.pathWebhookMeans} ${D.secretBody}`}
      purpose={purpose}
      badge={keySet !== null
        ? <StatusBadge tone={keySet ? 'on' : 'warn'} label=""
          state={keySet ? Z.stateStored : L.keyMissing} />
        : undefined}
      rows={[{ label: L.addressLabel, value: <CopyChip value={address} /> }]}
      note={L.secretAppend}
      actions={onNavigate && (
        <button type="button" className="btn adm-int-btn"
          onClick={() => onNavigate('zugaenge')}>{L.toCredentials}</button>
      )}
    />
  )
}

/** The page: six cards, in the order a station meets them — the poster on the wall first, the
 *  export token last, and the two addresses somebody else calls US on at the bottom. */
export function LinksView({ onNavigate }: { onNavigate?: (id: string) => void } = {}) {
  const E = appConfig.copy.admin.erfassung
  const T = appConfig.copy.admin.terminal
  const A = appConfig.copy.admin.atemschutzUrl
  const S = appConfig.copy.admin.statistik
  const L = appConfig.copy.admin.links
  // Doc addresses live in the copy layer (admin.docs) — one line for a fork to retarget.
  const D = appConfig.copy.admin.docs
  const DA = appConfig.copy.admin.data
  const alarmKeySet = useAlarmSecretSet()

  const capture = useSecret('/api/capture/secret', { rotated: E.rotated, disabled: E.disabled, failed: E.failed })
  const terminal = useSecret('/api/incident-link/terminal/secret', { rotated: T.rotated, disabled: T.disabled, failed: T.failed })
  const standing = useSecret('/api/incident-link/atemschutz/secret', { rotated: A.rotated, disabled: A.disabled, failed: A.failed })
  const stats = useSecret('/api/stats/secret', { rotated: S.rotated, disabled: S.disabled, failed: S.failed })

  // Both PDFs load jsPDF + qrcode only when the button is tapped, and both report a failure on
  // the card's own result chip — the download is silent when it works, so a silent failure would
  // be indistinguishable from a browser that simply saved the file.
  const printPoster = async (token: string) => {
    try {
      const { downloadPosterPdf } = await import('./capturePdf')
      await downloadPosterPdf(captureUrl(token), appName())
    } catch { capture.report('err', E.failed) }
  }
  const printCard = async (token: string) => {
    try {
      const { downloadStandingAsCard } = await import('./standingAsPdf')
      await downloadStandingAsCard(standingAsUrl(token), appName())
    } catch { standing.report('err', A.printFailed) }
  }

  const linkDocs = `${D.repo}${D.incidentLink}`

  return (
    <Card caption={L.rotateNote}>
      <div className="lnk-recs">
        <SecretCard
          copy={{ ...E, name: E.stateLabel, purpose: L.purposeCapture }}
          secret={capture}
          lines={(t) => [{ value: captureUrl(t) }]}
          // the poster's link IS its whole secret — an amber ⓘ, because that is a caveat about
          // the address the card hands out and not a description of the surface
          tips={[E.linkWarn]}
          tipTone="warn"
          print={{ label: E.printBtn, run: (t) => void printPoster(t) }}
        />
        {/* ⚠️ NO Einsatz-Link card. The minting key has no address and never will have one — it
            lives on «Zugangsdaten» since 2026-09-11 (see the header note). Do not reinstate it
            here to «complete» the list of links: the completion this page needs is that every
            chip on it opens something. */}
        <SecretCard
          copy={{ ...T, name: T.stateLabel, purpose: L.purposeTerminal }}
          secret={terminal}
          // the token is already inside this address — a second row beside it would be the same
          // secret twice, with nothing saying which of the two to use
          lines={(t) => [{ value: terminalEnrollUrl(t) }]}
          tips={[T.exampleTip]}
          docsUrl={linkDocs}
        />
        <SecretCard
          copy={{ ...A, name: A.stateLabel, purpose: L.purposeAtemschutz }}
          secret={standing}
          lines={(t) => [{ value: standingAsUrl(t) }]}
          docsUrl={linkDocs}
          print={{ label: A.printBtn, run: (t) => void printCard(t) }}
        />
        <SecretCard
          copy={{ ...S, name: L.nameStats, purpose: L.purposeStats }}
          secret={stats}
          // the one card that legitimately carries two rows: the feed address holds no token at
          // all, and the token authenticates against it as a header (admin.statistik.hint says
          // which). Two labelled rows rather than a curl line the card would ellipsise to nothing.
          lines={(t) => [
            { label: L.addressLabel, value: `${origin()}/api/stats/incidents?year=${new Date().getFullYear()}` },
            { label: L.keyLabel, value: t },
          ]}
          docsUrl={`${D.repo}${D.statsExport}`}
        />
        <AlarmCard
          name={DA.genericLabel}
          purpose={L.purposeAlarm}
          address={`${origin()}/api/alarms`}
          keySet={alarmKeySet}
          onNavigate={onNavigate}
        />
        <AlarmCard
          name={DA.firehubLabel}
          purpose={L.purposeFirehub}
          address={`${origin()}/api/firehub/webhook`}
          keySet={alarmKeySet}
          onNavigate={onNavigate}
        />
      </div>
    </Card>
  )
}
