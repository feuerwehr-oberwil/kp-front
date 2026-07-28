import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { confirmDialog, toast } from './ui'
import type { Person, Shift, ShiftBand } from '../types'
import { bandCellState, shiftInBand } from './shifts'

interface BandActionsDeps {
  bands: ShiftBand[]
  setBands: Dispatch<SetStateAction<ShiftBand[]>>
  shifts: Shift[]
  setShifts: Dispatch<SetStateAction<Shift[]>>
}

/**
 * Schichtbänder — the columns of the Schichten grid, and the cell taps that fill them.
 *
 * The one rule everything here follows: **membership is stored, never derived.** A shift belongs to
 * a band because it carries that band's `bandId`, not because its clock happens to match. So:
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
   * A cell whose shift has DRIFTED off the band's times (drawn hatched, showing its real hours)
   * cycles verfügbar ⇄ eingeteilt only. Dropping it back to leer would delete a stretch somebody
   * dragged by hand on the Zeitplan axis, and the grid must not be a place where that happens on
   * the third tap of a fifty-tap sweep.
   */
  const cycleCell = (band: ShiftBand, person: Person) => {
    const cur = shiftInBand(shifts, person.id, band.id)
    if (!cur) {
      setShifts((list) => [...list, {
        id: `sh${Date.now()}`, personId: person.id, bandId: band.id, from: band.from, to: band.to,
      }])
      return
    }
    const state = bandCellState(cur, band)
    if (!cur.confirmed) {
      setShifts((list) => list.map((s) => (s.id === cur.id ? { ...s, confirmed: true } : s)))
      return
    }
    if (state === 'deviating') {
      setShifts((list) => list.map((s) => (s.id === cur.id ? { ...s, confirmed: false } : s)))
      return
    }
    setShifts((list) => list.filter((s) => s.id !== cur.id))
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

  return { addBand, renameBand, setBandTimes, askAndSetBandTimes, bandFollowerCount, removeBand, cycleCell }
}
