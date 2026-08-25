import { useMemo, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { fillTemplate, formatTime } from '../lib/format'
import { rankAbbr, rankOrder } from '../lib/rank'
import { matchesQuery, searchQuery } from '../lib/search'
import { Modal } from './panels/_shared'
import type { Person } from '../types'
import type { ShareApi, ShareState } from '../lib/useShareMyPosition'
import s from './SharePosition.module.css'

// Standort teilen — the phone half of the feature: the one-time question, the name picker,
// and the pill that has to make it obvious at a glance that this device is reporting.
//
// The tone is set by what this actually is: a volunteer's private phone telling the command
// post where its owner is. So the question says who sees it, for how long, and what happens
// when the phone is locked, BEFORE the Ja button — not behind a «mehr erfahren» link — and
// the answer (either answer) is remembered so nobody is nagged at the next alarm.

/** What the pill says per state, and whether that reads as running, waiting or wrong. */
const TONE: Record<Exclude<ShareState, 'off'>, 'live' | 'wait' | 'warn'> = {
  on: 'live',
  starting: 'wait',
  paused: 'wait',
  denied: 'warn',
  taken: 'warn',
  failing: 'warn',
}

function labelFor(state: Exclude<ShareState, 'off'>): string {
  const C = appConfig.copy.sharePosition
  return { on: C.on, starting: C.starting, paused: C.paused, denied: C.denied, taken: C.taken, failing: C.failing }[state]
}

/** Why it is not simply working. `imprecise` only qualifies the SEARCHING state — everywhere
 *  else the state's own reason is the more useful thing to say. */
function hintFor(state: Exclude<ShareState, 'off'>, imprecise: boolean): string | null {
  const C = appConfig.copy.sharePosition
  if (state === 'starting') return imprecise ? C.impreciseHint : null
  return { on: null, starting: null, paused: C.pausedHint, denied: C.deniedHint, taken: C.takenHint, failing: C.failingHint }[state]
}

/**
 * The one-time question, then the name picker. Two steps rather than one screen: the decision
 * («teile ich meinen Standort?») and the identification («wer bin ich?») are different
 * questions, and stacking a roster list under the explanation buries the explanation.
 *
 * The picker is asked ONCE PER EINSATZ, never once per device: a Tablet that gets handed
 * around reported a whole Einsatz under the previous holder's name. The remembered person is
 * offered first so the usual case (own phone, next alarm) is still one tap — but it is a tap,
 * and that tap is the confirmation.
 */
export function SharePositionSheet({ roster, onPick, onClose, pickOnly, lastPersonId, reconfirm }: {
  roster: Person[]
  onPick: (personId: string, displayName: string) => void
  onClose: () => void
  /** skip the explanation — the device already has permission and is only changing the name */
  pickOnly?: boolean
  /** whom this device last reported as. Offered first and marked, never pre-selected. */
  lastPersonId?: string | null
  /** this is the «neuer Einsatz» ask, not «Namen ändern» — say why the question is back */
  reconfirm?: boolean
}) {
  const C = appConfig.copy.sharePosition
  const [step, setStep] = useState<'ask' | 'pick'>(pickOnly ? 'pick' : 'ask')
  const [q, setQ] = useState('')

  const people = useMemo(() => {
    // same tolerance as every other roster search (lib/search): umlauts either way, one typo
    const needle = searchQuery(q)
    return roster
      .filter((p) => p.active && (!needle || matchesQuery(needle, p.displayName)))
      // Whoever this device reported as last goes to the top — one scroll-free tap for the
      // phone in somebody's own pocket. Below that: officer-first, then alphabetical, the same
      // order every other roster list uses, so finding yourself is the same motion here as in
      // the Anwesenheit.
      .sort((a, b) =>
        Number(b.id === lastPersonId) - Number(a.id === lastPersonId)
        || rankOrder(a.rank) - rankOrder(b.rank)
        || a.displayName.localeCompare(b.displayName, 'de-CH'))
  }, [roster, q, lastPersonId])

  if (step === 'ask') {
    return (
      <Modal title={C.askTitle} onClose={onClose} fit>
        <div className={s.ask}>
          <p className={s.lead}>{C.askBody}</p>
          <ul className={s.facts}>
            <li><Icon id="eye" /><span>{C.askWho}</span></li>
            <li><Icon id="flag" /><span>{C.askHowLong}</span></li>
            <li><Icon id="warn" /><span>{C.askBackground}</span></li>
          </ul>
          <p className={s.note}>{C.askAgain}</p>
          <div className={s.actions}>
            <button type="button" className={s.primary} onClick={() => setStep('pick')}>{C.yes}</button>
            {/* «Nein, danke» is just closing. Nothing has to be remembered: the app never
                proposes this, so there is no repeat prompt to suppress. */}
            <button type="button" className={s.ghost} onClick={onClose}>{C.no}</button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={C.pickTitle} onClose={onClose}>
      <div className={s.pick}>
        <p className={s.note}>{reconfirm ? C.pickAgain : C.pickHint}</p>
        <input
          className={s.search}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={C.search}
          autoCapitalize="words"
          enterKeyHint="search"
          aria-label={C.search}
        />
        <ul className={s.roster}>
          {people.map((p) => (
            <li key={p.id}>
              <button type="button" className={s.person} onClick={() => onPick(p.id, p.displayName)}>
                {p.rank && <span className={s.rank}>{rankAbbr(p.rank)}</span>}
                <span className={s.name}>{p.displayName}</span>
                {/* A mark, not a pre-selection: nothing is sent until this row is tapped. */}
                {p.id === lastPersonId && <span className={s.last}>{C.pickLast}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}

/**
 * The indicator that this device is reporting, shown only while it actually is.
 *
 * It is a READ-OUT that happens to be tappable, not the switch — the switch is the «Standort
 * teilen» row in the compass menu. It still carries a stop, because a device broadcasting
 * somebody's location must let them end that from wherever they are looking, without first
 * finding the right menu.
 */
export function SharePositionPill({ share, onChangeName }: { share: ShareApi; onChangeName: () => void }) {
  const C = appConfig.copy.sharePosition
  const [open, setOpen] = useState(false)
  if (share.state === 'off') return null
  const state = share.state
  const tone = TONE[state]
  const hint = hintFor(state, share.imprecise)

  return (
    <>
      {/* Icon only. The state names are long in German («Standort kommt nicht an») and inline
          text either truncated to «Standort kommt nic…» — which says nothing — or pushed the
          incident title off a narrow bar. The COLOUR carries the state at a glance (green
          pulsing = reporting, amber = needs you), the tooltip and the sheet carry the words. */}
      <button
        type="button"
        className={`${s.pill} ${s[tone]}`}
        onClick={() => setOpen(true)}
        title={labelFor(state)}
        aria-label={labelFor(state)}
      >
        {/* same glyph as the row that switches it on (see MapViewsMenu) — the switch and its
            indicator have to be recognisably the same thing */}
        <Icon id="people" />
      </button>
      {open && (
        <Modal title={labelFor(state)} onClose={() => setOpen(false)} fit>
          <div className={s.ask}>
            {hint && <p className={s.lead}>{hint}</p>}
            {share.pref?.displayName && (
              <p className={s.note}>{fillTemplate(C.settingsAs, { name: share.pref.displayName })}</p>
            )}
            {share.lastAt != null && (
              <p className={s.note}>{fillTemplate(C.lastAt, { t: formatTime(new Date(share.lastAt), true) })}</p>
            )}
            <div className={s.actions}>
              <button
                type="button"
                className={s.danger}
                onClick={() => { setOpen(false); share.stop() }}
              >
                {C.stop}
              </button>
              <button
                type="button"
                className={s.ghost}
                onClick={() => { setOpen(false); onChangeName() }}
              >
                {C.change}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
