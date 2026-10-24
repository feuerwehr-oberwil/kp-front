// «Alarm auf diesem Gerät» (3am sweep §1, 23.10.2026): the readiness rows at the top of «Auf
// diesem Gerät» and under Einstellungen › Gerät, and the Karte home's nudge card. The rules —
// which row is red, which fix it offers, when the card may show — are lib/alarmReadiness; this
// file gathers the facts (display mode, Notification.permission, the device record, the login's
// expiry) and wires the fixes: «Erlauben» = the permission ask + the push registration,
// «Erneuern» = re-register, «Installieren» = the InstallGuide, «Testalarm senden» = one push to
// this browser, «Keine Alarme auf diesem Gerät» = push off (reversible in the rows).
// The 3am rule: nothing modal by itself, no OS dialog without a tap.

import { useCallback, useEffect, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { useAuth } from '../../lib/auth'
import { cx } from '../../lib/cx'
import { fillTemplate } from '../../lib/format'
import { fmtDay } from '../../lib/buildingCard'
import { Icon } from '../../lib/icons'
import { toast } from '../../lib/ui'
import { ensureNotifyPermission } from '../../lib/alarm'
import { getInstallPlatform, isStandalone, onInstallStateChange } from '../../lib/installPrompt'
import {
  LATER_DAYS, alarmReady, nudgeDue, onReadinessStore, patchReadinessStore, readReadinessStore, readinessRows,
  type ReadinessFix, type ReadinessRow, type ReadinessStore,
} from '../../lib/alarmReadiness'
import { disablePush, enablePush, ensurePushSubscription, pushAvailable, renewPushSubscription, sendTestPush } from '../../lib/push'
import { Button } from '../Button'
import { InstallGuide } from '../InstallGuide'
import { ListCard, ListGroup, ListRow } from '../ListRow'
import s from './Karte.module.css'

const DAY = 24 * 3600 * 1000
const permissionNow = (): NotificationPermission | 'unsupported' =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission

/** The facts, re-read whenever something that moves them happens: the device record, the
 *  install state, the page coming back (the person may have allowed notifications in the
 *  system settings meanwhile), or a fix this surface ran. */
function useAlarmReadiness() {
  const { user } = useAuth()
  // the clock the rows are judged against — moved on every re-read, never read in render
  const [now, setNow] = useState(() => Date.now())
  const refresh = useCallback(() => setNow(Date.now()), [])
  const [store, setStore] = useState<ReadinessStore>(readReadinessStore)
  const [available, setAvailable] = useState<boolean | null>(null)
  useEffect(() => onReadinessStore(() => { setStore(readReadinessStore()); refresh() }), [refresh])
  useEffect(() => onInstallStateChange(refresh), [refresh])
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])
  useEffect(() => {
    let alive = true
    void pushAvailable().then((v) => { if (alive) setAvailable(v) })
    return () => { alive = false }
  }, [])
  const sessionUntil = user?.session_until ? new Date(user.session_until).getTime() : null
  const rows = readinessRows({
    now, standalone: isStandalone(), platform: getInstallPlatform(), permission: permissionNow(),
    subscribedAt: store.subscribedAt, sessionUntil: Number.isFinite(sessionUntil) ? sessionUntil : null,
  })
  return { now, rows, store, available, refresh, linkSession: !!user?.link_scoped }
}

/** The fixes. Each ends in a re-read so the row it belongs to answers at once. */
function useFixes(refresh: () => void) {
  const [guide, setGuide] = useState(false)
  const A = appConfig.copy.karte.device.alarm
  const run = async (fix: ReadinessFix) => {
    if (fix === 'install') { setGuide(true); return }
    if (fix === 'allow') {
      if (await ensureNotifyPermission()) await ensurePushSubscription(true)
    } else if (fix === 'renew') {
      // with a login the normal registration; without one the subscription is its own credential
      if (!(await ensurePushSubscription(true))) await renewPushSubscription()
    }
    refresh()
  }
  const test = async () => {
    const r = await sendTestPush()
    const text = r === 'sent' ? A.testSent : r === 'wait' ? A.testWait : r === 'unavailable' ? A.unavailable : r === 'unregistered' ? A.testUnregistered : A.testFailed
    toast(text, r === 'sent' ? { icon: 'bell' } : { icon: 'warn', tone: 'warn' })
    refresh()
  }
  const optOut = async () => { await disablePush(); refresh() }
  const optIn = async () => {
    // the permission may never have been asked for: this tap is the gesture that may ask
    if (permissionNow() === 'default') await ensureNotifyPermission()
    await enablePush()
    refresh()
  }
  const guideEl = guide ? <InstallGuide onClose={() => setGuide(false)} /> : null
  return { run, test, optOut, optIn, guideEl }
}

const fixLabel = (fix: ReadinessFix, A: typeof appConfig.copy.karte.device.alarm) =>
  fix === 'install' ? A.install : fix === 'allow' ? A.allow : fix === 'renew' ? A.renew : null

