// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { Map as MlMap } from 'maplibre-gl'
import { GeorefMapLoupe, loupeCrop } from './GeorefMapLayer'
import s from './GeorefMode.module.css'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('map magnifier target', () => {
  it.each([126, 118, 190])('centres the aimed landmark in a %ipx content box', (side) => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const aim = { lng: 7.5617, lat: 47.4967 }
    const map = {
      getStyle: () => ({ sources: {}, layers: [] }),
      getCenter: () => aim, getZoom: () => 18, getBearing: () => 0,
    } as unknown as MlMap
    const { container } = render(<GeorefMapLoupe map={map}
      layers={[{ id: 'base', group: 'base', label: 'Map', icon: 'map', base: true, visible: true, tiles: ['https://t/{z}/{x}/{y}.png'], maxzoom: 20 }]}
      isVisible={() => true} night={false} atRef={{ current: aim }} />)
    const plane = container.querySelector<HTMLElement>(`.${s.plane}`)!
    const crop = loupeCrop('https://t/{z}/{x}/{y}.png', aim.lng, aim.lat, 20, 1, 196)
    // Replay the actual element's CSS transforms on the target's tile-relative pixel.
    // The admin overrides the outer diameter to 132px (126px after its border),
    // while the old transform hard-coded the desktop diameter's 98px centre.
    let x = -crop.dx, y = -crop.dy
    const transforms = [...plane.style.transform.matchAll(/(translate|rotate|scale)\(([^)]+)\)/g)].reverse()
    for (const [, name, args] of transforms) {
      const values = args.split(',').map(parseFloat)
      if (name === 'translate') { x += values[0]; y += values[1] ?? 0 }
      if (name === 'scale') { x *= values[0]; y *= values[0] }
      if (name === 'rotate') {
        const a = values[0] * Math.PI / 180
        ;[x, y] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]
      }
    }
    const offset = (value: string) => value.endsWith('%') ? parseFloat(value) * side / 100 : parseFloat(value) || 0
    expect(x + offset(plane.style.left)).toBeCloseTo(side / 2)
    expect(y + offset(plane.style.top)).toBeCloseTo(side / 2)
  })
})
