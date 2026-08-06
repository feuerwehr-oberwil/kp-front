import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { confirmDialog, toast } from './ui'
import type { Person, Shift, ShiftBand } from '../types'
import { bandAssignWindow, bandCell, mergePersonShifts, splitShiftAtBand } from './shifts'

interface BandActionsDeps {
  bands: ShiftBand[]
  setBands: Dispatch<SetStateAction<ShiftBand[]>>
  shifts: Shift[]
  setShifts: Dispatch<SetStateAction<Shift[]>>
}

/**
 * Schichtbänder — the columns of the Schichten grid, and the cell taps that fill them.
 *
 * The one rule everything here follows: **assignment is stored, never derived** (availability is
 * the other way round — see `bandCell`). Somebody is IN a band because a person put them there,
 * not because their clock happened to match. So:
 *
 *  - creating a band writes ONE row and touches no shift, not even for people who already hold
 *    exactly those hours freihändig (see types.ShiftBand for why that is a sync argument too);
 *  - deleting a band strips `bandId` from its shifts and leaves them standing as freihändige —
 *    cascading the delete would be the only path on which real planning silently disappears;
 *  - moving a band ASKS whether the assigned people should come along. There is no quiet coupling
 *    in either direction.
 *
 * Toasts follow `useShiftActions`: what a slip of the finger can trigger on its own gets the house
 * confirm-with-undo. Deleting a band does. A cell tap does NOT — it is the same deliberate cycle as
 * the Anwesenheit row, a second tap walks it back, and fifty of them in a row would be a wall of
 * toasts over the very grid you are working in.
 */
