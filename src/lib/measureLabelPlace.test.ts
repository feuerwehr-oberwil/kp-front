import { describe, expect, it } from 'vitest'
import { LABEL_ABOVE, LABEL_CLEAR_PX, measureLabelPlacement } from './measureLabelPlace'
import type { LngLat } from '../types'

const at = (lng: number, lat: number): LngLat => [lng, lat]
const O = at(7.57, 47.52)

describe('measureLabelPlacement', () => {
  it('keeps the old place above the node on a west→east segment', () => {
    // what every label did before round 7 — an east-west run must not move
    expect(measureLabelPlacement(O, at(7.5702, 47.52), 0)).toEqual({ anchor: 'bottom', offset: [0, -LABEL_CLEAR_PX] })
  })

  it('steps a stacked chain of nodes aside instead of under the handles', () => {
    // owner, review round 7 (s14): nodes one under the other, the numbers hidden by the circles.
    // Travelling down the screen, the segment's left is the screen's right → the chip stands
    // beside the node with its LEFT edge on it, so its width runs away from the path.
    const p = measureLabelPlacement(O, at(7.57, 47.5198), 0)
    expect(p).toEqual({ anchor: 'left', offset: [LABEL_CLEAR_PX, 0] })
  })

  it('stays on the segment’s left when the path turns', () => {
    expect(measureLabelPlacement(O, at(7.57, 47.5202), 0)).toEqual({ anchor: 'right', offset: [-LABEL_CLEAR_PX, 0] })
    expect(measureLabelPlacement(O, at(7.5698, 47.52), 0)).toEqual({ anchor: 'top', offset: [0, LABEL_CLEAR_PX] })
  })

  it('turns with the map: the same segment under a rotated bearing', () => {
    // bearing 90° puts east up the screen, so the eastward run now travels upwards and its
    // left-hand side is the screen's left
    expect(measureLabelPlacement(O, at(7.5702, 47.52), 90)).toEqual({ anchor: 'right', offset: [-LABEL_CLEAR_PX, 0] })
    expect(measureLabelPlacement(O, at(7.5702, 47.52), 180)).toEqual({ anchor: 'top', offset: [0, LABEL_CLEAR_PX] })
  })

  it('holds the clearance on a diagonal and on a very short segment', () => {
    const d = measureLabelPlacement(O, at(7.5702, 47.5198), 0)
    expect(Math.hypot(...d.offset)).toBeCloseTo(LABEL_CLEAR_PX, 0)
    // a 20 cm hop still gets a full side-step: the clearance is the handle's, not the segment's
    const tiny = measureLabelPlacement(O, at(7.57, 47.519998), 0)
    expect(tiny).toEqual({ anchor: 'left', offset: [LABEL_CLEAR_PX, 0] })
  })

  it('falls back to straight above when the two nodes sit on one spot', () => {
    expect(measureLabelPlacement(O, O, 0)).toEqual(LABEL_ABOVE)
  })
})
