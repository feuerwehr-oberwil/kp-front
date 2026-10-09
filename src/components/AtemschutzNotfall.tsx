import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from '../lib/format'
import { cx } from '../lib/cx'
import { confirmDialog, toast } from '../lib/ui'
import { useMeldung } from '../lib/useMeldung'
import { serverNow } from '../lib/serverClock'
import { fmtClock, notfallFacts, safetyInside, safetyReady, truppInNotfall, truppLogName } from '../lib/atemschutz'
import { notfallFactLine, notfallWho } from '../lib/notfall'
import { NODE_HOLD_ARM_MS, useNodeHold } from '../lib/nodeHold'
import type { Trupp } from '../types'
import s from './Atemschutz.module.css'

// The Atemschutznotfall (F1, 08.10.2026) — ONE Trupp in distress, said by a person.
//
// Three pieces live here, because they describe the same emergency and must never word it twice:
//  · `NotfallHold` — the held tile on the Trupp's card that raises it, and the same tile that ends
//    it («Notfall beendet»). The hold is `lib/nodeHold`, the app's one deliberate hold (250 ms of
//    stillness, then the ring fills to 825 ms) — a Notfall is never one brushed tap away, and
//    neither is silencing one.
//  · `NotfallBanner` — the top of the Tafel on every board while a Notfall runs: who, the clock,
//    what the record last knew (place, Druck with its age, Kanal), and the first thing to do:
//    «Sicherungstrupp einsetzen» (the board's existing Sicherungstrupp, its ordinary Eintritt).
//  · `AtemschutzNotfallMeldungen` — the same, as the TOP row of the Meldeleiste on every other
//    surface (MELDUNG_RANK.notfall = 0, above the überfällig row and a fresh dispatch).
// The wording is deliberately neutral and short — it mirrors the AS emergency procedure
// (FwDV 7 / FKS) and the station's AS instructors check it (copy · atemschutz.notfall).

/**
 * The held tile — «Notfall» on a crew inside, «Notfall beendet» on a crew in one.
 *
 * ⚠️ A TAP does nothing but say how (one toast, «Gedrückt halten …») — the deliberate act is the
 * hold, and a tap that raised the loudest alarm in the app would be raised by every glove that
 * brushes the card. A click with no pointer behind it (keyboard, switch access: `detail === 0`)
 * cannot hold, so it asks ONE question instead, the safe answer focused.
 * ⚠️ `data-holdaction` rides in on the hold's props, so the app-wide hold-tooltip never claims the
 * press (AGENTS.md · touch vocabulary). The ring haloes the glyph; nothing reflows mid-hold.
 */
export function NotfallHold({ end = false, onFire, className }: {
  /** the «Notfall beendet» face of the tile */
  end?: boolean
  onFire: () => void
  className?: string
}) {
  const nf = appConfig.copy.atemschutz.notfall
  const hold = useNodeHold()
  // when the press began — read in the click that ends it: a press long enough to have armed the
  // ring was a HOLD (fired or let go), never a tap asking how
  const downAt = useRef(0)
  const label = end ? nf.end : nf.act
  const hint = end ? nf.endHint : nf.actHint
  const press = hold.press(end ? 'notfall-end' : 'notfall', onFire)
  const progress = hold.armed?.progress ?? 0
  const R = 10
  const len = 2 * Math.PI * R
  return (
    <button type="button" className={cx(s.actBtn, end ? s.actNotfallEnd : s.actNotfall, hold.armed && s.actHolding, className)}
      aria-label={`${label} – ${hint}`} title={hint}
      {...press}
      onPointerDown={(e) => { downAt.current = Date.now(); press.onPointerDown(e) }}
      onClick={(e) => {
        if (e.detail !== 0 && Date.now() - downAt.current >= NODE_HOLD_ARM_MS) return // the end of a hold
        if (e.detail === 0) {
          void confirmDialog({ title: label, message: hint, confirmLabel: label, cancelLabel: appConfig.copy.cancel, safeAnswer: 'cancel', danger: !end })
            .then((ok) => { if (ok) onFire() })
          return
        }
        toast(nf.holdHint, { icon: 'info' })
      }}>
      <span className={s.holdGlyph} aria-hidden>
        <Icon id={end ? 'check' : 'warn'} />
        <svg className={s.holdRing} viewBox="0 0 24 24">
          <circle className={s.holdTrack} cx="12" cy="12" r={R} />
          <circle className={s.holdFill} cx="12" cy="12" r={R}
            strokeDasharray={len} strokeDashoffset={len * (1 - progress)} transform="rotate(-90 12 12)" />
        </svg>
      </span>
      <span>{label}</span>
    </button>
  )
}

