import { useEffect, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { useMeldung } from '../lib/useMeldung'
import { freshWindShift } from '../lib/vehiclePresence'
import { serverNow } from '../lib/serverClock'
import type { TimelineEvent } from '../types'

/** Waved-away shifts, per device — localStorage so a reload does not raise it again (a tiny
 *  device flag, which is what localStorage is still for). Capped: the newest few are all that
 *  can still be fresh. */
const KEY = 'kp-front-wind-shift-seen'
const CAP = 20

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch { return new Set() } // private mode / no storage: in memory for this page only
}

function writeSeen(seen: Set<string>) {
  try { localStorage.setItem(KEY, JSON.stringify([...seen].slice(-CAP))) } catch { /* see readSeen */ }
}

/**
 * «Wind dreht: W → NO (286° → 66°) · Lüfter prüfen» — on the Meldeleiste, once per device.
 *
 * The SERVER observes the weather (backend · app/observations, 24.09.2026) and writes ONE Verlauf
 * row for a confirmed shift under a derived id. Nothing server-originated reached the Meldeleiste
 * before this — every row there is derived on the device from state it already holds (the alarm
 * pool, the Wiedervorlagen, the GPS-follow pass) — so the row IS the notice: a fresh `wxd-` row
 * in the synced Verlauf stands here until it is waved away or is half an hour old. No new
 * channel, and a device that was asleep when the wind turned still gets it when it wakes, if it
 * is still news.
 */
export function WindShiftMeldung({ incidentId, rows, onOpenJournal }: {
  incidentId: string
  rows: readonly TimelineEvent[]
  onOpenJournal?: () => void
}) {
  const C = appConfig.copy.weather
  const [seen, setSeen] = useState(readSeen)
  const [now, setNow] = useState(() => serverNow())
  // a fresh row ages out of the strip without anybody touching it
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 60_000)
    return () => clearInterval(t)
  }, [])
  // a row id is unique per Einsatz only, so what this device waved away is kept per Einsatz
  const prefix = `${incidentId}:`
  const shift = freshWindShift(rows, now, new Set([...seen].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))))
  const dismiss = () => {
    if (!shift) return
    const next = new Set(seen).add(prefix + shift.id)
    writeSeen(next)
    setSeen(next)
  }
  useMeldung(shift ? {
    id: `wind:${shift.id}`,
    kind: 'wind',
    tone: 'warn',
    icon: 'wind',
    title: shift.title,
    sub: shift.sub,
    ...(onOpenJournal ? { onOpen: { label: C.windShiftOpen, onClick: onOpenJournal } } : {}),
    dismiss: { label: C.windShiftDismiss, onClick: dismiss },
  } : null)
  return null
}
