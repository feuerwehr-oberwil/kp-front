import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { ApiError } from '../../lib/api'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/cx'
import { confirmDialog, toast } from '../../lib/ui'
import { createShareLink, fetchShareLink, mintEinsatzLink, revokeShareLink, teilenRows, viewLinkUrl, type ShareDoor, type ShareLink, type ShareLinkKind } from '../../lib/viewLink'
import { Segmented } from '../Segmented'
import { Modal } from './_shared'

// «Teilen» — every way this app hands an Einsatz to somebody, in one file.
//
// ONE PLACE, THREE ROWS (03.09.)
// ------------------------------
// There used to be three doors and each one led to a different link, so which of the three you
// got was decided by which door you happened to find: the Rapport's «Weitergeben» section minted
// the view link, the Einsatz-Karte's «Teilen» minted the view link, and the QR beside the
// Atemschutz bell minted the Atemschutz one. The Einsatzkopf's Teilen button
// (components/TopBar · TeilenMenu) is now THE place, and the ROW decides — the list is
// `lib/viewLink · teilenRows`, and `TeilenSheet` below renders the identical three for the phone
// and the Einsatz-Karte, where a dropdown does not fit.
//
// What survives of the old doors, and why:
//   · the Rapport's section renders `ShareIncident` INLINE — it is this surface, not a second
//     door to it, and the view link's whole purpose is handing the finished Einsatzakte out from
//     exactly there;
//   · the QR beside the Atemschutz bell is contextual: it lands straight on «Nur Atemschutz»,
//     because standing on the Tafel deciding to hand it over, that is the only thing it could
//     have meant.
//
// The kinds (see lib/viewLink):
//   · «Ganzer Einsatz – nur lesen»  — the view link, read-only, outlives the Einsatz.
//   · «Nur Atemschutz – bedienen»   — the Atemschutz link: the Überwachungstafel of this one
//                                     Einsatz on somebody else's phone, and they operate it.
//   · the Einsatz-Link                — the alarm link, minted here (`EinsatzLinkSheet`): read-only
//                                     and dead at the Abschluss, so it has no sheet of choices.
// Everything below a choice — QR, address, Senden, Aufheben — is the same block for all of them;
// only the sentences differ, because what the code hands over is the ONE thing somebody has to
// have read before sending it on.
//
// The QR is what makes the handover work at all. The realistic handover in an Einsatz is
// «Tablet hinhalten», not «Adresse kopieren» — and the code is drawn from the address as soon
// as there is one. Lazily: `qrcode` otherwise ships only in the admin chunk, and there is no
// reason for every field device to carry it. Its absence is never fatal — no QR still leaves
// the address, which is the part that always works.

/** ONE address, presented the one way this app presents an address to hand over: the QR that
 *  makes «Tablet hinhalten» work, the whole URL as the copy target, and the device's own Teilen
 *  sheet where that exists. Extracted so the Einsatz-Link sheet below is the same surface rather
 *  than a second copy-button grammar; `children` takes whatever else belongs on that row (the
 *  view/Atemschutz links put «Link aufheben» there — the Einsatz-Link has nothing to revoke).
 *
 *  The QR is drawn lazily: `qrcode` otherwise ships only in the admin chunk, and there is no
 *  reason for every field device to carry it. Its absence is never fatal — no QR still leaves the
 *  address, which is the part that always works. */
export function ShareLinkCode({ url, children }: { url: string; children?: React.ReactNode }) {
  const C = appConfig.copy.preflight
  // keyed by the address it encodes, so a revoked-then-reminted link can never flash the old
  // code — and so nothing has to be reset when the address goes away
  const [qr, setQr] = useState<{ url: string; src: string } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!url) return
    let alive = true
    void import('qrcode')
      .then(({ toDataURL }) => toDataURL(url, { width: 512, margin: 1 }))
      .then((src) => { if (alive) setQr({ url, src }) })
      .catch(() => { /* no QR is not no link — the address below it still works */ })
    return () => { alive = false }
  }, [url])

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

  return (
    <>
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
        {children}
      </div>
    </>
  )
}

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

  const run = async (fn: () => Promise<ShareLink>, failure: string) => {
    setBusy(true)
    try { setLink(kind, await fn()) } catch { toast(failure) } finally { setBusy(false) }
  }

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
      <ShareLinkCode url={url}>
        <button type="button" className="ip-btn esh-revoke" disabled={busy}
          onClick={() => void confirmDialog({
            title: kc.revokeTitle,
            message: kc.revokeBody,
            confirmLabel: C.shareRevokeConfirm,
            danger: true,
          }).then(async (ok) => { if (ok) await run(() => revokeShareLink(incidentId, kind), C.shareRevokeFailed) })}>
          {C.shareRevoke}
        </button>
      </ShareLinkCode>
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

