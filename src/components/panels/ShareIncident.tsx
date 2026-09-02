import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/cx'
import { confirmDialog, toast } from '../../lib/ui'
import { createShareLink, fetchShareLink, revokeShareLink, viewLinkUrl, type ShareLink, type ShareLinkKind } from '../../lib/viewLink'
import { Segmented } from '../Segmented'
import { Modal } from './_shared'

// «Weitergeben» — the Einsatz's shareable links, in ONE component because it has two doors and
// now two KINDS.
//
// The doors: it used to live only in the Rapport, which meant that handing a Nachbarwehr the
// running Lage went through the Abschluss surface — the one screen nobody wants to open
// mid-Einsatz (field feedback 01.09.). The second door is the active Einsatz's own card in the
// Einsatz-Dropdown; the third is the QR beside the Atemschutz board's bell, which opens this
// sheet already switched to «Nur Atemschutz». All of them render this, so they cannot drift.
//
// The kinds (see lib/viewLink):
//   · «Ganzer Einsatz – nur lesen»  — the view link, read-only, outlives the Einsatz.
//   · «Nur Atemschutz – bedienen»   — the Atemschutz link: the Überwachungstafel of this one
//                                     Einsatz on somebody else's phone, and they operate it.
// Two links, one place, one gesture. Everything below the choice — QR, address, Senden,
// Aufheben — is the same block for both; only the sentences differ, because what the code hands
// over is the ONE thing somebody has to have read before sending it on.
//
// The QR is what makes the second door worth having. The realistic handover in an Einsatz is
// «Tablet hinhalten», not «Adresse kopieren» — and the code is drawn from the address as soon
// as there is one. Lazily: `qrcode` otherwise ships only in the admin chunk, and there is no
// reason for every field device to carry it. Its absence is never fatal — no QR still leaves
// the address, which is the part that always works.

/** The sentences that differ per kind — everything else about the surface is shared. */
function kindCopy(kind: ShareLinkKind) {
  const C = appConfig.copy.preflight
  return kind === 'atemschutz'
    ? { lede: C.shareAsLede, liveLede: C.shareAsLiveLede, warn: C.shareAsWarn, revokeTitle: C.shareAsRevokeTitle, revokeBody: C.shareAsRevokeBody }
    : { lede: C.shareLede, liveLede: C.shareLiveLede, warn: C.shareWarn, revokeTitle: C.shareRevokeTitle, revokeBody: C.shareRevokeBody }
}

/** The surface itself. Fetches its own link state per kind, so every door is one line to mount.
 *  `onState` reports the selected kind's link back — the Atemschutz board's own button paints
 *  its «ein Link läuft» tint from it without a second request. */
