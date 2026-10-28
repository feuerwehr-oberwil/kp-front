import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate, formatLocale, formatTime } from '../lib/format'
import { useMinuteClock } from '../lib/minuteClock'
import { alarmBar, compareReadings, readingLevel, readingRows, readingScale, symbolReading } from '../lib/symbols'
import { ReadingPill } from '../lib/symbolRender'
import type { SymbolProps } from '../types'
import { InfoToggle } from './InfoToggle'

// The Messpunkt's additions to the symbol panel (owner picks 27.10.2026): the input box itself is
// the visualisation – a colour bar under each measured field – and the history sits under all
// fields as one list. No numbers on the bar, only the stages: calm, Voralarm (amber), Hauptalarm
// (red); the numbers behind the stages are one ⓘ away (ReadingInfo, 28.10.2026).

/** Calm / amber / red bar under one measured field, with a tick where the value as typed sits. */
export function ReadingBar({ symbol, fieldKey, value }: { symbol?: string; fieldKey: string; value: string }) {
  const bar = alarmBar(symbol, fieldKey, value)
  if (!bar) return null
  return (
    <span className={`reading-bar${bar.at == null ? ' empty' : ''}`} aria-hidden>
      {bar.zones.map((z) => (
        <i key={z.from} className={z.level === 'ok' ? undefined : z.level} style={{ left: `${z.from * 100}%`, width: `${(z.to - z.from) * 100}%` }} />
      ))}
      {bar.at != null && <b style={{ left: `${bar.at * 100}%` }} />}
    </span>
  )
}

/** One stage's limit as said – «ab 60», «unter 17 oder ab 23». */
function limitText(lim: { atLeast?: number; below?: number }): string {
  const C = appConfig.copy.contextPanel
  const num = (n: number) => n.toLocaleString(formatLocale())
  return [lim.below != null && fillTemplate(C.readingBelow, { n: num(lim.below) }), lim.atLeast != null && fillTemplate(C.readingAtLeast, { n: num(lim.atLeast) })]
    .filter(Boolean).join(` ${C.readingOr} `)
}

/**
 * «What do the values mean?» (owner, sweep 28.10.2026 #2b): the shared ⓘ under the measured fields,
 * folding out each gas with its unit and its A1/A2 limits in the stage colours, what amber and red
 * mean and when a reading counts as old. Built from the preset's `alarm` (readingScale), so a
 * station override reads right. Limits and colours only – what to DO at a stage is station
 * doctrine, which the app does not have. Nothing for a symbol without limits.
 */
export function ReadingInfo({ symbol }: { symbol?: string }) {
  const [open, setOpen] = useState(false)
  const scale = readingScale(symbol)
  if (!scale) return null
  const C = appConfig.copy.contextPanel
  return (
    <div className="ctx-section reading-info">
      <div className="reading-info-head">
        <span className="ctx-section-label">{C.readingInfo}</span>
        <InfoToggle open={open} onToggle={() => setOpen((v) => !v)} label={C.readingInfoLabel} />
      </div>
      {open && (
        <>
          {/* four columns – gas, unit, A1, A2 – the stage codes heading their own column, so a long
              O₂ limit («unter 17 oder ab 23») wraps inside its cell instead of under the row */}
          <ul>
            <li className="head" aria-hidden><span /><span /><span className="a1">A1</span><span className="a2">A2</span></li>
            {scale.gases.map((g) => (
              <li key={g.key}>
                <b>{g.key}</b>
                <span className="unit">{C.readingUnits[g.key] ?? ''}</span>
                <span className="a1">{g.a1 ? limitText(g.a1) : '–'}</span>
                <span className="a2">{g.a2 ? limitText(g.a2) : '–'}</span>
              </li>
            ))}
          </ul>
          <p>{C.readingInfoLevels}</p>
          {scale.staleMin != null && <p>{fillTemplate(C.readingInfoStale, { min: scale.staleMin })}</p>}
        </>
      )}
    </div>
  )
}

/** The readings, newest first, one row per radio report: time, then every gas, red where it is
 *  amber/red where it reached A1/A2. Nothing before the first reading. */
export function ReadingHistory({ entity }: { entity: SymbolProps }) {
  const rows = readingRows(entity)
  if (!rows.length) return null
  return (
    <div className="ctx-section reading-history">
      <span className="ctx-section-label">{appConfig.copy.contextPanel.readingHistory}</span>
      <ol>
        {rows.map((r) => (
          <li key={r.t}>
            <time>{formatTime(new Date(r.t))}</time>
            {Object.entries(r.v).map(([k, v]) => (
              <span key={k} className={readingLevel(entity.symbol, k, v) === 'ok' ? undefined : readingLevel(entity.symbol, k, v)}>{k} {v}</span>
            ))}
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * The Gebäude's Messungen (owner pick W2, 27.10.2026): every Messpunkt of the stack listed beside
 * the storey it is on, each storey's rows at that storey's own height – where it is worst reads
 * straight across from the plan, and a number per storey is never needed. Open whenever the stack
 * has a Messpunkt; it lives inside the board, so it pans and zooms with the storeys. Each storey's
 * rows in the one Messpunkt order (compareReadings), worst first; a tap selects the point.
 */
export function StackReadings({ points, floorsTTB, storeyName, boardH, onPick }: {
  /** the measured annos, one per storey they are on (stackFloors · stackInstances) */
  points: (SymbolProps & { id: string; floor?: number })[]
  floorsTTB: number[]
  storeyName: (f: number) => string
  boardH: number
  onPick: (id: string) => void
}) {
  const N = floorsTTB.length || 1
  const room = (p: SymbolProps) => p.fields?.Raum?.trim() || p.label || ''
  // the minute clock the pills age by: a reading turning stale re-sorts its storey
  const now = useMinuteClock()
  return (
    <div className="wb-readings" onPointerDown={(e) => e.stopPropagation()}>
      {floorsTTB.map((f, idx) => {
        const here = points.filter((p) => (p.floor ?? 0) === f)
        if (!here.length) return null
        const alarmFirst = here.map((p) => ({ p, r: symbolReading(p, now) }))
          .sort((a, b) => compareReadings(a.r, b.r)).map(({ p }) => p)
        return (
          <section key={f} style={{ top: (idx / N) * boardH, maxHeight: boardH / N }}>
            <h4>{storeyName(f)}</h4>
            {alarmFirst.map((p) => (
              <button key={p.id} type="button" onClick={() => onPick(p.id)}>
                <span>{room(p)}</span>
                <ReadingPill props={p} inline />
              </button>
            ))}
          </section>
        )
      })}
    </div>
  )
}

