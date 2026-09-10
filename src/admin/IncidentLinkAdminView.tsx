// Einsatz-Link: manage the minting key (GET/POST/DELETE /api/incident-link/secret). The
// alerting system holds this key and signs the link tokens it puts into the alert itself —
// KP Front generates the key, hands it out once, and is never called to mint a link.
// Rotation invalidates every link already sent out at once. Fail-closed: no key → the whole
// link surface is off, so deleting the key IS the off switch.
//
// Since 2026-09-09 this surface also carries the two STANDING links (backend/app/api/
// incident_link · «THE STANDING LINKS»): the Stations-Terminal (enroll a depot PC once, it
// shows whichever Einsatz is open) and the fixe Atemschutz-URL (a laminated QR that opens the
// Überwachungstafel of the running Einsatz). Same trio each, on their own keys — rotating one
// never touches the others.
//
// The page is ONE settings sheet (admin/ui · «the settings table»): three group dividers, one
// per surface, each carrying its own prose in the divider's ⓘ and a single row saying whether
// its key exists. Everything that is not a setting — the freshly minted value, the link shape
// the other system needs, the actions — follows as full-width notes. The shared `SecretCard`
// (still the Statistik-Export's card) is a Card and could not be a row of that table, so this
// view lays the same three parts out itself.

import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import {
  ConfirmButton, CopyChip, ResultChip, SettingRow, SettingsGroup, SettingsNote, SettingsSheet,
  StatusBadge, useSecret, type SecretApi,
} from './ui'

const standingAsUrl = (token: string) => `${window.location.origin}/l/s${token}`
const terminalEnrollUrl = (token: string) => `${window.location.origin}/l/t${token}`

/** What one of the three surfaces says about itself. The same keys the shared `SecretCard`
 *  reads, minus the ones only a card head used — `body` and `hint` are now the two ⓘ. */
interface LinkSecretCopy {
  body: string
  stateLabel: string
  stateOn: string
  stateOff: string
  keyLabel: string
  exampleLabel: string
  docsLink: string
  enableBtn: string
  rotateBtn: string
  rotateMsg: string
  disableBtn: string
  disableMsg: string
  hint: string
}

/**
 * One secret surface as rows of the settings sheet.
 *
 * ⚠️ Returns a Fragment, never a wrapper element: `.adm-settings` is a CSS grid whose rows are
 * `display: contents`, so a <div> around them would take every cell out of the table's columns.
 */
function SecretRows({ secret, copy, docsUrl, example, showKey, print }: {
  secret: SecretApi
  copy: LinkSecretCopy
  docsUrl: string
  /** the one line the other system needs, built around the freshly minted value */
  example: (token: string) => string
  /** the Einsatz-Link hands out the KEY itself (the alerting system signs with it); the two
   *  standing links only ever hand out the URL that carries theirs */
  showKey?: boolean
  /** the fixe Atemschutz-URL hangs its printable QR card in the action row */
  print?: { label: string; run: () => void }
}) {
  const { state, busy, result, clearResult, rotate, disable } = secret
  if (state === null) return null
  return (
    <>
      <SettingsGroup title={copy.stateLabel} tip={copy.body} />
      {/* The badge carries no label of its own here — the row's Einstellung column already
          names it, and the divider above names the surface. */}
      <SettingRow label={copy.keyLabel} tip={copy.hint}>
        <StatusBadge
          tone={state.configured ? 'on' : 'off'}
          label=""
          state={state.configured ? copy.stateOn : copy.stateOff}
        />
      </SettingRow>
      {state.token && showKey && (
        <SettingsNote>
          <CopyChip value={state.token} display={`${copy.keyLabel}: ${state.token}`} />
        </SettingsNote>
      )}
      {state.token && (
        <SettingsNote>
          <div className="adm-cap-example">
            <p className="adm-card-cap">
              {copy.exampleLabel} — <a href={docsUrl} target="_blank" rel="noreferrer">{copy.docsLink}</a>
            </p>
            <CopyChip value={example(state.token)} />
          </div>
        </SettingsNote>
      )}
      <SettingsNote>
        <div className="adm-actions">
          {state.configured ? (
            <>
              {print && (
                <button type="button" className="btn adm-save-btn" disabled={busy} onClick={print.run}>
                  {print.label}
                </button>
              )}
              {/* the primary slot belongs to whatever is the useful action here: printing the
                  card where there is one to print, rotating where there is not */}
              <ConfirmButton label={copy.rotateBtn} question={copy.rotateMsg} primary={!print}
                disabled={busy} onConfirm={() => void rotate()} />
              <ConfirmButton label={copy.disableBtn} question={copy.disableMsg} danger
                disabled={busy} onConfirm={() => void disable()} />
            </>
          ) : (
            <button type="button" className="btn adm-save-btn" disabled={busy} onClick={() => void rotate()}>
              {copy.enableBtn}
            </button>
          )}
          {result && <ResultChip tone={result.tone} onExpire={clearResult}>{result.text}</ResultChip>}
        </div>
      </SettingsNote>
    </>
  )
}

export function IncidentLinkAdminView() {
  const C = appConfig.copy.admin.einsatzlink
  const T = appConfig.copy.admin.terminal
  const A = appConfig.copy.admin.atemschutzUrl
  // Doc addresses live in the copy layer (admin.docs) — one line for a fork to retarget.
  const D = appConfig.copy.admin.docs
  const secret = useSecret('/api/incident-link/secret', { rotated: C.rotated, disabled: C.disabled, failed: C.failed })
  const terminal = useSecret('/api/incident-link/terminal/secret', { rotated: T.rotated, disabled: T.disabled, failed: T.failed })
  const standing = useSecret('/api/incident-link/atemschutz/secret', { rotated: A.rotated, disabled: A.disabled, failed: A.failed })

  const printCard = async () => {
    if (!standing.state?.token) return
    try {
      const { downloadStandingAsCard } = await import('./standingAsPdf')
      await downloadStandingAsCard(standingAsUrl(standing.state.token), getDeploymentConfig().identity?.appName ?? 'KP Front')
    } catch { standing.report('err', A.printFailed) }
  }

  const docsUrl = `${D.repo}${D.incidentLink}`

  return (
    <SettingsSheet>
      <SecretRows
        secret={secret}
        // this surface calls the value a Schlüssel, not a Token — it signs, it does not authenticate
        copy={C}
        docsUrl={docsUrl}
        showKey
        // The URL shape the alerting system composes around its own signed token — the one thing
        // besides the key an operator has to type into the other system.
        // ⚠️ `<token>` STAYS a placeholder here, and this is the one surface where it must. The
        // two standing links below hand out a real address because their key IS the token in it
        // (terminalEnrollUrl / standingAsUrl); this key only SIGNS the tokens the alerting system
        // mints per Einsatz, so there is no link for KP Front to show — and pasting the key into
        // the URL would publish the signing secret in a link that opens nothing.
        example={() => `${window.location.origin}/l/<token>`}
      />
      <SecretRows secret={terminal} copy={T} docsUrl={docsUrl} showKey example={terminalEnrollUrl} />
      <SecretRows
        secret={standing}
        copy={A}
        docsUrl={docsUrl}
        example={standingAsUrl}
        print={{ label: A.printBtn, run: () => void printCard() }}
      />
    </SettingsSheet>
  )
}
