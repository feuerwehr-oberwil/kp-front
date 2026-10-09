import { useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Overlay, Sheet, Menu } from '../lib/overlays'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { fillTemplate, hhmm } from '../lib/format'
import { toast } from '../lib/ui'
import { useWakeLock } from '../lib/useWakeLock'
import {
  anchorFor, composeLagemeldung, finalLines, nextLine, radioSeconds, radioText, wordCount,
  type LageAnchor, type LageAnchorRef, type LageEdits, type LageHidden, type LageInput, type LageLine, type LageMode,
} from '../lib/lagemeldung'
import { Button } from './Button'
import { Segmented } from './Segmented'
import s from './Lagemeldung.module.css'

// The Lagemeldung composer (F3, layout ★A «Zeilen-Entwurf», 09.10.2026) — lazy: it carries the
// engine (lib/lagemeldung), and nothing of either is loaded before the first tap on «Lage».
//
// A sheet over the Karte (tablet) / slide-up (phone). One row per line: tick · slot · text · tag.
// Tap the text to edit it in place, untick to drop it; «Ausgeblendet» sits closed underneath with
// the reason on every item, one tap adds an item back. Two modes on top: «Seit 21:17» (to the ELZ,
// the default) or «Vollständig» (Übergabe, Nachbarwehr, Rück).
//
// ⚠️ Nothing is written until «Gemeldet» — ✕ closes without a trace, and re-opening re-composes
// from the record (it may have moved on). The draft is composed ONCE when the sheet opens (and
// again on a mode switch): lines jumping under the finger while the EL reads them out would be
// worse than a draft a minute old.
// ⚠️ A tier-0 line (a Trupp in Alarm, Vermisste) asks «trotzdem weglassen?» once, inline — never a
// modal on top of a sheet at the radio.

export type LageNextChoice = { kind: 'every'; min: number } | { kind: 'handover' } | { kind: 'none' }

export interface LageSend {
  /** the Lagemeldung as said, one line per slot group */
  text: string
  mode: LageMode
  anchor: LageAnchor
  next: LageNextChoice
  /** when it was composed (the instant the row is dated by) */
  at: number
}

export interface LagemeldungSheetProps {
  /** the record, read once when the sheet opens */
  getInput: () => LageInput
  anchor: LageAnchorRef | null
  /** the rhythm the next booking defaults to (minutes, 0 = none) */
  intervalMin: number
  onClose: () => void
  onSend: (r: LageSend) => void
  /** «Rhythmus ausschalten» — writes at once (the ⋯ menu), absent when there is none running */
  onRhythmOff?: () => void
}

const choiceKey = (c: LageNextChoice): string => (c.kind === 'every' ? `m${c.min}` : c.kind)

