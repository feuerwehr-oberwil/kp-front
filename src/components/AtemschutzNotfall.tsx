import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from '../lib/format'
import { cx } from '../lib/cx'
import { confirmDialog } from '../lib/ui'
import { useMeldung } from '../lib/useMeldung'
import { serverNow } from '../lib/serverClock'
import { fmtClock, notfallFacts, safetyInside, safetyReady, truppInNotfall, truppLogName } from '../lib/atemschutz'
import { notfallFactLine, notfallHead, notfallWho } from '../lib/notfall'
import { NODE_HOLD_ARM_MS, useNodeHold } from '../lib/nodeHold'
import type { Trupp } from '../types'
import s from './Atemschutz.module.css'

// The Atemschutznotfall (F1, 08.10.2026) — ONE Trupp in distress, said by a person.
//
// Three pieces live here, because they describe the same emergency and must never word it twice:
//  · `NotfallHold` — the held tile on the Trupp's card that raises it, and the same tile that ends
//    it («Notfall beendet»). The hold is `lib/nodeHold`, the app's one deliberate hold (250 ms of
//    stillness, then the whole tile fills to 825 ms) — a Notfall is never one brushed tap away,
//    and neither is silencing one.
//  · `NotfallBanner` — the top of the Tafel on every board while a Notfall runs: who, the clock,
//    what the record last knew (place, Druck with its age, Kanal), and the first thing to do:
//    «Sicherungstrupp einsetzen» (the board's existing Sicherungstrupp, its ordinary Eintritt).
//  · `AtemschutzNotfallMeldungen` — the same, as the TOP row of the Meldeleiste on every other
//    surface (MELDUNG_RANK.notfall = 0, above the überfällig row and a fresh dispatch).
// The wording is deliberately neutral and short — it mirrors the AS emergency procedure
// (FwDV 7 / FKS) and the station's AS instructors check it (copy · atemschutz.notfall).

/** How long a plain tap's «Gedrückt halten» stands in the tile's place of its word. */
export const NOTFALL_TAP_HINT_MS = 1600
/** …and how long a completed hold shows the tile full, before it turns into its other face. */
export const NOTFALL_FIRED_MS = 450

