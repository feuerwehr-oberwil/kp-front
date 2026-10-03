// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import snailSvg from '../../public/firefighter-snail-loader.svg?raw'
import { LoadingStatus, ShellLoader } from './ShellLoader'

afterEach(cleanup)

describe('Shell trail loading', () => {
  it('uses the mascot spiral without exposing duplicate artwork or ids to assistive technology', () => {
    const mascot = new DOMParser().parseFromString(snailSvg, 'image/svg+xml')
    const spiral = mascot.querySelector('#fs-shell-trail')
    expect(spiral?.closest('.fs-shell')).toBeTruthy()
    const { container } = render(<><ShellLoader /><ShellLoader size="surface" /></>)
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect([...svg.querySelectorAll('path')].every(path => path.getAttribute('d') === spiral?.getAttribute('d'))).toBe(true)
    }
    expect(container.querySelector('[id]')).toBeNull()
    expect(container.querySelector('img, image, use')).toBeNull()
  })

  it('announces the existing loading copy and leaves the parent action name intact', () => {
    render(<><LoadingStatus>Verlauf wird geladen …</LoadingStatus><button aria-busy disabled><ShellLoader />PDF</button></>)
    expect(screen.getByRole('status').textContent).toBe('Verlauf wird geladen …')
    expect(screen.getByRole('button', { name: 'PDF' }).getAttribute('aria-busy')).toBe('true')
  })
})