export function LagemeldungSheet({ getInput, anchor, intervalMin, onClose, onSend, onRhythmOff }: LagemeldungSheetProps) {
  const C = appConfig.copy.lagemeldung
  // the record, frozen at open (see the header)
  const [input] = useState(getInput)
  const [mode, setMode] = useState<LageMode>('seit')
  const draft = useMemo(() => composeLagemeldung({ ...input, next: undefined }, { mode, anchor }), [input, mode, anchor])
  const [edits, setEdits] = useState<LageEdits>({})
  const [askT0, setAskT0] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const [radio, setRadio] = useState(false)
  const [choice, setChoice] = useState<LageNextChoice>(() => (intervalMin > 0 ? { kind: 'every', min: intervalMin } : { kind: 'none' }))

  const nextAt = choice.kind === 'every' ? input.now + choice.min * 60_000 : choice.kind === 'handover' ? 'handover' as const : null
  const next = nextLine(nextAt)
  const lines = finalLines(draft, edits)
  const said: LageLine[] = [...lines.filter((l) => l.ticked), next]
  const text = radioText(said)
  const words = wordCount(text)
  const over = words > appConfig.lagemeldung.budgetWords
  const at = hhmm(new Date(input.now))
  const anchorAt = anchor ? hhmm(new Date(anchor.at)) : ''

  const setTicked = (key: string, v: boolean) => setEdits((e) => ({ ...e, ticked: { ...e.ticked, [key]: v } }))
  const toggle = (l: LageLine & { ticked: boolean }) => {
    if (l.ticked && l.tier === 0 && askT0 !== l.key) { setAskT0(l.key); return }
    setAskT0(null)
    setTicked(l.key, !l.ticked)
  }
  const setText = (key: string, t: string) => setEdits((e) => ({ ...e, text: { ...e.text, [key]: t } }))
  const addHidden = (h: LageHidden) => setEdits((e) => ({ ...e, added: [...(e.added ?? []), h.key] }))
  const addOwn = () => {
    const i = edits.own?.length ?? 0
    setEdits((e) => ({ ...e, own: [...(e.own ?? []), ''] }))
    setEditing(`own.${i}`)
  }
  const setOwn = (i: number, t: string) => setEdits((e) => ({ ...e, own: (e.own ?? []).map((x, j) => (j === i ? t : x)) }))

  const send = () => {
    onSend({ text: radioText(said, ' '), mode: draft.mode, anchor: anchorFor(draft, edits, anchor), next: choice, at: input.now })
  }
  const share = async () => {
    const body = `${C.title} ${at}\n${text}`
    try {
      if (typeof navigator.share === 'function') { await navigator.share({ title: `${C.title} ${at}`, text: body }); return }
      await navigator.clipboard.writeText(body)
      toast(C.shareCopied, { icon: 'copy', tone: 'success' })
    } catch (err) {
      // the share sheet dismissed by its owner is not a failure
      if ((err as { name?: string } | null)?.name === 'AbortError') return
      toast(C.shareFailed, { icon: 'warn', tone: 'warn' })
    }
  }

  const added = new Set(edits.added ?? [])
  const hidden = draft.hidden.filter((h) => !added.has(h.key))
  const counts = hidden.reduce<Record<string, number>>((a, h) => ({ ...a, [h.reason]: (a[h.reason] ?? 0) + 1 }), {})

  // one label per slot group: the first row of a slot carries it, the rest leave the cell empty
  const rows = lines.map((l, i) => ({ l, label: i > 0 && lines[i - 1].slot === l.slot ? '' : C.slots[l.slot] }))

  const footer = (
    <>
      <span className={cx(s.length, over && s.over)} role="status" title={over ? fillTemplate(C.overBudget, { n: words }) : undefined}>
        {fillTemplate(C.seconds, { s: radioSeconds(words) })}
        <span className={s.words}>{fillTemplate(C.words, { n: words })}</span>
      </span>
      <Menu
        trigger={<button type="button" className="ip-btn" aria-label={C.more} title={C.more}><Icon id="more" /></button>}
        side="top"
        items={[
          { label: <><Icon id="share-ios" /> {C.share}</>, onClick: () => { void share() } },
          ...(onRhythmOff ? [{ label: <><Icon id="bell-off" /> {C.rhythmOffAction}</>, onClick: onRhythmOff }] : []),
        ]}
      />
      <Button icon={<Icon id="radio" />} onClick={() => setRadio(true)}>{C.radio}</Button>
      <Button variant="primary" icon={<Icon id="check" />} onClick={send} title={C.sendHint}>{C.send}</Button>
    </>
  )

  return (
    <>
      <Sheet
        open={!radio}
        onClose={onClose}
        sheetClassName={s.sheet}
        title={<span className={s.title}>{C.title} <span className={s.titleAt}>{at}</span></span>}
        footer={footer}
      >
        <div className={s.modes}>
          {draft.first
            ? <span className={s.first}><b>{C.modeFirst}</b> · {C.firstNote}</span>
            : (
              <>
                <Segmented<LageMode>
                  ariaLabel={C.modeLabel}
                  value={mode}
                  onChange={(m) => { setMode(m); setAskT0(null) }}
                  options={[{ value: 'seit', label: fillTemplate(C.modeSeit, { t: anchorAt }) }, { value: 'voll', label: C.modeVoll }]}
                />
                <span className={s.modeNote}>{mode === 'seit' ? fillTemplate(C.seitNote, { t: anchorAt }) : C.vollNote}</span>
              </>
            )}
        </div>

        <ul className={s.lines} aria-label={C.title}>
          {rows.length === 0 && (
            <li className={s.empty}>{draft.first ? C.emptyFirst : fillTemplate(C.empty, { t: anchorAt })}</li>
          )}
          {rows.map(({ l, label }) => {
            const own = l.key.startsWith('own.')
            const ownIndex = own ? Number(l.key.slice(4)) : -1
            return (
              <li key={l.key} className={cx(s.row, !l.ticked && s.off, l.tier === 0 && s.t0)}>
                <button type="button" className={s.tick} aria-pressed={l.ticked} aria-label={`${l.ticked ? C.untick : C.tick}: ${l.text}`}
                  onClick={() => toggle(l)}>
                  <Icon id={l.ticked ? 'check' : 'plus'} />
                </button>
                <span className={s.slot}>{label}</span>
                {editing === l.key ? (
                  <textarea
                    className={cx('ip-input', s.edit)}
                    autoFocus
                    aria-label={C.editLine}
                    defaultValue={own ? (edits.own?.[ownIndex] ?? '') : l.text}
                    placeholder={own ? C.addLinePlaceholder : undefined}
                    rows={2}
                    onBlur={(e) => {
                      if (own) setOwn(ownIndex, e.target.value)
                      else if (e.target.value.trim() && e.target.value.trim() !== l.full) setText(l.key, e.target.value)
                      setEditing(null)
                    }}
                  />
                ) : (
                  <button type="button" className={s.text} title={C.editLine} onClick={() => setEditing(l.key)}>{l.text}</button>
                )}
                <span className={s.tags}>
                  {l.slot !== 'zusatz' && <span className={cx(s.tag, s[l.change])}>{C.tags[l.change]}</span>}
                  {l.tag === 'schaetzung' && <span className={cx(s.tag, s.est)} title={C.tagSchaetzungTitle}>{C.tagSchaetzung}</span>}
                  {l.tag === 'register' && <span className={cx(s.tag, s.est)} title={C.tagRegisterTitle}>{C.tagRegister}</span>}
                </span>
                {askT0 === l.key && (
                  <span className={s.ask} role="alert">
                    {C.dropT0}
                    <Button variant="quiet" onClick={() => { setAskT0(null); setTicked(l.key, false) }}>{C.dropT0Yes}</Button>
                  </span>
                )}
              </li>
            )
          })}
          {(edits.own ?? []).map((t, i) => (rows.some((r) => r.l.key === `own.${i}`) ? null : (
            <li key={`own.${i}`} className={s.row}>
              <span className={s.tick} aria-hidden><Icon id="pen" /></span>
              <span className={s.slot}>{i === 0 ? C.slots.zusatz : ''}</span>
              <textarea className={cx('ip-input', s.edit)} aria-label={C.addLine} placeholder={C.addLinePlaceholder} rows={2}
                autoFocus={editing === `own.${i}`}
                defaultValue={t} onBlur={(e) => { setOwn(i, e.target.value); setEditing(null) }} />
              <span className={s.tags} />
            </li>
          )))}
          <li className={cx(s.row, s.nextRow)}>
            <span className={s.tick} aria-hidden><Icon id="clock" /></span>
            <span className={s.slot}>{C.slots.naechste}</span>
            <span className={s.nextBody}>
              <span className={s.nextText}>{next.text}</span>
              <Segmented<string>
                ariaLabel={C.rhythm}
                value={choiceKey(choice)}
                onChange={(k) => setChoice(k === 'handover' ? { kind: 'handover' } : k === 'none' ? { kind: 'none' } : { kind: 'every', min: Number(k.slice(1)) })}
                options={[
                  ...appConfig.lagemeldung.rhythmChoices.map((m) => ({ value: `m${m}`, label: fillTemplate(C.rhythmEvery, { m }) })),
                  { value: 'handover', label: C.rhythmHandover },
                  { value: 'none', label: C.rhythmOff },
                ]}
              />
              {draft.windDown && <span className={s.windDown}>{C.rhythmWindDown}</span>}
            </span>
          </li>
        </ul>
        <div className={s.under}>
          <Button variant="quiet" icon={<Icon id="plus" />} onClick={addOwn}>{C.addLine}</Button>
        </div>

        <section className={s.hidden}>
          <button type="button" className={s.hiddenHead} aria-expanded={hiddenOpen} onClick={() => setHiddenOpen((v) => !v)}>
            <Icon id={hiddenOpen ? 'chevron-down' : 'chevron'} />
            <b>{hidden.length ? fillTemplate(C.hidden, { n: hidden.length }) : C.hiddenNone}</b>
            {Object.entries(counts).map(([r, n]) => (
              <span key={r} className={s.hiddenCount}>{n} {fillTemplate(C.hiddenReasons[r] ?? r, { t: anchorAt, by: '', slot: '' }).replace(/\s*«»\s*/, '')}</span>
            ))}
          </button>
          {hiddenOpen && (
            <ul className={s.hiddenList}>
              {hidden.map((h) => (
                <li key={h.key} className={s.hiddenItem}>
                  <span className={s.hiddenText}>{h.text}</span>
                  <span className={s.hiddenWhy}>{fillTemplate(C.hiddenReasons[h.reason] ?? '', { t: h.detail ?? anchorAt, by: h.detail ?? '' })}</span>
                  {h.line && (
                    <Button variant="quiet" icon={<Icon id="plus" />} aria-label={fillTemplate(C.hiddenAddAria, { text: h.text })} onClick={() => addHidden(h)}>
                      {C.hiddenAdd}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className={s.source}>{C.source}</p>
      </Sheet>
      {radio && <RadioView text={text} at={at} onBack={() => setRadio(false)} onSend={send} />}
    </>
  )
}

/** «Funkansicht» — the same text in big type, full screen, the screen kept awake, for reading
 *  out at the radio. No text-to-speech: the EL speaks, the radio is theirs. */
function RadioView({ text, at, onBack, onSend }: { text: string; at: string; onBack: () => void; onSend: () => void }) {
  const C = appConfig.copy.lagemeldung
  useWakeLock(true)
  const backRef = useRef<HTMLButtonElement>(null)
  return (
    <Overlay open onClose={onBack} className={s.radio} ariaLabel={`${C.radio} · ${C.title} ${at}`} initialFocus={backRef} swipeToClose={false}>
      <div className={s.radioHead}>
        <Icon id="radio" /><b>{C.title} {at}</b>
      </div>
      <div className={s.radioText}>
        {text.split('\n').map((line, i) => {
          const cut = line.indexOf(': ')
          return cut > 0 && cut < 14
            ? <p key={i}><b>{line.slice(0, cut + 1)}</b>{line.slice(cut + 1)}</p>
            : <p key={i}>{line}</p>
        })}
      </div>
      <div className={s.radioFoot}>
        <Button ref={backRef} onClick={onBack}>{C.radioClose}</Button>
        <Button variant="primary" size="lg" icon={<Icon id="check" />} onClick={onSend}>{C.send}</Button>
      </div>
    </Overlay>
  )
}