/**
 * The held tile — «Notfall» on a crew inside, «Notfall beendet» on a crew in one.
 *
 * The WHOLE TILE is the progress (owner feedback 10.10.2026 — a 24px ring around the glyph was
 * the hold's only feedback and read as «loading»): a fill sweeps left→right across the tile's
 * background in step with `hold.armed.progress` (`--hold`, a `scaleX` on a pseudo layer — no
 * reflow, the word never moves), red for «Notfall», green for «Notfall beendet». A completed hold
 * shows the tile full for a beat (`NOTFALL_FIRED_MS`, in the face that fired), so the hand sees
 * that it counted before the tile becomes its other face.
 *
 * ⚠️ A TAP does nothing but say how: the tile's own word becomes «Gedrückt halten» for
 * `NOTFALL_TAP_HINT_MS`, in place — no toast — because the deliberate act is the hold, and a tap
 * that raised the loudest alarm in the app would be raised by every glove that brushes the card.
 * A click with no pointer behind it (keyboard, switch access: `detail === 0`) cannot hold, so it
 * asks ONE question instead, the safe answer focused.
 * ⚠️ `data-holdaction` rides in on the hold's props, so the app-wide hold-tooltip never claims the
 * press (AGENTS.md · touch vocabulary).
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
  // fill was a HOLD (fired or let go), never a tap asking how
  const downAt = useRef(0)
  // a tap's «Gedrückt halten» (a nonce, so a second tap restarts its time) and the fired beat
  const [tapHint, setTapHint] = useState(0)
  const [fired, setFired] = useState<'act' | 'end' | null>(null)
  useEffect(() => {
    if (!tapHint) return
    const id = setTimeout(() => setTapHint(0), NOTFALL_TAP_HINT_MS)
    return () => clearTimeout(id)
  }, [tapHint])
  useEffect(() => {
    if (!fired) return
    const id = setTimeout(() => setFired(null), NOTFALL_FIRED_MS)
    return () => clearTimeout(id)
  }, [fired])
  // the face on screen: the one that just fired keeps the tile for its beat
  const isEnd = fired ? fired === 'end' : end
  const label = end ? nf.end : nf.act
  const hint = end ? nf.endHint : nf.actHint
  const press = hold.press(end ? 'notfall-end' : 'notfall', () => { setFired(end ? 'end' : 'act'); onFire() })
  const progress = fired ? 1 : hold.armed?.progress ?? 0
  return (
    <button type="button"
      className={cx(s.actBtn, isEnd ? s.actNotfallEnd : s.actNotfall, (hold.armed || fired) && s.actHolding, fired && s.actFired, className)}
      style={{ '--hold': progress } as CSSProperties}
      aria-label={`${label} – ${hint}`} title={hint}
      {...press}
      onPointerDown={(e) => { downAt.current = Date.now(); setTapHint(0); press.onPointerDown(e) }}
      onClick={(e) => {
        if (e.detail !== 0 && Date.now() - downAt.current >= NODE_HOLD_ARM_MS) return // the end of a hold
        if (e.detail === 0) {
          void confirmDialog({ title: label, message: hint, confirmLabel: label, cancelLabel: appConfig.copy.cancel, safeAnswer: 'cancel', danger: !end })
            .then((ok) => { if (ok) onFire() })
          return
        }
        setTapHint((n) => n + 1)
      }}>
      {/* the glyph keeps the 24px box the ring had, so the resting tile did not move a pixel */}
      <span className={s.holdGlyph} aria-hidden><Icon id={isEnd ? 'check' : 'warn'} /></span>
      <span>{tapHint && !fired ? nf.holdHint : isEnd ? nf.end : nf.act}</span>
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
 *
 * ⚠️ Compact on purpose (owner feedback 10.10.2026, phone ~620px tall before): it is sticky, so
 * every pixel of it is a pixel of the board it covers. Two rows of head — «⚠ NOTFALL» with the
 * clock on ONE line, then the name the radio uses («Trupp 1») over its people — the facts as one
 * dot-separated line, and the acts on ONE row: the primary tile (flex) carries its own reason
 * as a small second line («Kein Sicherungstrupp bereit» under «Sicherungstrupp bestimmen», the
 * ready crew's name under «… einsetzen»), «Zum Trupp ›» compact at the end. The board measures
 * the stack (AtemschutzView · `--nf-h`) so an opened card parks BELOW it, never under it.
 */
export function NotfallBanner({ t, now, place, ready, inside, canEdit, dense = false, onDeploySafety, pickSafety, defineSafety, onDefineSafety, onGo }: {
  t: Trupp
  now: number
  place?: string
  /** the Sicherungstrupps ready to go in (lib/atemschutz · safetyReady), board order */
  ready: Trupp[]
  /** …and the ones already sent in (safetyInside) */
  inside: Trupp[]
  canEdit: boolean
  /** several Notfälle at once: each banner is ONE head row (who + clock) over its acts — the
   *  people and the facts stay on the card and in the Verlauf, or two banners fill a phone */
  dense?: boolean
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
  const head = notfallHead(t)
  const facts = notfallFactLine(t, now, place).slice(1) // the «seit» is the clock's caption here
  // the primary tile, with its small second line: whom it sends, or why it must be named first
  const primary = (cls: string, word: string, sub: string | undefined, onClick: (() => void) | undefined, icon?: ReactNode) => (
    <button type="button" className={cx(s.actBtn, cls, s.nfPrimary)} onClick={onClick}>
      {icon}
      <span className={s.nfPrimaryTxt}>
        <span>{word}</span>
        {sub && <span className={s.nfPrimarySub}>{sub}</span>}
      </span>
    </button>
  )
  const deployBtn = primary(s.actEnter, nf.sitrDeploy, ready.length === 1 ? ready[0].name : undefined,
    ready.length === 1 ? () => onDeploySafety(ready[0].id) : undefined, <Icon id="flag" />)
  const defineBtn = primary(s.nfDefine, nf.sitrDefine, nf.sitrNone, defineSafety ? undefined : onDefineSafety)
  const canDefine = canEdit && !!(defineSafety || onDefineSafety)
  return (
    <section className={cx(s.nfBanner, dense && s.nfDense)} role="alert" aria-label={`${nf.title}: ${notfallWho(t)}`}>
      {/* row 1: what it is, and for how long — the clock on ONE line, never a column of its own */}
      <div className={s.nfTop}>
        <Icon id="warn" />
        <span className={s.nfKicker}>{nf.title}</span>
        {dense && <span className={s.nfName}>{head.name}</span>}
        <span className={s.nfClock}>
          <b>{fmtClock(f.sinceSec)}</b>
          {t.notfallAt && <span>{fillTemplate(nf.since, { time: formatTime(new Date(t.notfallAt)) })}</span>}
        </span>
      </div>
      {/* row 2: who — the name the radio uses as the headline, the people below it */}
      {!dense && (
        <div className={s.nfWho}>
          <span className={s.nfName}>{head.name}</span>
          {head.crew && <span className={s.nfCrew}>{head.crew}</span>}
        </div>
      )}
      {!dense && facts.length > 0 && <p className={s.nfFacts}>{facts.join(' · ')}</p>}
      <div className={s.nfActs}>
        {inside.length > 0 ? (
          <p className={s.nfNote}>{fillTemplate(nf.sitrInside, {
            name: inside[0].name,
            time: inside[0].entryTime ? formatTime(new Date(inside[0].entryTime)) : '',
          })}</p>
        ) : ready.length > 0 ? (
          // a device that cannot write the Tafel is not told «nobody ready» while one stands ready
          !canEdit ? null : ready.length > 1 && pickSafety ? pickSafety(deployBtn) : deployBtn
        ) : canDefine ? (
          defineSafety ? defineSafety(defineBtn) : defineBtn
        ) : (
          <p className={s.nfNote}>{nf.sitrNone}</p>
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