export function useBandActions({ bands, setBands, shifts, setShifts }: BandActionsDeps) {
  const S = () => appConfig.copy.schichten

  /** A new column. One row, no shifts — every cell starts empty. */
  const addBand = (label: string, from: string, to: string): ShiftBand => {
    const band: ShiftBand = { id: `bd${Date.now()}`, label, from, to }
    setBands((cur) => [...cur, band])
    return band
  }

  const renameBand = (id: string, label: string) => {
    setBands((cur) => cur.map((b) => (b.id === id ? { ...b, label } : b)))
  }

  /**
   * New times for a band — and the question that goes with them.
   *
   * `moveShifts` shifts every assigned person by the same delta the band moved, so «Früh runs an
   * hour later» stays one decision instead of N. Only the people who were ON the band's old times
   * move: somebody hatched at 09–14 inside a 07–12 band said something specific about themselves,
   * and dragging them along would overwrite it with a time they never agreed to.
   */
  const setBandTimes = (id: string, from: string, to: string, moveShifts: boolean) => {
    const prev = bands.find((b) => b.id === id)
    setBands((cur) => cur.map((b) => (b.id === id ? { ...b, from, to } : b)))
    if (!prev || !moveShifts) return
    const dFrom = Date.parse(from) - Date.parse(prev.from)
    const dTo = Date.parse(to) - Date.parse(prev.to)
    if (!Number.isFinite(dFrom) || !Number.isFinite(dTo)) return
    setShifts((cur) => cur.map((s) => {
      if (s.bandId !== id) return s
      // only the ones that still sat exactly on the old window — see the note above
      if (s.from !== prev.from || s.to !== prev.to) return s
      return { ...s, from, to }
    }))
  }

  /** How many shifts would be dragged along by a move — the number the question names. */
  const bandFollowerCount = (id: string, from: string, to: string): number =>
    shifts.filter((s) => s.bandId === id && s.from === from && s.to === to).length

  /**
   * Drop a column. Its shifts STAY, as freihändige — the planning survives, only the column that
   * grouped it goes. Undo restores the band and re-attaches exactly the shifts that hung on it.
   */
  const removeBand = (id: string) => {
    const prev = bands.find((b) => b.id === id)
    if (!prev) return
    const attached = shifts.filter((s) => s.bandId === id).map((s) => s.id)
    setBands((cur) => cur.filter((b) => b.id !== id))
    setShifts((cur) => cur.map((s) => {
      if (s.bandId !== id) return s
      const { bandId: _drop, ...rest } = s
      return rest
    }))
    toast(fillTemplate(S().removedBand, { label: prev.label }), {
      icon: 'undo',
      action: {
        label: appConfig.copy.undo,
        onClick: () => {
          setBands((cur) => (cur.some((b) => b.id === id) ? cur : [...cur, prev]))
          const back = new Set(attached)
          setShifts((cur) => cur.map((s) => (back.has(s.id) ? { ...s, bandId: id } : s)))
        },
      },
    })
  }

  /**
   * One cell tap: leer → verfügbar → eingeteilt → leer, the same direction as the Anwesenheit row.
   *
   * Two cells never reach «leer», and both for the same reason — there is real planning behind
   * them that this grid must not be able to delete:
   *
   *  - a cell whose MEMBER shift has drifted off the band's times (hatched, showing its real
   *    hours) cycles verfügbar ⇄ eingeteilt. Dropping it would delete a stretch somebody dragged
   *    by hand on the axis, on the third tap of a fifty-tap sweep;
   *  - a DERIVED cell — the person is available because a freihändige offer of theirs covers the
   *    window — falls back to that offer instead. Un-assigning somebody does not withdraw what
   *    they said they could do.
   *
   * Confirming a derived cell writes a NEW member shift over the part of the band they actually
   * offered (`bandAssignWindow`) and leaves their own offer alone. On the Zeitplan that reads as
   * the everyday pair the axis was built for: a wide hollow offer with a solid assignment inside.
   */
  const cycleCell = (band: ShiftBand, person: Person) => {
    const cell = bandCell(shifts, person.id, band)
    if (cell.state === 'empty') {
      setShifts((list) => [...list, {
        id: `sh${Date.now()}`, personId: person.id, bandId: band.id, from: band.from, to: band.to,
      }])
      return
    }
    if (cell.derived) {
      const src = cell.shift!
      // Already «geplant» across this window from a shift of their own — they are on it, they are
      // simply not filed under this column. Writing a SECOND assignment for the same hours would
      // book them twice and light up the conflict notice for something nobody did wrong. So the
      // tap continues the cycle on the shift that is actually there: geplant → verfügbar, exactly
      // as tapping that bar on the Zeitplan does. It is one shift with one state, so a column it
      // also covers moves with it — which is the truth about that shift, not a side effect.
      if (src.confirmed) {
        setShifts((list) => list.map((s) => (s.id === src.id ? { ...s, confirmed: false } : s)))
        return
      }
      const win = bandAssignWindow(cell, band)
      setShifts((list) => [...list, {
        id: `sh${Date.now()}`, personId: person.id, bandId: band.id, ...win, confirmed: true,
      }])
      return
    }
    const cur = cell.shift!
    if (!cur.confirmed) {
      setShifts((list) => list.map((s) => (s.id === cur.id ? { ...s, confirmed: true } : s)))
      return
    }
    if (cell.state === 'deviating') {
      setShifts((list) => list.map((s) => (s.id === cur.id ? { ...s, confirmed: false } : s)))
      return
    }
    setShifts((list) => list.filter((s) => s.id !== cur.id))
  }

  /**
   * Settle a window that holds BOTH states for one person — «alles auf verfügbar» / «alles auf
   * geplant».
   *
   * A cycle cannot answer this: with an offer and an assignment overlapping the same watch, each
   * tap would flip one of them and neither state would ever hold for the whole window. So the
   * surface asks, and this applies the answer to every shift of theirs that reaches into the band.
   *
   * The change stops at the column that asked for it: a stretch running past the watch is CUT at
   * its edges and only the middle piece changes, so «geplant 10:00–20:00» set to verfügbar inside
   * a 12:00–17:00 watch stays geplant either side of it. Turning one stretch somebody drew into
   * three is not a thing to discover afterwards, so the sheet lists the pieces first
   * (`bandSplitPlan`), and this only ever runs after that press.
   *
   * Afterwards neighbours that now say the same thing grow back together — otherwise flipping a
   * cell back and forth would shred one stretch into more pieces every time. That also settles
   * what «alles auf geplant» used to have to solve by hand: two confirmed stretches of one person
   * at the same time is precisely what `conflictingShiftIds` calls a double booking, and an answer
   * must not manufacture the fault it was asked to resolve.
   */
  const setCellState = (band: ShiftBand, person: Person, next: 'available' | 'confirmed') => {
    const bandFrom = Date.parse(band.from)
    const bandTo = Date.parse(band.to)
    const touches = (s: Shift) => {
      const f = Date.parse(s.from)
      const t2 = Date.parse(s.to)
      return s.personId === person.id && Number.isFinite(f) && Number.isFinite(t2)
        && Math.min(t2, bandTo) > Math.max(f, bandFrom)
    }
    const stamp = Date.now()
    setShifts((list) => {
      const out: Shift[] = []
      for (const s of list) {
        if (!touches(s)) { out.push(s); continue }
        // wholly inside the window → nothing to cut. Crossing an edge → cut there, so the change
        // stops at the column that asked for it. The sheet showed these pieces before the press.
        out.push(...splitShiftAtBand(s, band, next === 'confirmed', (n) => `sh${stamp}${n}`))
      }
      return mergePersonShifts(out, person.id)
    })
  }

  /**
   * Put a cell into a NAMED state — what the right-click menu calls, as opposed to the tap that
   * advances to whatever is next.
   *
   * Delegates to `setCellState` for everything that already exists, so all of its care about
   * cutting at the band edges and merging afterwards still applies. The one thing it adds is the
   * empty cell, which `setCellState` cannot answer at all: it only rewrites shifts that already
   * overlap the window, and an empty cell has none — so «verfügbar» on an empty cell would have
   * silently done nothing.
   *
   * Clearing a cell is deliberately NOT offered here. `cycleCell` earns its way back to empty
   * through protections this path would have to duplicate: a derived cell falls back to the
   * person's own freihändige offer rather than withdrawing it, and a deviating cell holds
   * hand-drawn planning that is never removed by a tap. A menu entry that bypassed those would
   * delete work somebody did on the axis.
   */
  const putCellState = (band: ShiftBand, person: Person, next: 'available' | 'confirmed') => {
    const cell = bandCell(shifts, person.id, band)
    if (cell.state === 'empty') {
      setShifts((list) => [...list, {
        id: `sh${Date.now()}`, personId: person.id, bandId: band.id,
        from: band.from, to: band.to, confirmed: next === 'confirmed',
      }])
      return
    }
    setCellState(band, person, next)
  }

  /** The «Zeiten mitziehen?» question, asked only when a move would actually drag somebody. */
  const askAndSetBandTimes = async (id: string, from: string, to: string) => {
    const prev = bands.find((b) => b.id === id)
    if (!prev) return
    const unchanged = prev.from === from && prev.to === to
    const n = unchanged ? 0 : bandFollowerCount(id, prev.from, prev.to)
    if (!n) { setBandTimes(id, from, to, false); return }
    const move = await confirmDialog({
      title: S().moveTitle,
      message: fillTemplate(S().moveMsg, { n }),
      confirmLabel: S().moveYes,
      cancelLabel: S().moveNo,
    })
    setBandTimes(id, from, to, move)
  }

  return { addBand, renameBand, setBandTimes, askAndSetBandTimes, bandFollowerCount, removeBand, cycleCell, setCellState, putCellState }
}