/** One second of the deployment's clock, for a surface that shows a running Notfall clock and
 *  ticks nothing else (the Meldeleiste publisher). Runs only while `on`. */
function useSecondTick(on: boolean): number {
  const [now, setNow] = useState(() => serverNow())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(serverNow()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/**
 * The top of the Tafel while a Notfall runs — every board (tablet grid, phone board, the
 * handed-over Tafel). The strip's row steps aside on the board (AtemschutzAlarmMeldung's rule),
 * so this is that row's place here, and it stays put however the board is sorted.
 *
 * The first offered action is «Sicherungstrupp einsetzen»: the Sicherungstrupp standing ready
 * goes in through its ordinary Eintritt (useTruppActions · setTruppStatus, which writes
 * «Sicherungstrupp eingesetzt – Notfall Trupp …, n min nach Auslösung»). Several ready ⇒ the
 * button asks which (`pickSafety`). None ready ⇒ it says so and offers the board's own
 * «Bestimmen» door. One already inside ⇒ it says who and since when, and offers nothing twice.
 */
export function NotfallBanner({ t, now, place, ready, inside, canEdit, onDeploySafety, pickSafety, defineSafety, onDefineSafety, onGo }: {
  t: Trupp
  now: number
  place?: string
  /** the Sicherungstrupps ready to go in (lib/atemschutz · safetyReady), board order */
  ready: Trupp[]
  /** …and the ones already sent in (safetyInside) */
  inside: Trupp[]
  canEdit: boolean
  onDeploySafety: (id: string) => void
  /** several ready: the board's menu that asks which (rendered around the button) */
  pickSafety?: (trigger: ReactElement) => ReactNode
  /** none ready: the board's «Bestimmen» door — a menu of the Trupps standing ready to be put on
   *  «Sichern» (rendered around the button), else straight to the create form (`onDefineSafety`) */
  defineSafety?: (trigger: ReactElement) => ReactNode
  onDefineSafety?: () => void
  onGo: (id: string) => void
}) {
  const nf = appConfig.copy.atemschutz.notfall
  const f = notfallFacts(t, now)
  const facts = notfallFactLine(t, now, place).slice(1) // the «seit» is the clock's caption here
  const deployBtn = (
    <button type="button" className={cx(s.actBtn, s.actEnter, s.nfDeploy)}
      onClick={ready.length === 1 ? () => onDeploySafety(ready[0].id) : undefined}>
      <Icon id="flag" />
      <span className={s.nfDeployTxt}>
        <span>{nf.sitrDeploy}</span>
        {ready.length === 1 && <span className={s.nfDeployWho}>{ready[0].name}</span>}
      </span>
    </button>
  )
  const defineBtn = (
    <button type="button" className={cx(s.actBtn, s.nfDefine)} onClick={defineSafety ? undefined : onDefineSafety}>{nf.sitrDefine}</button>
  )
  return (
    <section className={s.nfBanner} role="alert" aria-label={`${nf.title}: ${notfallWho(t)}`}>
      <div className={s.nfHead}>
        <Icon id="warn" />
        <span className={s.nfKicker}>{nf.title}</span>
        <span className={s.nfName}>{notfallWho(t)}</span>
        <span className={s.nfClock}>
          <b>{fmtClock(f.sinceSec)}</b>
          <span>{t.notfallAt ? fillTemplate(nf.since, { time: formatTime(new Date(t.notfallAt)) }) : ''}</span>
        </span>
      </div>
      {facts.length > 0 && <div className={s.nfFacts}>{facts.map((x) => <span key={x}>{x}</span>)}</div>}
      <div className={s.nfActs}>
        {inside.length > 0 ? (
          <p className={s.nfNote}>{fillTemplate(nf.sitrInside, {
            name: inside[0].name,
            time: inside[0].entryTime ? formatTime(new Date(inside[0].entryTime)) : '',
          })}</p>
        ) : canEdit && ready.length > 0 ? (
          ready.length > 1 && pickSafety ? pickSafety(deployBtn) : deployBtn
        ) : (
          <>
            <p className={s.nfNote}>{nf.sitrNone}</p>
            {canEdit && (defineSafety ? defineSafety(defineBtn) : onDefineSafety ? defineBtn : null)}
          </>
        )}
        <button type="button" className={cx(s.actBtn, s.nfGo)} onClick={() => onGo(t.id)}>
          <span>{nf.goTo}</span><Icon id="chevron" />
        </button>
      </div>
    </section>
  )
}

/**
 * The Notfall's row in the Meldeleiste — the top row on every surface but the Tafel (where the
 * banner above stands instead). One row per Trupp in a Notfall: each is its own emergency with
 * its own clock. No ✕: it stays until «Notfall beendet». The primary is «Sicherungstrupp
 * einsetzen» where exactly one stands ready (it goes in, and the operator lands on the Tafel to see
 * it); with several ready it leads to the Tafel, whose banner asks which; with none, or one
 * already inside, «Zum Trupp» is the one move. A device that cannot write the Tafel gets «Zur
 * Kenntnis genommen», which hides the row on THIS device until the next Notfall.
 */
export function AtemschutzNotfallMeldungen({ trupps, placeOf, canEdit = true, onBoard = false, onAcknowledge, onGoToTrupp, onDeploySafety }: {
  trupps: readonly Trupp[]
  placeOf?: (t: Trupp) => string | undefined
  canEdit?: boolean
  onBoard?: boolean
  onAcknowledge?: () => void
  onGoToTrupp: (id: string) => void
  onDeploySafety?: (id: string) => void
}) {
  const inNotfall = trupps.filter(truppInNotfall)
  const now = useSecondTick(inNotfall.length > 0 && !onBoard)
  const [seen, setSeen] = useState<string[]>([])
  if (onBoard) return null
  const ready = safetyReady(trupps)
  const inside = safetyInside(trupps)
  return <>{inNotfall.filter((t) => !seen.includes(`${t.id}:${t.notfallAt}`)).map((t) => (
    <NotfallMeldung key={t.id} t={t} now={now} place={placeOf?.(t)} ready={ready} insideCount={inside.length}
      canEdit={canEdit} onAcknowledge={onAcknowledge} onGoToTrupp={onGoToTrupp} onDeploySafety={onDeploySafety}
      onAck={canEdit ? undefined : () => setSeen((v) => [...v, `${t.id}:${t.notfallAt}`])} />
  ))}</>
}

function NotfallMeldung({ t, now, place, ready, insideCount, canEdit, onAcknowledge, onGoToTrupp, onDeploySafety, onAck }: {
  t: Trupp; now: number; place?: string; ready: Trupp[]; insideCount: number; canEdit: boolean
  onAcknowledge?: () => void
  onGoToTrupp: (id: string) => void
  onDeploySafety?: (id: string) => void
  onAck?: () => void
}) {
  const az = appConfig.copy.atemschutz
  const nf = az.notfall
  const f = notfallFacts(t, now)
  const go = () => { onAcknowledge?.(); onGoToTrupp(t.id) }
  const deploy = canEdit && insideCount === 0 && ready.length > 0 && onDeploySafety
    ? () => { onAcknowledge?.(); if (ready.length === 1) onDeploySafety(ready[0].id); onGoToTrupp(t.id) }
    : null
  useMeldung({
    id: `notfall:${t.id}`,
    kind: 'notfall',
    tone: 'alarm',
    icon: 'warn',
    title: `${fillTemplate(nf.rowTitle, { name: truppLogName(t) })} · ${fmtClock(f.sinceSec)}`,
    sub: [...notfallFactLine(t, now, place), ...(onAck ? [az.alarmRowReadOnly] : [])].join(' · '),
    // the facts are the message — a row cut at «seit 14:32 · 2. O…» would hide the place
    wrap: true,
    actions: [
      ...(onAck ? [{ label: az.alarmRowAck, onClick: () => { onAcknowledge?.(); onAck() } }] : []),
      ...(deploy ? [{ label: nf.sitrDeploy, primary: true, onClick: deploy }, { label: nf.goTo, onClick: go }]
        : [{ label: nf.goTo, primary: true, onClick: go }]),
    ],
    onOpen: { label: nf.goTo, onClick: go },
  })
  return null
}