/** The same three-way choice as the Einsatzkopf's dropdown, as a sheet — for the doors that
 *  cannot open a dropdown: the phone (where the bar's 44px budget leaves no room for the Teilen
 *  button) and the Einsatz-Karte's own «Teilen» row inside the Einsatz-Dropdown.
 *
 *  It exists so a phone is not offered fewer links than a tablet. Picking a row hands the choice
 *  back up and this sheet gives way to the chosen one — it is a fork in the road, never a place
 *  that mints anything itself.
 *
 *  `archived` is passed straight to `teilenRows`, so this sheet and the Einsatzkopf's dropdown
 *  offer the same rows on a closed Einsatz — the Rapport-Link only. */
export function TeilenSheet({ onPick, onClose, archived }: { onPick: (door: ShareDoor) => void; onClose: () => void; archived?: boolean }) {
  return (
    <Modal title={appConfig.copy.topBar.share} onClose={onClose} fit>
      <div className="esh esh-doors">
        {teilenRows({ archived }).map((r) => (
          <button key={r.door} type="button" className="esh-door" onClick={() => onPick(r.door)}>
            <Icon id={r.icon} />
            <span className="esh-door-t"><b>{r.label}</b><small>{r.sub}</small></span>
            <Icon id="chevron" className="esh-door-go" />
          </button>
        ))}
      </div>
    </Modal>
  )
}

/** Why a mint was refused, in the operator's terms rather than the server's. Four answers, and
 *  only ONE of them is «nochmals versuchen» — offering a retry for a refusal that will never
 *  change its mind is worse than a plain «geht nicht», because it is an instruction that fails.
 *
 *  · `setup`  — this Wehr has no Link-Schlüssel. The one refusal der Verwaltung can fix, and the
 *               only one that earns that instruction. Recognised by the backend's own code
 *               (api/incident_link · NO_MINTING_KEY_CODE), not by the bare status: every other
 *               403 would otherwise send somebody to a settings screen that cannot help.
 *  · `closed` — the Einsatz is abgeschlossen. «Zu spät», not a failure: this link dies with the
 *               Einsatz, and the Rapport-Link is the one that is still good.
 *  · `denied` — a 403 that is not the above, i.e. this account may not mint. Nothing to retry.
 *  · `failed` — offline, a server that fell over, anything unnamed. This one may fix itself. */
type MintFailure = 'setup' | 'closed' | 'denied' | 'failed'

const NO_KEY_CODE = 'link_key_missing'

function mintFailure(e: unknown): MintFailure {
  if (!(e instanceof ApiError)) return 'failed'
  if (e.status === 409) return 'closed'
  if (e.status === 403) return e.code === NO_KEY_CODE ? 'setup' : 'denied'
  return 'failed'
}

/** «Einsatz-Link (nur lesen)» — the Teilen menu in the Einsatzkopf (02.09.).
 *
 *  The link the Alarmierung already puts into every alarm, minted here instead: the Zentrale, the
 *  EL or a Nachbarwehr is handed a live read-only view of THIS Einsatz, mid-Einsatz. It carries
 *  no choice and nothing to revoke — the address is derived from the Einsatz and the station's
 *  key, and it ends when the Einsatz is abgeschlossen — so this is one sentence, the code, and
 *  what the link hands over, rather than a second segmented control.
 *
 *  Minted on open, because that is what the menu entry said it would do. */
export function EinsatzLinkSheet({ incidentId, onClose }: { incidentId: string; onClose: () => void }) {
  const C = appConfig.copy.preflight
  const [state, setState] = useState<{ at: 'busy' } | { at: 'link'; url: string } | { at: MintFailure }>({ at: 'busy' })

  useEffect(() => {
    let alive = true
    void mintEinsatzLink(incidentId)
      .then((l) => { if (alive) setState({ at: 'link', url: viewLinkUrl(l) }) })
      .catch((e: unknown) => { if (alive) setState({ at: mintFailure(e) }) })
    return () => { alive = false }
  }, [incidentId])

  return (
    <Modal title={C.shareStationTitle} onClose={onClose} fit>
      <div className="esh">
        {state.at === 'busy' && <p className="esh-lede">{C.shareBusy}</p>}
        {state.at === 'setup' && (
          <p className="esh-warn"><Icon id="warn" />{C.shareStationSetup}</p>
        )}
        {state.at === 'closed' && (
          <p className="esh-warn"><Icon id="warn" />{C.shareStationClosed}</p>
        )}
        {state.at === 'denied' && (
          <p className="esh-warn"><Icon id="warn" />{C.shareStationDenied}</p>
        )}
        {state.at === 'failed' && (
          <p className="esh-warn"><Icon id="warn" />{C.shareStationFailed}</p>
        )}
        {state.at === 'link' && (
          <>
            <p className="esh-lede">{C.shareStationLede}</p>
            <ShareLinkCode url={state.url} />
            {/* Says what the link hands over, under the address rather than behind a tooltip —
                the one thing somebody has to have read BEFORE sending it on. */}
            <p className="esh-warn"><Icon id="warn" />{C.shareStationWarn}</p>
          </>
        )}
      </div>
    </Modal>
  )
}
