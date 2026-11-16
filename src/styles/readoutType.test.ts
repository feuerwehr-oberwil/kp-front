// The Rapport's read values stand at the read-out step, --fs-2 (14px): owner 16.11.2026 found the
// «Aus den Einsatzdaten» values «just a bit too big» at 16. 16 is a FIELD's size (iOS zooms into
// anything smaller), so a read-out that copies the fields drifts back up – this pins it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = (file: string) => readFileSync(`${process.cwd()}/src/styles/${file}`, 'utf8')
/** the declarations of the rule whose selector list starts with `selector` */
const rule = (file: string, selector: string) => {
  const text = css(file)
  const at = text.indexOf(`\n${selector}`)
  expect(at, selector).toBeGreaterThan(-1)
  return text.slice(text.indexOf('{', at), text.indexOf('}', at))
}

describe('Rapport read-outs', () => {
  it.each([
    ['17-rapport.css', '.report-meta-readout dd, .rp-readout'],
    ['17-rapport.css', '.rz-clock, .rz-count > b, .rz-derived b'],
    ['13-incident.css', '.rp-sign-name'],
  ])('%s · %s reads at --fs-2', (file, selector) => {
    const decls = rule(file, selector)
    expect(decls).toContain('var(--fs-2)')
    expect(decls).not.toContain('var(--fs-3)')
  })
})
