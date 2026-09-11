// Links & Zugänge — every address this Wehr hands out, in ONE table.
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
// So: one row per link, always the same four columns — Zweck · Adresse · Status · Aktionen.
// The address IS the point of the page, so it is a copy target rather than decoration; the
// one action that is genuinely per row (Poster, QR-Karte) stands open on the row and the
// destructive rest sits behind the shared ⋮ menu, where a rotation still costs two clicks.
//
// ⚠️ THE RULE, and the only one that matters here: a row shows the ONE thing you can actually
// use. Never the same secret in two fields (the key is already inside the Terminal and the
// Atemschutz address), and never a chip that has to be edited before it works — no `<token>`,
// no `?secret=<…>`. Where no working value exists, the row says so in words instead of
// copying a lie. See AddrLine for which rows that leaves with two chips, and why.
//
// ⚠️ The rows run on the SHARED secret trio (admin/ui · useSecret) — GET <basePath>,
// POST <basePath>/rotate, DELETE <basePath>. `SecretRows` is not reused: it renders rows of
// the settings GRID (`display: contents`), which cannot become cells of a <table>. What was
// worth keeping from it — the hook, CopyChip, StatusBadge, the two-step confirm — is composed
// here instead.
//
// ⚠️ Every one of these GETs returns the value itself, not just `configured` (backend ·
// api/capture.py, api/incident_link.py, api/stats.py). That is what lets the table show a
// real address on every visit and print a poster months after minting.

import { useEffect, useState, type ReactNode } from 'react'
import { apiGet } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { InfoTip } from './InfoTip'
import {
  ActionMenu, Card, CopyChip, ResultChip, StatusBadge, Table, useSecret,
  type Column, type MenuAction, type SecretApi,
} from './ui'
import './links.css'

const origin = () => window.location.origin
const appName = () => getDeploymentConfig().identity?.appName ?? 'KP Front'

const captureUrl = (token: string) => `${origin()}/e/${token}`
const terminalEnrollUrl = (token: string) => `${origin()}/l/t${token}`
const standingAsUrl = (token: string) => `${origin()}/l/s${token}`

/** Everything one row says. Assembled at the call site from the surface's OWN copy namespace
 *  (admin.erfassung / admin.einsatzlink / admin.terminal / admin.atemschutzUrl /
 *  admin.statistik), so this file holds no strings of its own.
 *
 *  ⚠️ `name` is `admin.links.name*` where the namespace's own `stateLabel` reads too thin out of
 *  context («Export» beside «Stations-Terminal»), and that `stateLabel` otherwise. Either way the
 *  row's Zweck column names the surface, and
 *  the Status badge beside it therefore carries no label of its own. A badge repeating the
 *  column header reads «Status — Erfassung aktiv». */
interface RowCopy {
  name: string
  purpose: string
  /** the Zweck cell's ⓘ: what this link IS */
  body: string
  /** the Status cell's ⓘ: how the key behaves */
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
 *  ui/ConfirmButton — the ⋮ menu closes on selection, so the question is asked on the row. */
interface Pending { question: string; danger?: boolean; run: () => void }

/** One copyable line in the Adresse column, built from the key the backend returned.
 *
 *  ⚠️ TWO rules, and every row on this page is an application of them:
 *
 *  1. **A row shows the one thing you can actually use.** No line may contain another line's
 *     value. Until 2026-09-11 the Stations-Terminal and the fixe Atemschutz-Code carried the
 *     address AND, under it, the key that was already inside that address — the same secret
 *     twice, with nothing on the screen saying which of the two to take. The Statistik row is
 *     the one that legitimately has two: its token travels as a header, not in the feed URL.
 *  2. **Nothing that is not a working value goes on a chip.** A copy button whose content has
 *     to be edited before it works (`/l/<token>`, `?secret=<Alarm-Webhook-Secret>`) is worse
 *     than no chip: it copies clean and fails later, somewhere else.
 *
 *  `label` is therefore set only where a cell carries more than one line — since the signing key
 *  moved to «Zugangsdaten» that is the Statistik row alone. A lone address chip needs no caption
 *  repeating the column header. */
interface AddrLine {
  label?: string
  value: string
  /** a caveat that belongs beside the value, not behind the row's ⓘ */
  tip?: { text: string; tone?: 'default' | 'warn' }
}

/**
 * One secret-backed row. `lines` builds what the row hands out from the key the backend
 * returned — one chip for almost every row, two only where the address and the key are
 * genuinely different things (see AddrLine).
 */
function SecretRow({ copy, secret, lines, docsUrl, print }: {
  copy: RowCopy
  secret: SecretApi
  lines: (token: string) => AddrLine[]
  docsUrl?: string
  /** the printable artefact this link lives on — open on the row, never in the menu */
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

  return (
    <tr>
      <td className="lnk-what">
        <b>
          <span>{copy.name}</span>
          <InfoTip label={copy.name} text={copy.body} />
        </b>
        <span>{copy.purpose}</span>
      </td>
      <td>
        {token ? (
          <span className="lnk-addr">
            {lines(token).map((line) => (
              <span className="lnk-addr-line" key={line.value}>
                {line.label && <span className="lnk-addr-label">{line.label}</span>}
                <CopyChip value={line.value} />
                {line.tip && <InfoTip label={copy.name} text={line.tip.text} tone={line.tip.tone} />}
              </span>
            ))}
          </span>
        ) : (
          <span className="lnk-none">{L.notConfigured}</span>
        )}
      </td>
      <td>
        <span className="lnk-state">
          <StatusBadge tone={state.configured ? 'on' : 'off'} label=""
            state={state.configured ? copy.stateOn : copy.stateOff} />
          <InfoTip label={copy.name} text={copy.hint} />
        </span>
      </td>
      <td>
        <div className="lnk-acts">
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
            <button type="button" className="btn adm-save-btn" disabled={busy}
              onClick={() => void rotate()}>{copy.enableBtn}</button>
          )}
          {result && <ResultChip tone={result.tone} onExpire={clearResult}>{result.text}</ResultChip>}
        </div>
      </td>
    </tr>
  )
}