/** One readiness row: dot · name · what is the matter · its fix (where it has a button). */
function Row({ row, onFix }: { row: ReadinessRow; onFix: (fix: ReadinessFix) => void }) {
  const A = appConfig.copy.karte.device.alarm
  const d = row.at != null ? fmtDay(new Date(row.at).toISOString()) : ''
  const sub = row.key === 'installed' ? A.installedSub[row.sub as keyof typeof A.installedSub]
    : row.key === 'permission' ? A.permissionSub[row.sub as keyof typeof A.permissionSub]
      : row.key === 'subscription' ? fillTemplate(A.subscriptionSub[row.sub as keyof typeof A.subscriptionSub], { d })
        : fillTemplate(A.sessionSub[row.sub as keyof typeof A.sessionSub], { d })
  const label = fixLabel(row.fix, A)
  return (
    <ListRow data-alarm-row={row.key} data-state={row.state}
      lead={<span className={cx(s.alarmDot, row.state === 'warn' && s.alarmWarn, row.state === 'red' && s.alarmRed)} aria-hidden />}
      title={A[row.key]} sub={<>{sub}<span className="sr-only"> · {A.state[row.state]}</span></>}
      end={label && <Button variant={row.state === 'red' ? 'primary' : 'secondary'} onClick={() => onFix(row.fix)}>{label}</Button>} />
  )
}

/** The rows, the Testalarm and the opt-out — at the top of «Auf diesem Gerät» and under
 *  Einstellungen › Gerät. Nothing for a link session (no login, no push). Seeing the rows green
 *  counts as a check (the nudge card's 90-day clock). */
export function AlarmReadinessRows({ className }: { className?: string }) {
  const A = appConfig.copy.karte.device.alarm
  const { rows, store, available, refresh, linkSession } = useAlarmReadiness()
  const { run, test, optOut, optIn, guideEl } = useFixes(refresh)
  const ready = alarmReady(rows)
  useEffect(() => {
    if (!ready || !available || store.optedOut) return
    if (store.lastCheck == null || Date.now() - store.lastCheck > DAY) patchReadinessStore({ lastCheck: Date.now() })
  }, [ready, available, store.optedOut, store.lastCheck])
  if (linkSession) return null
  const lastTest = store.lastTest != null ? fillTemplate(A.testLast, { d: fmtDay(new Date(store.lastTest).toISOString()) }) : A.testNever
  return (
    <div className={cx(s.alarmRows, className)} data-alarm-rows="">
      <ListGroup label={A.title} end={available === false ? undefined : ready && !store.optedOut ? <Icon id="check" className={s.alarmOk} /> : undefined}>
        {rows.map((r) => <Row key={r.key} row={r} onFix={(f) => void run(f)} />)}
        {store.optedOut ? (
          <ListRow lead={<Icon id="bell-off" />} title={A.optedOut} sub={A.optedOutSub}
            end={<Button variant="primary" onClick={() => void optIn()}>{A.optIn}</Button>} data-alarm-optout="" />
        ) : (
          <ListRow lead={<Icon id="bell-off" />} title={A.optOut} sub={A.optOutSub} chevron={false} onClick={() => void optOut()} data-alarm-optout="" />
        )}
      </ListGroup>
      {available === false ? (
        <div className={cx(s.note, s.amber)}><Icon id="info" /><span>{A.unavailable}</span></div>
      ) : !store.optedOut && (
        <div className={s.alarmTest}>
          <Button icon={<Icon id="bell" />} onClick={() => void test()} data-alarm-test="">{A.test}</Button>
          <span className={s.src}>{lastTest}</span>
        </div>
      )}
      {guideEl}
    </div>
  )
}

/** The Karte home's card (owner's pick, round 1): only when a row is red or nothing was checked
 *  for 90 days, never inside an Einsatz. The first red row with its fix, or — all green — the
 *  Testalarm; «Später» hides it 30 days, «Keine Alarme auf diesem Gerät» for good (push off).
 *  Collapses to nothing when there is nothing to say — not to a line. */
export function AlarmNudgeCard({ inIncident, phone }: { inIncident: boolean; phone: boolean }) {
  const A = appConfig.copy.karte.device.alarm
  const { now, rows, store, available, refresh, linkSession } = useAlarmReadiness()
  const { run, test, optOut, guideEl } = useFixes(refresh)
  if (available == null || !nudgeDue(rows, { now, inIncident, linkSession, pushUnavailable: !available, store })) return guideEl
  const red = rows.find((r) => r.state === 'red') ?? null
  const head = red ? A.nudgeRed : store.lastCheck == null ? A.nudgeCheck : A.nudgeCheckOld
  return (
    <>
      <section className={cx(s.alarmCard, phone && s.alarmCardPhone)} aria-label={A.title} data-alarm-nudge={red ? 'red' : 'check'}>
        <div className={s.alarmEyebrow}>{A.title}</div>
        <h2 className={cx(s.alarmHead, red && s.alarmHeadRed)}>{head}</h2>
        {red ? (
          <ListCard><Row row={red} onFix={(f) => void run(f)} /></ListCard>
        ) : (
          <Button icon={<Icon id="bell" />} onClick={() => void test()} data-alarm-test="">{A.test}</Button>
        )}
        <div className={s.alarmActs}>
          <Button variant="quiet" onClick={() => patchReadinessStore({ laterUntil: Date.now() + LATER_DAYS * DAY })} data-alarm-later="">{A.later}</Button>
          <Button variant="quiet" onClick={() => void optOut()} data-alarm-optout="">{A.optOut}</Button>
        </div>
      </section>
      {guideEl}
    </>
  )
}