export function ShareIncident({ incidentId, initialKind = 'view', onState }: {
  incidentId: string
  initialKind?: ShareLinkKind
  onState?: (kind: ShareLinkKind, link: ShareLink) => void
}) {
  const C = appConfig.copy.preflight
  const [kind, setKind] = useState<ShareLinkKind>(initialKind)
  // Keyed by kind, so switching back to one already fetched is instant instead of a second
  // «noch keiner» flash over a link that exists. Never mints anything — see the effect below.
  const [links, setLinks] = useState<Partial<Record<ShareLinkKind, ShareLink>>>({})
  const link = links[kind] ?? null
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // keyed by the address it encodes, so a revoked-then-reminted link can never flash the old
  // code — and so nothing has to be reset when the address goes away
  const [qr, setQr] = useState<{ url: string; src: string } | null>(null)

  // `onState` is read through a ref: a caller passing an inline arrow must not re-run the fetch.
  const report = useRef(onState)
  useEffect(() => { report.current = onState }, [onState])

  const setLink = (k: ShareLinkKind, l: ShareLink) => {
    setLinks((prev) => ({ ...prev, [k]: l }))
    report.current?.(k, l)
  }

  // ⚠️ The «still mounted» guard is per COMPONENT, not per effect run. Cancelling the in-flight
  // fetch when the kind changes is what made switching back re-ask: the first answer was thrown
  // away mid-flight and the cache stayed empty, so a second «noch keiner» flashed over a link
  // that existed — which is how somebody mints a second one by mistake.
  const mounted = useRef(true)
  // set on mount, not only cleared on unmount: StrictMode runs mount → cleanup → mount, and a
  // ref left false after that would drop every fetch answer for the life of the sheet
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (links[kind]) return // already known — switching kinds must not re-ask
    void fetchShareLink(incidentId, kind).then((l) => { if (mounted.current) setLink(kind, l) }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `links` is the cache this reads, not a trigger
  }, [incidentId, kind])

  // Empty until there IS a link — `viewLinkUrl` returns '' for a disabled one, and every
  // branch below keys off this rather than off a half-built URL.
  const url = link?.enabled ? viewLinkUrl(link) : ''

  useEffect(() => {
    if (!url) return
    let alive = true
    void import('qrcode')
      .then(({ toDataURL }) => toDataURL(url, { width: 512, margin: 1 }))
      .then((src) => { if (alive) setQr({ url, src }) })
      .catch(() => { /* no QR is not no link — the address below it still works */ })
    return () => { alive = false }
  }, [url])

  const run = async (fn: () => Promise<ShareLink>, failure: string) => {
    setBusy(true)
    try { setLink(kind, await fn()) } catch { toast(failure) } finally { setBusy(false) }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked (http / permissions) — the address stays selectable */ }
  }

  // The phone's own «Teilen» sheet, where the Threema/WhatsApp group actually is. Absent on
  // desktop browsers that have no share target, rather than offered and then doing nothing.
  const canSend = typeof navigator.share === 'function'
  const kc = kindCopy(kind)

  /* ⚠️ TWO LINES per segment, and the second one is the whole point: «Ganzer Einsatz» and «Nur
     Atemschutz» say what the code shows, but the difference that matters at 3am is lesen ↔
     bedienen. The shared `.useg` control is a one-line track, so `.esh-kind` gives it the
     stacked geometry (13-incident.css) rather than a second segmented control existing. */
  const picker = (
    <div className="esh-kind">
      <Segmented<ShareLinkKind>
        ariaLabel={C.shareKindLabel}
        value={kind}
        onChange={setKind}
        options={[
          { value: 'view', label: <><b>{C.shareKindFull}</b><small>{C.shareKindFullSub}</small></> },
          { value: 'atemschutz', label: <><b>{C.shareKindAtem}</b><small>{C.shareKindAtemSub}</small></> },
        ]}
      />
    </div>
  )

  if (!url) {
    return (
      <>
        {picker}
        <p className="esh-lede">{kc.lede}</p>
        <button type="button" className="ip-btn primary" disabled={busy}
          onClick={() => void run(() => createShareLink(incidentId, kind), C.shareCreateFailed)}>
          <Icon id="external" />{busy ? C.shareBusy : C.shareCreate}
        </button>
      </>
    )
  }
  return (
    <>
      {picker}
      <p className="esh-lede">{kc.liveLede}</p>
      {qr?.url === url && (
        <div className="esh-qr">
          {/* decorative: the address right below it is the accessible copy of the same thing */}
          <img src={qr.src} alt="" />
          <span className="esh-qr-cap">{C.shareScan}</span>
        </div>
      )}
      <div className="esh-row">
        {/* the whole address is the copy target — a 12px «Kopieren» beside a URL is a miss
            waiting to happen with a glove on (same call as the Formular rows) */}
        <button type="button" className={cx('esh-url', copied && 'copied')} onClick={() => void copy()}
          title={copied ? C.shareCopied : C.shareCopy} aria-label={C.shareCopy}>
          <code>{url}</code>
          <span className="esh-copy" aria-hidden><Icon id={copied ? 'check' : 'copy'} /></span>
        </button>
        {canSend && (
          <button type="button" className="ip-btn esh-send" onClick={() => { void navigator.share?.({ url }).catch(() => {}) }}>
            <Icon id="share-ios" />{C.shareSend}
          </button>
        )}
        <button type="button" className="ip-btn esh-revoke" disabled={busy}
          onClick={() => void confirmDialog({
            title: kc.revokeTitle,
            message: kc.revokeBody,
            confirmLabel: C.shareRevokeConfirm,
            danger: true,
          }).then(async (ok) => { if (ok) await run(() => revokeShareLink(incidentId, kind), C.shareRevokeFailed) })}>
          {C.shareRevoke}
        </button>
      </div>
      {/* Says what the link actually hands over. It is the one thing somebody has to have read
          BEFORE sending it, so it stands under the address, not behind a tooltip. */}
      <p className="esh-warn"><Icon id="warn" />{kc.warn}</p>
    </>
  )
}

/** The Einsatz-Dropdown's and the Atemschutz board's door: the same surface as a sheet of its
 *  own. `initialKind` is which link the door means — the QR beside the bell opens straight on
 *  «Nur Atemschutz», because that is the only one it could have meant. `fit` — there are at
 *  most seven things on it, and the uniform 800px frame would be mostly empty below them. */
export function ShareIncidentSheet({ incidentId, initialKind, onClose, onState }: {
  incidentId: string
  initialKind?: ShareLinkKind
  onClose: () => void
  onState?: (kind: ShareLinkKind, link: ShareLink) => void
}) {
  return (
    <Modal title={appConfig.copy.incidentSwitcher.share} onClose={onClose} fit>
      <div className="esh"><ShareIncident incidentId={incidentId} initialKind={initialKind} onState={onState} /></div>
    </Modal>
  )
}