/**
 * Is the shared `alarm_webhook_secret` set at all? Read ONCE for both intake rows — they are two
 * addresses on one key, and asking twice would put two GETs on the page to answer one question.
 *
 * ⚠️ null = we could not ask (no admin session, server down). Then the rows say nothing about
 * the key rather than guessing: a row claiming «Schlüssel fehlt» over a working intake would
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
 * One alarm-intake row — the addresses here that are NOT this page's to mint. There are two of
 * them (the generic POST endpoint and FireHub's own webhook target), and they used to share a
 * cell: two labelled chips under one name, so the Zweck column named neither and the Status
 * badge sat beside a pair. One row per address instead, both reading the same key.
 *
 * ⚠️ The chip carries the BARE endpoint, without the `?secret=` the intake actually requires,
 * and that is deliberate: the secret is write-only in the credential table (backend ·
 * credentials.py · `CredentialField("alarm_webhook_secret", …, secret=True)`, and api/
 * credentials.py `value=None if f.secret`), so no admin session can read it back and no
 * complete URL can be built here. A chip showing `?secret=<Alarm-Webhook-Secret>` looked like
 * a URL, copied like a URL and was not one. The sentence under it says what still has to be
 * appended, and the button leads to the one surface that can set the key.
 */
function AlarmRow({ name, purpose, address, keySet, onNavigate }: {
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
    <tr>
      <td className="lnk-what">
        <b>
          <span>{name}</span>
          <InfoTip label={name} text={D.pathWebhookMeans} />
        </b>
        <span>{purpose}</span>
      </td>
      <td>
        <span className="lnk-addr">
          <span className="lnk-addr-line">
            <CopyChip value={address} />
          </span>
          <span className="lnk-note">{L.secretAppend}</span>
        </span>
      </td>
      <td>
        <span className="lnk-state">
          {keySet !== null && (
            <StatusBadge tone={keySet ? 'on' : 'warn'} label=""
              state={keySet ? Z.stateStored : L.keyMissing} />
          )}
          <InfoTip label={name} text={D.secretBody} />
        </span>
      </td>
      <td>
        <div className="lnk-acts">
          {onNavigate && (
            <button type="button" className="btn adm-int-btn"
              onClick={() => onNavigate('zugaenge')}>{L.toCredentials}</button>
          )}
        </div>
      </td>
    </tr>
  )
}

/** The page: six rows, in the order a station meets them — the poster on the wall first, the
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
  // the row's own result chip — the download is silent when it works, so a silent failure would
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
  const columns: Column[] = [
    { key: 'purpose', label: L.colPurpose },
    { key: 'address', label: L.colAddress },
    { key: 'state', label: L.colState },
    { key: 'actions', label: L.colActions },
  ]

  const rows: ReactNode = (
    <>
      <SecretRow
        copy={{ ...E, name: E.stateLabel, purpose: L.purposeCapture }}
        secret={capture}
        // the poster's link IS its whole secret — said beside the copy button, not behind an ⓘ
        lines={(t) => [{ value: captureUrl(t), tip: { text: E.linkWarn, tone: 'warn' } }]}
        print={{ label: E.printBtn, run: (t) => void printPoster(t) }}
      />
      {/* ⚠️ NO Einsatz-Link row. The minting key has no address and never will have one — it
          lives on «Zugangsdaten» since 2026-09-11 (see the header note). Do not reinstate it
          here to «complete» the list of links: the completion this page needs is that every
          chip on it opens something. */}
      <SecretRow
        copy={{ ...T, name: T.stateLabel, purpose: L.purposeTerminal }}
        secret={terminal}
        // the token is already inside this address — a second chip beside it would be the same
        // secret twice, with nothing saying which of the two to use
        lines={(t) => [{ value: terminalEnrollUrl(t), tip: { text: T.exampleTip } }]}
        docsUrl={linkDocs}
      />
      <SecretRow
        copy={{ ...A, name: A.stateLabel, purpose: L.purposeAtemschutz }}
        secret={standing}
        lines={(t) => [{ value: standingAsUrl(t) }]}
        docsUrl={linkDocs}
        print={{ label: A.printBtn, run: (t) => void printCard(t) }}
      />
      <SecretRow
        copy={{ ...S, name: L.nameStats, purpose: L.purposeStats }}
        secret={stats}
        // the one row that legitimately carries two: the feed address holds no token at all,
        // and the token authenticates against it as a header (admin.statistik.hint says which).
        // Two labelled chips rather than a curl line the column would ellipsise into nothing.
        lines={(t) => [
          { label: L.addressLabel, value: `${origin()}/api/stats/incidents?year=${new Date().getFullYear()}` },
          { label: L.keyLabel, value: t },
        ]}
        docsUrl={`${D.repo}${D.statsExport}`}
      />
      <AlarmRow
        name={DA.genericLabel}
        purpose={L.purposeAlarm}
        address={`${origin()}/api/alarms`}
        keySet={alarmKeySet}
        onNavigate={onNavigate}
      />
      <AlarmRow
        name={DA.firehubLabel}
        purpose={L.purposeFirehub}
        address={`${origin()}/api/firehub/webhook`}
        keySet={alarmKeySet}
        onNavigate={onNavigate}
      />
    </>
  )

  return (
    <Card caption={L.rotateNote}>
      <Table columns={columns} className="lnk-table">{rows}</Table>
    </Card>
  )
}
