import { appConfig } from '../config/appConfig'
import { formatTime } from '../lib/format'
import { alarmBar, isAlarmValue, readingRows, symbolReading } from '../lib/symbols'
import { ReadingPill } from '../lib/symbolRender'
import type { SymbolProps } from '../types'

// The Messpunkt's two additions to the symbol panel (owner picks 27.10.2026): the input box itself
// is the visualisation – a colour bar under each measured field – and the history sits under all
// fields as one list. No numbers on the bar: above the calm zone it is Atemschutz either way.

/** Calm / red bar under one measured field, with a tick where the value as typed sits. */
export function ReadingBar({ symbol, fieldKey, value }: { symbol?: string; fieldKey: string; value: string }) {
  const bar = alarmBar(symbol, fieldKey, value)
  if (!bar) return null
  return (
    <span className={`reading-bar${bar.at == null ? ' empty' : ''}`} aria-hidden>
      {bar.zones.map((z) => (
        <i key={z.from} className={z.alarm ? 'alarm' : undefined} style={{ left: `${z.from * 100}%`, width: `${(z.to - z.from) * 100}%` }} />
      ))}
      {bar.at != null && <b style={{ left: `${bar.at * 100}%` }} />}
    </span>
  )
}

/** The readings, newest first, one row per radio report: time, then every gas, red where it is
 *  over its limit. Nothing before the first reading. */
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
              <span key={k} className={isAlarmValue(entity.symbol, k, v) ? 'alarm' : undefined}>{k} {v}</span>
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
 * has a Messpunkt; it lives inside the board, so it pans and zooms with the storeys. Alarm rows
 * first; a tap selects the point.
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
  return (
    <div className="wb-readings" onPointerDown={(e) => e.stopPropagation()}>
      {floorsTTB.map((f, idx) => {
        const here = points.filter((p) => (p.floor ?? 0) === f)
        if (!here.length) return null
        const alarmFirst = [...here].sort((a, b) => Number(symbolAlarm(b)) - Number(symbolAlarm(a)))
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

const symbolAlarm = (p: SymbolProps) => !!symbolReading(p)?.alarm
